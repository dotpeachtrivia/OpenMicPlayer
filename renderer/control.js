'use strict';

// Control panel. Owns this laptop's view of the show: the karaoke line as
// player-pool last sent it, this laptop's media for each singer (video file,
// trim marks), and the live state machine. The playback window is a dumb
// screen: this file tells it what to show and listens for what happened.
//
// player-pool owns the line (who, what order, revealed numbers, singer
// state). This laptop owns the media and the playback. Four rules keep the
// two from tripping over each other on show night:
//
//   I1  Pool traffic never changes the live state (state, busy, current) and
//       never sends a playback command while a Play is in flight, a song is
//       playing, or a fade is running. A `wait` landing between Play and
//       `started` would tear down the starting video and lock Play for good.
//   I2  Every change this laptop makes to a singer's state on the pool is an
//       intent in S.outbox (id -> performing | done | removed). The link just
//       tries to make the pool match; a reconnect replays what's still owed.
//   I3  The pool's order is never edited here. A drag sends karaoke:move and
//       the new order arrives with the pool's broadcast.
//   I4  Inside a live connection a vanished row is a real removal. The first
//       snapshot after a reconnect is checked for a wiped pool first.
//
// One more thing only this laptop knows: when a song actually starts. The
// room's stage screen shows the called singer's "Up next" card until then, so
// syncStarted() tells the pool, and re-tells it from each line it sends back.

const R = window.Reconcile;
const $ = (id) => document.getElementById(id);

const el = {
  lamp: $('lamp'),
  linkLamp: $('link-lamp'),
  banner: $('banner'),
  bannerText: $('banner-text'),
  bannerAction: $('banner-action'),
  bannerClose: $('banner-close'),
  libraryPath: $('library-path'),
  pickLibrary: $('btn-pick-library'),
  scan: $('btn-scan'),
  scanSummary: $('scan-summary'),
  poolUrl: $('pool-url'),
  poolKey: $('pool-key'),
  poolConnect: $('btn-pool-connect'),
  poolDisconnect: $('btn-pool-disconnect'),
  poolSummary: $('pool-summary'),
  standbyPath: $('standby-path'),
  pickStandby: $('btn-pick-standby'),
  queueBody: $('queue-body'),
  queueHint: $('queue-hint'),
  start: $('btn-start'),
  reveal: $('btn-reveal'),
  discard: $('btn-discard'),
  preview: $('preview'),
  previewTitle: $('preview-title'),
  markStart: $('btn-mark-start'),
  markEnd: $('btn-mark-end'),
  clearMarks: $('btn-clear-marks'),
  marksReadout: $('marks-readout'),
  nowName: $('now-name'),
  nextLabel: $('next-label'),
  nextName: $('next-name'),
  nextTitle: $('next-title'),
  nextCount: $('next-count'),
  intervalInput: $('interval-input'),
  fadeInput: $('fade-input'),
  call: $('btn-call'),
  skip: $('btn-skip'),
  play: $('btn-play'),
  stop: $('btn-stop'),
  togglePlayback: $('btn-toggle-playback'),
  reposition: $('btn-reposition'),
};

const FADE_MIN = 0.1;
const FADE_MAX = 5;
const SKIP_ARM_MS = 4000; // Skip removes a singer from the pool: second tap within 4 s
const FALSE_START_MS = 10000; // stopped this soon after starting: same singer, not done

const S = {
  prefs: null,
  haveIndex: false, // the main process holds a fresh scan of the library
  gm: null, // the pool's line as last accepted: { open, songs, songsAt, player, queue }
  pendingGm: null, // detached from a wiped pool: what the pool says now
  media: {}, // pool entry id -> { code, filePath, manual, candidates, matched, startSeconds, endSeconds }
  entries: [], // gm.queue merged with media, with the outbox overlaid
  history: [], // singers skipped tonight (they left the pool's line): { id, name, titleAndArtist, songCode, at }
  outbox: {}, // id -> 'performing' | 'done' | 'removed', still owed to the pool
  started: false, // Start show pressed: call-ups happen as songs end
  state: 'standby', // standby | wait | playing | fading
  busy: false, // a one-shot transition is in flight; every one-shot button locks
  calledId: null, // the singer called to the stage (wait) or on it (playing)
  calledSnap: null, // { id, name, titleAndArtist }: survives the row leaving the line
  intervalEndsAt: null, // when the called-up singer is due at the mic (this laptop's clock)
  current: null, // copied at Play: { id, name, titleAndArtist, startedAt, stopRequested, warned }
  pool: { status: 'off', detail: '', awaitingFirst: true, hasKey: false, keyStorage: 'encrypted' },
  detached: false, // the pool came back wiped; the show runs from the last line seen
  starting: false,
  syncing: false,
  syncAgain: false,
  selectedId: null,
  previewPath: null,
  dragId: null,
  skipArmedUntil: 0,
  renderDeferred: false,
};

// ---------- small utilities ----------

function banner(msg, action) {
  el.bannerText.textContent = msg;
  el.banner.hidden = false;
  if (action) {
    el.bannerAction.textContent = action.label;
    el.bannerAction.hidden = false;
    el.bannerAction.onclick = () => {
      el.banner.hidden = true;
      action.run();
    };
  } else {
    el.bannerAction.hidden = true;
    el.bannerAction.onclick = null;
  }
}

el.bannerClose.addEventListener('click', () => {
  el.banner.hidden = true;
});

function clampFade(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return S.prefs.fadeDurationSeconds;
  return Math.min(FADE_MAX, Math.max(FADE_MIN, n));
}

function fmtTime(sec) {
  if (sec === null || sec === undefined) return '—';
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return m + ':' + s;
}

function fmtCount(sec) {
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const online = () => S.pool.status === 'online' && !S.detached;
const snap = (e) => (e ? { id: e.id, name: e.name, titleAndArtist: e.titleAndArtist, songCode: e.songCode } : null);
const entryById = (id) => S.entries.find((e) => e.id === id) || null;
const calledEntry = () => (S.calledId ? entryById(S.calledId) : null);

// The screen may only be told to change while nothing is starting, playing
// or fading (rule I1).
const screenFree = () => !S.busy && S.state !== 'playing' && S.state !== 'fading';

// Rebuild the rows from the pool's line, this laptop's media and the outbox.
// Returns the ids whose song still has to be looked up in the library.
function rebuild() {
  const r = R.merge(S.gm ? S.gm.queue : [], S.media);
  S.media = r.media;
  S.entries = R.overlay(r.entries, S.outbox);
  return r.needMatch;
}

// The show stays in order without the pool too: while detached from a wiped
// pool, a singer's new state is written straight onto the cached line.
function setLocal(id, desired) {
  if (!S.gm) return;
  if (desired === 'removed') {
    S.gm = { ...S.gm, queue: S.gm.queue.filter((r) => r.id !== id) };
  } else {
    if (desired === 'performing') {
      // Mirror the pool: calling someone up finishes whoever was up.
      S.gm.queue = S.gm.queue.map((r) => (r.state === 'performing' && r.id !== id ? { ...r, state: 'done' } : r));
    }
    S.gm.queue = S.gm.queue.map((r) => (r.id === id ? { ...r, state: desired } : r));
  }
}

let saveTimer = null;
function sessionData() {
  // A song can't resume after a restart, so a live song is saved as the
  // called-up singer waiting for Play again.
  const live = S.state === 'playing' || S.state === 'fading' || S.state === 'wait';
  return {
    version: 2,
    savedAt: new Date().toISOString(),
    gm: S.gm,
    media: S.media,
    history: S.history,
    outbox: S.outbox,
    started: S.started,
    calledId: live ? S.calledId : null,
    calledSnap: live ? S.calledSnap : null,
    detached: S.detached,
  };
}
function saveSession() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.saveSession(sessionData()), 250);
}
// Intents are saved at once: a crash right after a fade must not bring the
// singer who just sang back as next up.
function saveSessionNow() {
  clearTimeout(saveTimer);
  api.saveSession(sessionData());
}

// ---------- playback commands ----------

function cmdStandby() {
  if (!screenFree()) return;
  api.playbackCmd({ type: 'standby', imagePath: S.prefs.standbyImagePath });
}

function cmdWaitFor(sn) {
  if (!screenFree()) return;
  api.playbackCmd({
    type: 'wait',
    name: sn ? sn.name : '',
    title: sn ? sn.titleAndArtist : '',
    endsAt: S.intervalEndsAt,
  });
}

function cmdFade() {
  api.playbackCmd({ type: 'set-fade', seconds: S.prefs.fadeDurationSeconds });
}

// ---------- the pool: intents (rule I2) ----------

function sendState(id, desired) {
  if (!id) return;
  if (S.detached) {
    setLocal(id, desired);
    rebuild();
    return;
  }
  S.outbox[id] = desired;
  rebuild();
  saveSessionNow();
  syncOutbox();
}

// One loop at a time. Each command's reply carries the pool's new line (it
// lands through onPoolEvent before the reply does), so the plan is redrawn
// from fresh state after every send.
async function syncOutbox() {
  if (S.syncing) {
    S.syncAgain = true;
    return;
  }
  S.syncing = true;
  const tried = new Set();
  try {
    while (online() && S.gm) {
      const plan = R.outboxReplay(S.outbox, S.gm.queue);
      for (const id of plan.satisfied) delete S.outbox[id];
      for (const c of plan.conflicts) {
        delete S.outbox[c.id];
        const who = (entryById(c.id) || {}).name || 'A singer';
        banner(
          c.reason === 'already_done'
            ? who + ' was already marked done on player-pool, so they were not called back up.'
            : 'Someone else was called up from the host console while the link was down, so ' + who + ' was not called over them.'
        );
      }
      const next = plan.send.find((cmd) => !tried.has(cmd.id + ':' + cmd.desired));
      if (!next) break;
      tried.add(next.id + ':' + next.desired);
      const type = { performing: 'karaoke:performing', done: 'karaoke:done', removed: 'karaoke:remove' }[next.desired];
      const payload = { id: next.id };
      if (next.desired === 'performing' && next.id === S.calledId && S.intervalEndsAt) {
        const left = Math.round((S.intervalEndsAt - Date.now()) / 1000);
        if (left > 0) payload.readySeconds = left; // the phone counts down with the screen
      }
      const res = await api.poolCmd(type, payload);
      if (res.ok) {
        if (S.outbox[next.id] === next.desired) delete S.outbox[next.id];
      } else if (res.code === 'offline' || res.code === 'timeout') {
        break; // kept; the next snapshot after a reconnect replays it
      } else {
        delete S.outbox[next.id];
        if (res.code !== 'bad_entry') banner('player-pool refused a change: ' + res.error);
      }
    }
  } finally {
    S.syncing = false;
    rebuild();
    // A conflict just dropped (say, our call-up overtaken by the host's) may
    // change who is called: the rules skipped while it was still owed.
    applyRemoteChanges();
    refresh();
    saveSessionNow();
    if (S.syncAgain) {
      S.syncAgain = false;
      syncOutbox();
    }
  }
}

// ---------- the pool: the song started ----------

// Makes the pool's word on whether the called singer's song is running match
// this laptop's, the way syncOutbox does for singer states: Play confirmed is
// a start, a false start or a reload mid-song is a stop. Called after every
// such change and after every line the pool sends, so a start the link
// dropped goes out again; once the pool's own line says it, the plan is empty
// and nothing is sent. A refusal is left alone for the next line to settle.
let startedInFlight = null;
async function syncStarted() {
  if (!online() || !S.gm) return;
  const live = S.state === 'playing' || S.state === 'fading';
  const plan = R.startedPlan(S.gm.queue, S.calledId, live, S.outbox);
  if (!plan) return;
  const key = plan.id + ':' + plan.started;
  if (startedInFlight === key) return;
  startedInFlight = key;
  try {
    await api.poolCmd('karaoke:started', { id: plan.id, started: plan.started });
  } finally {
    if (startedInFlight === key) startedInFlight = null;
  }
}

// ---------- the pool: incoming ----------

function onPoolStatus(status, detail) {
  const was = S.pool.status;
  S.pool.status = status;
  S.pool.detail = detail || '';
  if (status === 'online' && was !== 'online') S.pool.awaitingFirst = true;
  refresh();
}

function applyPoolState(gm) {
  if (S.pool.awaitingFirst) {
    S.pool.awaitingFirst = false;
    const known = S.gm ? S.gm.queue.map((r) => r.id) : [];
    if (!S.detached && R.detectWipe(known, gm.queue)) {
      S.detached = true;
      S.pendingGm = gm;
      bannerDetached();
      refresh();
      saveSessionNow();
      return;
    }
  }
  if (S.detached) {
    S.pendingGm = gm; // shown in the summary; taken only when the operator says so
    refresh();
    return;
  }
  acceptPoolState(gm);
}

function acceptPoolState(gm) {
  S.gm = gm;
  const needMatch = rebuild();
  applyRemoteChanges();
  if (needMatch.length) matchIds(needMatch);
  syncOutbox(); // also replays what a reconnect left owed
  syncStarted(); // likewise a start (or a stop) the link dropped
  refresh();
  saveSession();
}

function bannerDetached() {
  banner(
    'player-pool restarted and lost its line (a redeploy, or the free tier idling out). ' +
      'The show continues from the last line this laptop saw; phones will need to sign up again.',
    { label: 'Use the new line', run: useNewLine }
  );
}

function useNewLine() {
  S.detached = false;
  S.outbox = {}; // those ids belong to the line that was lost
  const gm = S.pendingGm || { open: false, songs: 0, songsAt: null, player: null, queue: [] };
  S.pendingGm = null;
  S.gm = gm;
  const needMatch = rebuild();
  if (needMatch.length) matchIds(needMatch);
  if (S.state === 'wait' && screenFree()) callNext();
  refresh();
  saveSessionNow();
}

// What the host did from the console, applied without touching a song that
// is starting, playing or fading (rule I1).
function applyRemoteChanges() {
  if (!S.gm) return;
  if (S.state === 'playing' || S.state === 'fading') {
    const cur = S.current;
    if (cur && !cur.warned) {
      const row = S.gm.queue.find((r) => r.id === cur.id);
      if (!row || row.state !== 'performing') {
        cur.warned = true;
        banner(cur.name + ' was ' + (row ? 'marked done' : 'removed') + ' on player-pool mid-song. The song plays on.');
      }
    }
    return;
  }
  if (S.state !== 'wait' || S.busy || !S.started) return;
  if (S.outbox[S.calledId]) return; // our own call-up isn't confirmed yet
  const onStage = S.gm.queue.find((r) => r.state === 'performing');
  if (onStage && onStage.id !== S.calledId && !['done', 'removed'].includes(S.outbox[onStage.id])) {
    adopt(onStage, 'The host called up ' + onStage.nickname + ' from the console.');
    return;
  }
  const row = S.gm.queue.find((r) => r.id === S.calledId);
  if (!row || row.state === 'done') {
    const who = S.calledSnap ? S.calledSnap.name : 'The called singer';
    banner(who + ' was ' + (row ? 'marked done' : 'taken out of the line') + ' on player-pool. Calling the next singer.');
    callNext();
  }
}

// Someone is already on stage per the pool (the host called them, or the
// show resumed): make them the called singer without calling them again.
function adopt(row, why) {
  const e = entryById(row.id);
  S.calledId = row.id;
  S.calledSnap = e ? snap(e) : { id: row.id, name: row.nickname, titleAndArtist: row.songTitle, songCode: row.songCode };
  const secs = S.prefs.intervalSeconds;
  S.intervalEndsAt = secs > 0 ? Date.now() + secs * 1000 : null;
  S.state = 'wait';
  cmdWaitFor(S.calledSnap);
  if (why) banner(why);
}

// ---------- the show ----------

// Call the next eligible singer to the stage: their phone buzzes and counts
// down, the big screen shows them with the same countdown. Nothing plays
// until the operator presses Play.
function callNext() {
  const gone = Object.keys(S.outbox).filter((id) => S.outbox[id] === 'removed' || S.outbox[id] === 'done');
  const next = R.nextEligible(S.entries, gone);
  if (!next) {
    S.calledId = null;
    S.calledSnap = null;
    S.intervalEndsAt = null;
    S.state = 'standby';
    cmdStandby();
    return null;
  }
  S.calledId = next.id;
  S.calledSnap = snap(next);
  const secs = S.prefs.intervalSeconds;
  S.intervalEndsAt = secs > 0 ? Date.now() + secs * 1000 : null;
  S.state = 'wait';
  sendState(next.id, 'performing');
  cmdWaitFor(S.calledSnap);
  return next;
}

async function startShow() {
  if (S.started || S.starting || !online()) return;
  const open = S.gm && S.gm.open;
  const ok = window.confirm(
    'Start the show? Every waiting singer\'s phone shows their number, and the first singer is called to the stage.' +
      (open ? '\n\nSign-ups are still open: anyone who signs up from now on waits without a number until you press Reveal.' : '')
  );
  if (!ok) return;
  S.starting = true;
  refresh();
  const res = await api.poolCmd('karaoke:reveal', {});
  S.starting = false;
  if (!res.ok) {
    banner('Could not start the show: ' + res.error);
    refresh();
    return;
  }
  S.started = true;
  // The reply's line has already arrived. If the host started from the
  // console and someone is up, take them as they are: calling another
  // singer would mark the host's singer done unsung.
  const onStage = S.gm && S.gm.queue.find((r) => r.state === 'performing');
  if (onStage) adopt(onStage);
  else if (!callNext()) banner('Nobody can be called yet: no waiting singer has both a number and a video. Call next appears once someone does.');
  refresh();
  saveSessionNow();
}

async function revealNew() {
  if (!online()) return;
  el.reveal.disabled = true;
  const res = await api.poolCmd('karaoke:reveal', {});
  if (!res.ok) banner('Could not reveal: ' + res.error);
  else if (res.reply && res.reply.revealed) banner('Numbers are out on ' + res.reply.revealed + ' more phone' + (res.reply.revealed === 1 ? '' : 's') + '.');
  refresh();
}

// ---------- matching ----------

async function matchIds(ids) {
  if (!S.haveIndex || !ids.length) return;
  const codes = [...new Set(ids.map((id) => S.media[id] && S.media[id].code).filter(Boolean))];
  const res = codes.length ? await api.matchCodes(codes) : { ok: true, matches: {} };
  if (!res.ok) return;
  for (const id of ids) {
    const m = S.media[id];
    if (!m) continue; // left the line while we looked
    if (!m.code) {
      S.media[id] = { ...m, matched: m.manual && m.filePath ? 'ok' : 'missing' }; // an off-list song
      continue;
    }
    S.media[id] = R.applyMatch(m, res.matches[m.code] || []);
  }
  rebuild();
  refresh();
  saveSession();
}

function matchAll() {
  return matchIds(Object.keys(S.media));
}

// ---------- rendering ----------

function setLamp(state) {
  const labels = { standby: 'STANDBY', wait: 'WAIT', playing: 'PLAYING', fading: 'FADING' };
  el.lamp.textContent = labels[state];
  el.lamp.className = 'lamp lamp-' + state;
}

function renderPool() {
  const st = S.detached ? 'detached' : S.pool.status;
  const labels = {
    off: 'NO LINK', connecting: 'LINKING', online: 'LINKED', offline: 'OFFLINE',
    auth: 'BAD KEY', error: 'ERROR', detached: 'DETACHED',
  };
  el.linkLamp.textContent = labels[st] || st.toUpperCase();
  el.linkLamp.className = 'lamp link-' + st;
  el.poolDisconnect.disabled = S.pool.status === 'off';
  el.poolConnect.textContent = S.pool.status === 'off' ? 'Connect' : 'Reconnect';
  const session = S.pool.keyStorage === 'session';
  el.poolKey.placeholder = !S.pool.hasKey ? 'POOL_KEY' : session ? 'Key (unsaved)' : 'Key (saved)';
  el.poolKey.title = !S.pool.hasKey
    ? 'The POOL_KEY from the Render dashboard (Environment tab).'
    : session
      ? 'Kept until the app closes: this computer has no secure key store, so the key is never written to disk.'
      : 'Saved encrypted with this computer\'s key store. Type a new one to replace it.';

  const parts = [];
  if (S.detached) {
    const n = S.pendingGm ? S.pendingGm.queue.length : 0;
    parts.push('Running from the last line seen. The restarted pool has ' + n + ' sign-up' + (n === 1 ? '' : 's') + '.');
  } else if (S.pool.detail && S.pool.status !== 'online') {
    parts.push(S.pool.detail);
  }
  if (S.gm && !S.detached && S.pool.status === 'online') {
    const waiting = S.gm.queue.filter((r) => r.state === 'queued');
    const hidden = waiting.filter((r) => r.revealed === false).length;
    parts.push(
      (S.gm.open ? 'Sign-ups open' : 'Sign-ups closed') + ' · ' + waiting.length + ' waiting' +
        (hidden ? ' · ' + hidden + ' without a number' : '')
    );
    if (S.gm.songs === 0) parts.push('player-pool\'s song list isn\'t loaded yet, so phones can\'t search.');
  }
  if (!parts.length) parts.push(S.pool.status === 'off' ? 'Not connected. Sign-ups come from player-pool once you connect.' : 'Linked.');
  el.poolSummary.textContent = parts.join(' ');
}

function renderLiveStrip() {
  const called = S.calledSnap;
  const playing = S.state === 'playing' || S.state === 'fading';
  el.nowName.textContent = playing && S.current ? S.current.name : '—';

  if (S.state === 'wait' && called) {
    el.nextLabel.textContent = 'Called up';
    el.nextName.textContent = called.name;
    el.nextTitle.textContent = called.titleAndArtist || '';
  } else {
    // While a song plays, the singer after it.
    const deck = R.nextEligible(S.entries, S.calledId ? [S.calledId] : []);
    el.nextLabel.textContent = 'Next';
    el.nextName.textContent = deck ? deck.name : '—';
    el.nextTitle.textContent = deck ? deck.titleAndArtist : '';
  }
  tickCountdown();

  const e = calledEntry();
  const armed = Date.now() < S.skipArmedUntil;
  el.play.disabled = S.busy || S.state !== 'wait' || !e || !e.filePath;
  el.skip.disabled = S.busy || S.state !== 'wait' || !S.calledId;
  el.skip.textContent = armed ? 'Tap again to remove' : 'Skip no-show';
  el.skip.classList.toggle('armed', armed);
  el.stop.disabled = S.busy || S.state !== 'playing';

  const showCall = S.started && S.state === 'standby';
  el.call.hidden = !showCall;
  if (showCall) {
    const next = R.nextEligible(S.entries);
    el.call.disabled = S.busy || !next;
    el.call.textContent = next ? 'Call ' + next.name : 'Call next';
  }
}

function tickCountdown() {
  if (S.state !== 'wait' || !S.intervalEndsAt) {
    el.nextCount.textContent = '';
    return;
  }
  const left = Math.max(0, Math.ceil((S.intervalEndsAt - Date.now()) / 1000));
  el.nextCount.textContent = left > 0 ? fmtCount(left) : 'GET READY';
}
setInterval(tickCountdown, 250);

function statusBadge(e, deck) {
  if (e.history) return '<span class="badge badge-skipped">Skipped</span>';
  if (e.poolState === 'done') return '<span class="badge badge-done">Done</span>';
  if (e.poolState === 'performing') {
    if (S.current && S.current.id === e.id && (S.state === 'playing' || S.state === 'fading')) {
      return '<span class="badge badge-playing">Playing</span>';
    }
    return '<span class="badge badge-current">Called up</span>';
  }
  // File problems first: they are what the operator can fix before it matters.
  if (e.matched === 'unmatched') return '<span class="badge badge-unchecked">Not checked</span>';
  if (e.matched === 'missing') return '<span class="badge badge-missing">No file</span>';
  // Before Start show everyone is unnumbered; after it, only latecomers are.
  if (!e.revealed && S.started) return '<span class="badge badge-hidden">No number yet</span>';
  if (e.matched === 'dupe') return '<span class="badge badge-dupe">' + e.candidates.length + ' files</span>';
  if (deck && e.id === deck.id) return '<span class="badge badge-current">On deck</span>';
  return '<span class="badge badge-ready">Ready</span>';
}

function setMedia(id, patch) {
  S.media[id] = { ...(S.media[id] || R.blankMedia('')), ...patch };
  rebuild();
  refresh();
  saveSession();
}

function renderQueue() {
  // A rebuild mid-drag (or while a file dropdown is open) would drop what the
  // operator has in hand; catch up once they let go.
  const active = document.activeElement;
  if (S.dragId || (active && active.classList && active.classList.contains('dupe-select'))) {
    S.renderDeferred = true;
    return;
  }
  S.renderDeferred = false;
  el.queueBody.innerHTML = '';

  const deck = R.nextEligible(S.entries, S.calledId ? [S.calledId] : []);
  // Before Start show nobody has a number yet (it reveals them), so only a
  // missing video counts as a problem then.
  const blockedList = R.blockedAhead(S.entries, S.calledId ? [S.calledId] : []).filter(
    (b) => S.started || b.reason === 'nofile'
  );
  const blocked = new Set(blockedList.map((b) => b.id));
  const canDrag = online();
  const rows = [...S.entries, ...S.history.map((h) => ({ ...h, history: true, poolState: 'skipped' }))];
  let spot = 0;

  for (const e of rows) {
    const tr = document.createElement('tr');
    tr.dataset.id = e.id;
    const waiting = e.poolState === 'queued';
    const isPlaying = S.current && S.current.id === e.id && (S.state === 'playing' || S.state === 'fading');
    if (waiting) spot += 1;
    if (e.id === S.selectedId) tr.classList.add('selected');
    if (e.poolState === 'done') tr.classList.add('row-done');
    if (e.history) tr.classList.add('row-skipped');
    if (e.id === S.calledId) tr.classList.add('row-current');
    if (blocked.has(e.id)) tr.classList.add('row-blocked');

    const handle = waiting && canDrag ? '<span class="drag-handle">≡</span>' : '';
    const trim =
      e.startSeconds != null || e.endSeconds != null ? fmtTime(e.startSeconds ?? 0) + ' → ' + fmtTime(e.endSeconds) : '—';
    tr.innerHTML =
      '<td>' + handle + (waiting ? spot : '') + '</td>' +
      '<td>' + esc(e.name) + '</td>' +
      '<td><span class="song-title">' + esc(e.titleAndArtist || '(untitled)') +
      (e.jpOnly ? '<span class="tag-jp" title="The video\'s lyrics are Japanese only">JP lyrics</span>' : '') + '</span>' +
      '<span class="song-code">' + esc(e.songCode || 'off-list') + '</span></td>' +
      '<td class="trim-cell">' + (e.history ? '' : trim) + '</td>' +
      '<td>' + statusBadge(e, deck) + '</td>' +
      '<td class="actions-cell"></td>';

    const actions = tr.querySelector('.actions-cell');
    // Files can be fixed right up to Play; only the playing row is locked.
    const pickable = e.matched === 'missing' || e.matched === 'unmatched' || (e.matched === 'ok' && e.manual);
    if (!e.history && !isPlaying && e.poolState !== 'done' && pickable) {
      const b = document.createElement('button');
      b.textContent = 'Browse…';
      b.className = 'small';
      b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const p = await api.pickVideo();
        if (p) setMedia(e.id, { filePath: p, manual: true, matched: 'ok' });
      });
      actions.appendChild(b);
    }
    if (!e.history && !isPlaying && e.poolState !== 'done' && e.matched === 'dupe') {
      const sel = document.createElement('select');
      sel.className = 'dupe-select';
      for (const c of e.candidates) {
        const opt = document.createElement('option');
        opt.value = c.filePath;
        opt.textContent = c.date;
        if (c.filePath === e.filePath) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('click', (ev) => ev.stopPropagation());
      sel.addEventListener('change', () => setMedia(e.id, { filePath: sel.value }));
      sel.addEventListener('blur', () => {
        if (S.renderDeferred) setTimeout(refresh, 0);
      });
      actions.appendChild(sel);
    }

    if (!e.history) tr.addEventListener('click', () => selectEntry(e.id));

    if (waiting && canDrag) {
      tr.draggable = true;
      tr.addEventListener('dragstart', () => {
        S.dragId = e.id;
        tr.classList.add('dragging');
      });
      tr.addEventListener('dragend', () => {
        S.dragId = null;
        tr.classList.remove('dragging');
        if (S.renderDeferred) refresh();
      });
    }
    if (waiting) {
      tr.addEventListener('dragover', (ev) => ev.preventDefault());
      tr.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        const from = S.dragId;
        S.dragId = null;
        const to = R.spotForDrop(S.entries, from, e.id);
        if (to == null) return refresh();
        // The pool sets the order (rule I3): the new order arrives with its broadcast.
        const res = await api.poolCmd('karaoke:move', { id: from, to });
        if (!res.ok) banner('Could not move that singer: ' + res.error);
        refresh();
      });
    }

    el.queueBody.appendChild(tr);
  }

  renderHints(blockedList);
}

function renderHints(blockedList) {
  const hidden = S.entries.filter((e) => e.poolState === 'queued' && !e.revealed).length;
  el.start.hidden = S.started;
  el.start.disabled = S.starting || !online() || !S.haveIndex;
  el.reveal.hidden = !S.started || !hidden;
  el.reveal.disabled = !online();
  el.reveal.textContent = 'Reveal ' + hidden + ' new';

  let hint;
  if (S.pool.status === 'off' && !S.gm) {
    hint = 'Connect to player-pool and scan the library. Sign-ups appear here as phones register.';
  } else if (!S.haveIndex && S.entries.some((e) => e.matched === 'unmatched')) {
    hint = 'Scan the library so new sign-ups can be matched to their videos.';
  } else if (!S.entries.length) {
    hint = 'Nobody in line yet. Sign-ups appear here as phones register.';
  } else if (blockedList.length) {
    const names = blockedList.map((b) =>
      b.name + (b.reason === 'nofile' ? ' (no video: Browse… a file for them, or the host removes them)' : ' (no number yet: Reveal)'));
    hint = 'Passed over at the next call-up: ' + names.join(', ') + '.';
  } else if (!S.started) {
    hint = 'Trim each song in the preview and drag to set the order (the host can reorder too). ' +
      (hidden ? hidden + ' without a number: Start show reveals them.' : 'Start show when the slot begins.');
  } else {
    hint = 'The show is on. When a song ends the next singer is called up automatically; you press Play.';
  }
  el.queueHint.textContent = hint;
}

async function renderPreview() {
  const e = entryById(S.selectedId);
  const isPlaying = e && S.current && S.current.id === e.id && (S.state === 'playing' || S.state === 'fading');
  el.markStart.disabled = !e || !e.filePath || isPlaying;
  el.markEnd.disabled = !e || !e.filePath || isPlaying;
  el.clearMarks.disabled = !e || isPlaying || (e.startSeconds == null && e.endSeconds == null);
  if (!e) {
    el.previewTitle.textContent = 'Click a queue row to load its video here.';
    el.marksReadout.textContent = 'Start — · End —';
  } else {
    el.previewTitle.textContent = e.name + ' — ' + (e.titleAndArtist || e.songCode);
    el.marksReadout.textContent = 'Start ' + fmtTime(e.startSeconds) + ' · End ' + fmtTime(e.endSeconds);
  }
  // Reload the preview only when the file changed (a song swap, a Browse).
  const path = e ? e.filePath || '' : '';
  if (path !== S.previewPath) {
    S.previewPath = path;
    if (path) el.preview.src = await api.toFileUrl(path);
    else {
      el.preview.removeAttribute('src');
      el.preview.load();
    }
  }
}

function refresh() {
  setLamp(S.state);
  renderPool();
  renderQueue();
  renderLiveStrip();
  renderPreview();
}

// ---------- preview & trim ----------

function selectEntry(id) {
  if (!entryById(id)) return;
  S.selectedId = id;
  refresh();
}

el.markStart.addEventListener('click', () => {
  const e = entryById(S.selectedId);
  if (!e) return;
  const t = Math.round(el.preview.currentTime * 100) / 100;
  if (e.endSeconds != null && t >= e.endSeconds) {
    banner('Start point must come before the end point (' + fmtTime(e.endSeconds) + ').');
    return;
  }
  setMedia(e.id, { startSeconds: t });
});

el.markEnd.addEventListener('click', () => {
  const e = entryById(S.selectedId);
  if (!e) return;
  const t = Math.round(el.preview.currentTime * 100) / 100;
  if (e.startSeconds != null && t <= e.startSeconds) {
    banner('End point must come after the start point (' + fmtTime(e.startSeconds) + ').');
    return;
  }
  setMedia(e.id, { endSeconds: t });
});

el.clearMarks.addEventListener('click', () => {
  const e = entryById(S.selectedId);
  if (!e) return;
  setMedia(e.id, { startSeconds: null, endSeconds: null });
});

// ---------- setup actions ----------

el.pickLibrary.addEventListener('click', async () => {
  const p = await api.pickFolder();
  if (!p) return;
  S.prefs = await api.setPrefs({ libraryPath: p });
  el.libraryPath.value = p;
  el.scan.disabled = false;
});

async function scanLibrary() {
  el.scan.disabled = true;
  el.scanSummary.textContent = 'Scanning…';
  const res = await api.scanLibrary(S.prefs.libraryPath);
  el.scan.disabled = false;
  if (!res.ok) {
    el.scanSummary.textContent = 'Scan failed: ' + res.error;
    return;
  }
  S.haveIndex = true;
  const st = res.stats;
  el.scanSummary.textContent =
    st.parsed + ' videos indexed (' + st.uniqueCodes + ' unique codes, ' +
    st.duplicateCodes + ' with duplicates, ' + st.skipped + ' filenames skipped).';
  await matchAll();
  refresh();
  saveSession();
}

el.scan.addEventListener('click', scanLibrary);

el.poolConnect.addEventListener('click', async () => {
  el.poolConnect.disabled = true;
  const res = await api.poolConnect({ url: el.poolUrl.value.trim(), key: el.poolKey.value.trim() });
  el.poolConnect.disabled = false;
  el.poolKey.value = '';
  S.pool.hasKey = Boolean(res.hasKey);
  S.pool.keyStorage = res.keyStorage;
  if (!res.ok) banner(res.error);
  else if (res.keyStorage === 'session') {
    banner('This computer has no secure key store, so the POOL_KEY is kept until the app closes, not saved.');
  }
  refresh();
});

el.poolDisconnect.addEventListener('click', async () => {
  await api.poolDisconnect();
  refresh();
});

el.pickStandby.addEventListener('click', async () => {
  const p = await api.pickImage();
  if (!p) return;
  S.prefs = await api.setPrefs({ standbyImagePath: p });
  el.standbyPath.value = p;
  if (S.state === 'standby') cmdStandby();
});

el.discard.addEventListener('click', async () => {
  if (!screenFree()) {
    banner('Finish or stop the current song first.');
    return;
  }
  const ok = window.confirm(
    'Reset this laptop\'s session? File choices, trim marks and show progress are cleared. ' +
      'The line on player-pool is not touched; clear it from the host console or restart the pool for a new day.'
  );
  if (!ok) return;
  await api.clearSession();
  S.media = {};
  S.history = [];
  S.outbox = {};
  S.started = false;
  S.state = 'standby';
  S.calledId = null;
  S.calledSnap = null;
  S.intervalEndsAt = null;
  S.current = null;
  S.selectedId = null;
  S.busy = false;
  if (S.detached) {
    S.detached = false;
    S.gm = S.pendingGm || S.gm;
    S.pendingGm = null;
  }
  const needMatch = rebuild();
  if (needMatch.length) matchIds(needMatch);
  cmdStandby();
  refresh();
});

el.start.addEventListener('click', startShow);
el.linkLamp.addEventListener('click', () => {
  if (S.detached) bannerDetached(); // the choice again, if its banner was dismissed
});
el.reveal.addEventListener('click', revealNew);

// ---------- live controls (all one-shot) ----------

el.play.addEventListener('click', () => {
  const e = calledEntry();
  if (!e || !e.filePath || S.state !== 'wait' || S.busy) return;
  S.busy = true; // Play locks the instant it's pressed
  S.current = { id: e.id, name: e.name, titleAndArtist: e.titleAndArtist, startedAt: null, stopRequested: false, warned: false };
  renderLiveStrip();
  api.playbackCmd({
    type: 'play',
    filePath: e.filePath,
    start: e.startSeconds ?? 0,
    end: e.endSeconds ?? null,
  });
});

el.skip.addEventListener('click', () => {
  if (S.state !== 'wait' || S.busy || !S.calledId) return;
  // Skip takes the singer out of player-pool's line: a second tap confirms.
  if (Date.now() > S.skipArmedUntil) {
    S.skipArmedUntil = Date.now() + SKIP_ARM_MS;
    renderLiveStrip();
    setTimeout(renderLiveStrip, SKIP_ARM_MS + 50);
    return;
  }
  S.skipArmedUntil = 0;
  const sn = S.calledSnap;
  S.history.push({ ...sn, at: Date.now() });
  sendState(sn.id, 'removed'); // before the next call-up, which would mark them done
  callNext();
  refresh();
  saveSessionNow();
});

el.stop.addEventListener('click', () => {
  if (S.state !== 'playing' || S.busy) return;
  // Locks the instant it's pressed and stays locked through the fade.
  S.busy = true;
  if (S.current) S.current.stopRequested = true;
  renderLiveStrip();
  api.playbackCmd({ type: 'stop' });
});

el.call.addEventListener('click', () => {
  if (!S.started || S.state !== 'standby' || S.busy) return;
  callNext();
  refresh();
  saveSessionNow();
});

// ---------- interval & fade settings ----------

function applyIntervalInput() {
  const v = R.clampInterval(el.intervalInput.value, S.prefs.intervalSeconds);
  el.intervalInput.value = v;
  S.prefs.intervalSeconds = v;
  // Applies from the next call-up; a countdown already running keeps its time.
  api.setPrefs({ intervalSeconds: v }).then((p) => (S.prefs = p));
}

el.intervalInput.addEventListener('change', applyIntervalInput);

function applyFadeInput() {
  const v = clampFade(el.fadeInput.value);
  el.fadeInput.value = v;
  S.prefs.fadeDurationSeconds = v;
  api.setPrefs({ fadeDurationSeconds: v }).then((p) => (S.prefs = p));
  cmdFade();
}

el.fadeInput.addEventListener('change', applyFadeInput);

// ---------- playback window controls ----------

el.togglePlayback.addEventListener('click', () => api.playbackCmd({ type: 'toggle' }));
el.reposition.addEventListener('click', () => api.playbackCmd({ type: 'reposition' }));

// ---------- events from the playback window ----------

function resyncPlayback() {
  if (!S.prefs) return; // still initializing; init() sends its own commands
  cmdFade();
  if (S.state === 'standby') {
    cmdStandby();
  } else if (S.state === 'wait' && !S.busy) {
    cmdWaitFor(S.calledSnap); // same countdown, same end time
  } else {
    // The playback window reloaded mid-song (or mid-start). The song can't
    // resume; the singer is still the called one, and the show returns to
    // Wait for them.
    S.current = null;
    S.busy = false;
    S.state = 'wait';
    S.intervalEndsAt = null;
    cmdWaitFor(S.calledSnap);
    syncStarted(); // the room's screen goes back to their Up next card
    banner('The playback window reloaded mid-song. Press Play to restart it.');
    refresh();
    saveSessionNow();
  }
}

api.onPlaybackEvent((evt) => {
  switch (evt.type) {
    case 'ready':
      resyncPlayback();
      break;
    case 'playback-window-closed':
      banner('The playback window was closed. Press "Reposition playback" to bring it back.');
      break;
    case 'started':
      S.state = 'playing';
      S.busy = false;
      if (S.current) S.current.startedAt = Date.now();
      S.intervalEndsAt = null;
      syncStarted(); // the room's screen trades the Up next card for the logo
      refresh();
      break;
    case 'fading':
      S.state = 'fading';
      S.busy = false;
      refresh();
      break;
    case 'faded': {
      const cur = S.current;
      S.current = null;
      S.busy = false;
      S.state = 'wait'; // the song is over: the screen is free again
      if (cur && cur.stopRequested && cur.startedAt && Date.now() - cur.startedAt < FALSE_START_MS) {
        // A false start (the singer wasn't at the mic, the wrong file…): they
        // stay the called singer, still up on their phone.
        S.intervalEndsAt = null;
        cmdWaitFor(S.calledSnap);
        syncStarted(); // their Up next card comes back on the room's screen
        banner(cur.name + ' was stopped within ' + FALSE_START_MS / 1000 + ' s of starting, so they are still up. Press Play to restart, or Skip.');
      } else {
        if (cur) sendState(cur.id, 'done');
        callNext();
      }
      refresh();
      saveSessionNow();
      break;
    }
    case 'error': {
      banner(evt.message + ' The singer stays called up; press Play to try again.');
      S.current = null;
      S.busy = false;
      S.state = 'wait';
      S.intervalEndsAt = null;
      cmdWaitFor(S.calledSnap);
      syncStarted();
      refresh();
      break;
    }
  }
});

api.onPoolEvent((evt) => {
  if (evt.type === 'status') onPoolStatus(evt.status, evt.detail);
  else if (evt.type === 'state' && evt.gm) applyPoolState(evt.gm);
});

// ---------- init ----------

async function init() {
  S.prefs = await api.getPrefs();
  el.libraryPath.value = S.prefs.libraryPath;
  el.standbyPath.value = S.prefs.standbyImagePath;
  el.fadeInput.value = S.prefs.fadeDurationSeconds;
  el.intervalInput.value = S.prefs.intervalSeconds;
  el.scan.disabled = !S.prefs.libraryPath;

  cmdFade();
  cmdStandby();

  const session = await api.loadSession();
  if (session && session.version === 2) {
    S.gm = session.gm || null;
    S.media = session.media || {};
    S.history = session.history || [];
    S.outbox = session.outbox || {};
    S.started = Boolean(session.started);
    S.detached = Boolean(session.detached);
    rebuild();
    if (session.calledId) {
      // A song can't resume: the called singer waits for Play again.
      S.calledId = session.calledId;
      S.calledSnap = session.calledSnap || snap(entryById(session.calledId));
      S.state = 'wait';
      cmdWaitFor(S.calledSnap);
    }
    banner(
      S.started
        ? 'Restored the show from disk' + (S.calledSnap ? ': ' + S.calledSnap.name + ' is called up, press Play when ready.' : '.') +
            ' Use Reset session if this is a new day.'
        : 'Restored this laptop\'s session (files and trims) from disk.'
    );
  } else if (session && Array.isArray(session.entries)) {
    banner('A session from the older Google Sheet version was found and ignored; sign-ups now come from player-pool.');
  }

  const ps = await api.poolGetState();
  el.poolUrl.value = ps.url || '';
  S.pool.hasKey = Boolean(ps.hasKey);
  S.pool.keyStorage = ps.keyStorage;
  onPoolStatus(ps.status, ps.detail);
  if (ps.gm) applyPoolState(ps.gm);

  refresh();

  // New sign-ups can only be matched against a scanned library, so scan the
  // saved folder now instead of waiting for someone to press Scan.
  if (S.prefs.libraryPath) scanLibrary();
}

init();
