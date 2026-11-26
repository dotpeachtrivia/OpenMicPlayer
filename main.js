'use strict';

const { app, BrowserWindow, ipcMain, dialog, screen, safeStorage, powerMonitor } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { scanLibrary } = require('./lib/indexer');
const { makeStore } = require('./lib/store');

// The playback window has no user gesture, so let media autoplay.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Tests point the app at a throwaway data folder (prefs, session).
if (process.env.OMP_USER_DATA) app.setPath('userData', process.env.OMP_USER_DATA);

let controlWin = null;
let playbackWin = null;
let playbackReady = false;
let pendingCmds = [];
let store = null;

// The 43k-entry lookup table lives here, in the main process. The control
// panel asks for matches on just the codes it holds (a few dozen rows)
// instead of receiving a multi-megabyte copy of the whole index over IPC.
let libraryIndex = null;

// The link to player-pool lives here, not in a renderer: it survives a
// control-window reload, and the POOL_KEY never reaches a web page.
let poolLink = null;
let poolState = null; // the last karaoke line the pool sent
let poolStatus = { status: 'off', detail: '' };
let sessionKey = ''; // the key, when the OS offers no safeStorage

function preloadPath() {
  return path.join(__dirname, 'preload.js');
}

function secondDisplay() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().find((d) => d.id !== primary.id) || null;
}

function placePlayback(win) {
  const ext = secondDisplay();
  if (ext) {
    win.setFullScreen(false);
    win.setBounds(ext.bounds);
    win.setFullScreen(true);
  } else {
    // Laptop prep: one display. Keep it a movable window you can park
    // in a corner or hide while scrubbing.
    win.setFullScreen(false);
    win.setBounds({ width: 960, height: 540, x: 80, y: 80 });
  }
}

function ensurePlaybackWindow() {
  if (playbackWin && !playbackWin.isDestroyed()) return playbackWin;

  playbackReady = false;
  playbackWin = new BrowserWindow({
    show: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: 'Playback',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      // Timers in this window drive the end-of-song fade. They must keep
      // firing at full rate even when the window is hidden or occluded
      // (single-monitor prep with playback tucked away), or a fade in a
      // hidden window would never report completion.
      backgroundThrottling: false,
    },
  });

  playbackWin.loadFile(path.join(__dirname, 'renderer', 'playback.html'));

  playbackWin.webContents.on('did-finish-load', () => {
    playbackReady = true;
    placePlayback(playbackWin);
    playbackWin.show();
    for (const cmd of pendingCmds) playbackWin.webContents.send('cmd', cmd);
    pendingCmds = [];
    sendToControl({ type: 'ready' });
  });

  playbackWin.on('closed', () => {
    playbackWin = null;
    playbackReady = false;
    sendToControl({ type: 'playback-window-closed' });
  });

  return playbackWin;
}

function sendToPlayback(cmd) {
  const win = ensurePlaybackWindow();

  // A 'play' is never queued behind a window that is still loading. If it
  // were, the control panel's resync after the reload would race the
  // queued play and clobber it mid-start. Failing loudly is deterministic:
  // the operator presses Play once more and it works.
  if (cmd.type === 'play' && !playbackReady) {
    sendToControl({ type: 'error', message: 'The playback window was still reopening.' });
    return;
  }

  if (playbackReady) {
    win.webContents.send('cmd', cmd);
  } else {
    pendingCmds.push(cmd);
  }
}

function sendToControl(evt) {
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.webContents.send('playback-event', evt);
  }
}

function toFileUrl(p) {
  return p ? pathToFileURL(p).href : '';
}

function createWindows() {
  controlWin = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1020,
    minHeight: 640,
    title: 'Open-Mic Karaoke — Control Panel',
    backgroundColor: '#14161a',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      // Keeps the debounced session save and live countdown on time while the
      // panel is minimized during a long song.
      backgroundThrottling: false,
    },
  });
  controlWin.loadFile(path.join(__dirname, 'renderer', 'control.html'));
  // A reload of the control panel starts it from scratch, which sends the
  // playback window to standby and cuts a playing song with no fade. Ctrl+R
  // or F5 is an easy slip on a dark stage, so they do nothing here.
  controlWin.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '').toLowerCase();
    if (key === 'f5' || ((input.control || input.meta) && key === 'r')) event.preventDefault();
  });
  controlWin.on('closed', () => {
    controlWin = null;
    if (playbackWin && !playbackWin.isDestroyed()) playbackWin.close();
  });

  ensurePlaybackWindow();
}

app.whenReady().then(() => {
  store = makeStore(app.getPath('userData'));
  createWindows();
  startPoolLink();
  // After sleep the socket is likely dead and the backoff timer stale.
  powerMonitor.on('resume', () => {
    if (poolLink) poolLink.reconnectNow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  if (poolLink) poolLink.close();
});

// ---------- IPC: dialogs ----------

ipcMain.handle('pick-folder', async () => {
  const res = await dialog.showOpenDialog(controlWin, { properties: ['openDirectory'] });
  return res.canceled ? '' : res.filePaths[0];
});

ipcMain.handle('pick-video', async () => {
  const res = await dialog.showOpenDialog(controlWin, {
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['mp4'] }],
  });
  return res.canceled ? '' : res.filePaths[0];
});

ipcMain.handle('pick-image', async () => {
  const res = await dialog.showOpenDialog(controlWin, {
    properties: ['openFile'],
    filters: [{ name: 'Image', extensions: ['jpg', 'jpeg', 'png'] }],
  });
  return res.canceled ? '' : res.filePaths[0];
});

// ---------- IPC: library scan & matching ----------

ipcMain.handle('scan-library', async (_e, folder) => {
  try {
    const { index, stats } = await scanLibrary(folder);
    libraryIndex = index;
    return { ok: true, stats };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('match-codes', (_e, codes) => {
  if (!libraryIndex) return { ok: false, error: 'Library not scanned yet.' };
  const matches = {};
  for (const code of codes) {
    if (libraryIndex[code]) matches[code] = libraryIndex[code];
  }
  return { ok: true, matches };
});

// ---------- player-pool link ----------

function sendPoolEvent(evt) {
  if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('pool-event', evt);
}

function setPoolStatus(status, detail = '') {
  poolStatus = { status, detail };
  sendPoolEvent({ type: 'status', status, detail });
}

function keyStorage() {
  return safeStorage.isEncryptionAvailable() ? 'encrypted' : 'session';
}

function readKey() {
  const p = store.getPrefs();
  if (p.poolKeyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(p.poolKeyEnc, 'base64'));
    } catch {
      return '';
    }
  }
  return sessionKey;
}

// Encrypted with the OS keychain where there is one. Where there isn't
// (some Linux desktops), the key is kept for this run only, never written
// to disk in plain text.
function saveKey(key) {
  if (safeStorage.isEncryptionAvailable()) {
    store.setPrefs({ poolKeyEnc: safeStorage.encryptString(key).toString('base64') });
    sessionKey = '';
  } else {
    store.setPrefs({ poolKeyEnc: '' });
    sessionKey = key;
  }
}

function stopPoolLink() {
  if (poolLink) poolLink.close();
  poolLink = null;
}

function startPoolLink() {
  stopPoolLink();
  const { poolUrl } = store.getPrefs();
  const key = readKey();
  if (!poolUrl || !key) {
    setPoolStatus('off', poolUrl ? 'Enter the POOL_KEY and connect.' : '');
    return false;
  }
  let createPoolLink;
  try {
    // Loaded here, not at the top: an install that predates the link (no
    // `ws` in node_modules) still opens, and says what to do.
    ({ createPoolLink } = require('./lib/pool-link'));
  } catch {
    setPoolStatus('error', 'This install is missing a component. Close the app and run "npm install" in its folder.');
    return false;
  }
  poolLink = createPoolLink({
    url: poolUrl,
    key,
    onState: (gm) => {
      poolState = gm;
      sendPoolEvent({ type: 'state', gm });
    },
    onStatus: (status, detail) => setPoolStatus(status, detail),
  });
  poolLink.connect();
  return true;
}

function poolConfig() {
  const p = store.getPrefs();
  return { url: p.poolUrl, hasKey: Boolean(readKey()), keyStorage: keyStorage() };
}

ipcMain.handle('pool-get-state', () => ({ gm: poolState, ...poolStatus, ...poolConfig() }));

ipcMain.handle('pool-connect', (_e, cfg = {}) => {
  const url = String(cfg.url || '').trim();
  if (!url) return { ok: false, error: 'Paste the player-pool address first.' };
  try {
    require('./renderer/reconcile.js').linkUrl(url); // throws on garbage
  } catch {
    return { ok: false, error: 'That does not look like a web address.' };
  }
  store.setPrefs({ poolUrl: url });
  if (cfg.key) saveKey(String(cfg.key).trim());
  if (!readKey()) return { ok: false, error: 'Enter the POOL_KEY from the Render dashboard.', ...poolConfig() };
  startPoolLink();
  return { ok: true, ...poolConfig() };
});

ipcMain.handle('pool-disconnect', () => {
  stopPoolLink();
  setPoolStatus('off', 'Disconnected.');
  return { ok: true, ...poolConfig() };
});

ipcMain.handle('pool-forget-key', () => {
  stopPoolLink();
  store.setPrefs({ poolKeyEnc: '' });
  sessionKey = '';
  setPoolStatus('off', 'Key forgotten.');
  return { ok: true, ...poolConfig() };
});

// Only karaoke commands cross from the control panel: the key can do far
// more (draws, bingo…), and this app has no business doing any of it.
ipcMain.handle('pool-cmd', async (_e, type, payload) => {
  if (typeof type !== 'string' || !type.startsWith('karaoke:')) {
    return { ok: false, code: 'not_allowed', error: 'Only karaoke commands are sent from the player.' };
  }
  if (!poolLink) return { ok: false, code: 'offline', error: 'Not connected to player-pool.' };
  try {
    const reply = await poolLink.request(type, payload && typeof payload === 'object' ? payload : {});
    return { ok: true, reply };
  } catch (err) {
    return { ok: false, code: err.code || 'pool_error', error: err.message };
  }
});

// ---------- IPC: prefs and session ----------

ipcMain.handle('prefs-get', () => store.getPrefs());
ipcMain.handle('prefs-set', (_e, partial) => store.setPrefs(partial));
ipcMain.handle('session-load', () => store.loadSession());
ipcMain.handle('session-save', (_e, data) => store.saveSession(data));
ipcMain.handle('session-clear', () => store.clearSession());

// ---------- IPC: file URL helper ----------

ipcMain.handle('to-file-url', (_e, p) => toFileUrl(p));

// ---------- IPC: playback commands ----------

ipcMain.on('playback-cmd', (_e, cmd) => {
  switch (cmd.type) {
    case 'toggle': {
      const win = ensurePlaybackWindow();
      if (win.isVisible()) win.hide();
      else win.show();
      return;
    }
    case 'reposition': {
      const win = ensurePlaybackWindow();
      placePlayback(win);
      win.show();
      return;
    }
    case 'standby':
      sendToPlayback({ type: 'standby', imageUrl: toFileUrl(cmd.imagePath) });
      return;
    case 'play':
      sendToPlayback({
        type: 'play',
        videoUrl: toFileUrl(cmd.filePath),
        start: cmd.start,
        end: cmd.end,
      });
      return;
    default:
      // wait, stop, set-fade pass through untouched
      sendToPlayback(cmd);
  }
});

// Playback renderer -> control renderer event relay.
ipcMain.on('playback-event', (_e, evt) => {
  sendToControl(evt);
});
