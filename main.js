'use strict';

const { app, BrowserWindow, ipcMain, dialog, screen, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { scanLibrary } = require('./lib/indexer');
const { parseRegistrants } = require('./lib/csv');
const { makeStore } = require('./lib/store');

// The playback window has no user gesture, so let media autoplay.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let controlWin = null;
let playbackWin = null;
let playbackReady = false;
let pendingCmds = [];
let store = null;

// The 43k-entry lookup table lives here, in the main process. The control
// panel asks for matches on just the codes it holds (a few dozen rows)
// instead of receiving a multi-megabyte copy of the whole index over IPC.
let libraryIndex = null;

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
    },
  });
  controlWin.loadFile(path.join(__dirname, 'renderer', 'control.html'));
  controlWin.on('closed', () => {
    controlWin = null;
    if (playbackWin && !playbackWin.isDestroyed()) playbackWin.close();
  });

  ensurePlaybackWindow();
}

app.whenReady().then(() => {
  store = makeStore(app.getPath('userData'));
  createWindows();
});

app.on('window-all-closed', () => {
  app.quit();
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

// ---------- IPC: sheet fetch (main process, no CORS) ----------

ipcMain.handle('fetch-sheet', async (_e, url) => {
  try {
    const res = await net.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      return { ok: false, error: 'The sheet URL answered with HTTP ' + res.status + '. Check that the sheet is published to the web as CSV.' };
    }
    const text = await res.text();
    return parseRegistrants(text);
  } catch (err) {
    const msg = err.name === 'TimeoutError' || err.name === 'AbortError'
      ? 'The sheet did not answer within 15 seconds. Check the venue connection and try again.'
      : 'Could not reach the sheet: ' + err.message;
    return { ok: false, error: msg };
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
