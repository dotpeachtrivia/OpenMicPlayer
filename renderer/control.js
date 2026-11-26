'use strict';

// Control panel. Owns the queue, the session file, and the live state
// machine. The playback window is a dumb screen: this file tells it what
// to show and listens for what happened.

const $ = (id) => document.getElementById(id);

const el = {
  lamp: $('lamp'),
  banner: $('banner'),
  bannerText: $('banner-text'),
  bannerClose: $('banner-close'),
  libraryPath: $('library-path'),
  pickLibrary: $('btn-pick-library'),
  scan: $('btn-scan'),
  scanSummary: $('scan-summary'),
  sheetUrl: $('sheet-url'),
  loadRegistrants: $('btn-load-registrants'),
  loadSummary: $('load-summary'),
  standbyPath: $('standby-path'),
  pickStandby: $('btn-pick-standby'),
  queueBody: $('queue-body'),
  queueHint: $('queue-hint'),
  finalize: $('btn-finalize'),
  discard: $('btn-discard'),
  preview: $('preview'),
  previewTitle: $('preview-title'),
  markStart: $('btn-mark-start'),
  markEnd: $('btn-mark-end'),
  clearMarks: $('btn-clear-marks'),
  marksReadout: $('marks-readout'),
  nowName: $('now-name'),
  nextName: $('next-name'),
  fadeInput: $('fade-input'),
  skip: $('btn-skip'),
  play: $('btn-play'),
  stop: $('btn-stop'),
  togglePlayback: $('btn-toggle-playback'),
  reposition: $('btn-reposition'),
};

const FADE_MIN = 0.1;
const FADE_MAX = 5;

const S = {
  prefs: null,
  haveIndex: false, // the main process holds a fresh scan of the library
  entries: [],
  finalized: false,
  state: 'standby', // standby | wait | playing | fading
  busy: false, // a one-shot transition is in flight; every one-shot button locks
  selectedId: null,
  playingId: null,
  dragId: null,
};

// ---------- small utilities ----------

function banner(msg) {
  el.bannerText.textContent = msg;
  el.banner.hidden = false;
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

function entryKey(r) {
  return [r.timestamp, r.songCode, r.name].join('|');
}

function nextPending() {
  return S.entries.find((e) => e.live === 'pending') || null;
}

let saveTimer = null;
function saveSession() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api.saveSession({ entries: S.entries, finalized: S.finalized, savedAt: new Date().toISOString() });
  }, 250);
}

// ---------- playback commands ----------

function cmdStandby() {
  api.playbackCmd({ type: 'standby', imagePath: S.prefs.standbyImagePath });
}

function cmdWait(name) {
  api.playbackCmd({ type: 'wait', name });
}

function cmdFade() {
  api.playbackCmd({ type: 'set-fade', seconds: S.prefs.fadeDurationSeconds });
}

// ---------- matching ----------

function applyMatch(e, hits) {
  if (e.manual && e.filePath) {
    e.matched = 'ok';
    return;
  }
  if (hits.length === 0) {
    e.matched = 'missing';
    e.filePath = '';
    e.candidates = [];
  } else if (hits.length === 1) {
    e.matched = 'ok';
    e.filePath = hits[0].filePath;
    e.candidates = [];
  } else {
    // Redownloads on different dates: keep both, default to the newest,
    // but respect a choice the operator already made.
    e.matched = 'dupe';
    e.candidates = hits.map((h) => ({ date: h.date, filePath: h.filePath }));
    if (!e.candidates.some((c) => c.filePath === e.filePath)) {
      e.filePath = e.candidates[0].filePath;
    }
  }
}

async function matchAll() {
  if (!S.haveIndex || S.entries.length === 0) return;
  const codes = [...new Set(S.entries.map((e) => e.songCode).filter(Boolean))];
  const res = await api.matchCodes(codes);
  if (!res.ok) return;
  for (const e of S.entries) applyMatch(e, res.matches[e.songCode] || []);
}

// ---------- rendering ----------

function setLamp(state) {
  const labels = { standby: 'STANDBY', wait: 'WAIT', playing: 'PLAYING', fading: 'FADING' };
  el.lamp.textContent = labels[state];
  el.lamp.className = 'lamp lamp-' + state;
}

function renderLiveStrip() {
  const playing = S.entries.find((e) => e.id === S.playingId) || null;
  const next = nextPending();
  el.nowName.textContent = S.state === 'playing' || S.state === 'fading' ? (playing ? playing.name : '—') : '—';
  el.nextName.textContent = next ? next.name : '—';

  el.play.disabled = S.busy || S.state !== 'wait' || !next;
  el.skip.disabled = S.busy || S.state !== 'wait' || !next;
  el.stop.disabled = S.busy || S.state !== 'playing';
}

function statusBadge(e, next) {
  if (e.live === 'done') return '<span class="badge badge-done">Done</span>';
  if (e.live === 'skipped') return '<span class="badge badge-skipped">Skipped</span>';
  if (S.finalized) {
    if (e.id === S.playingId && (S.state === 'playing' || S.state === 'fading')) {
      return '<span class="badge badge-current">Playing</span>';
    }
    if (e === next) return '<span class="badge badge-current">Up next</span>';
    return '<span class="badge badge-ready">Ready</span>';
  }
  if (e.matched === 'missing') return '<span class="badge badge-missing">No file</span>';
  if (e.matched === 'dupe') return '<span class="badge badge-dupe">' + e.candidates.length + ' files</span>';
  return '<span class="badge badge-ready">Ready</span>';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderQueue() {
  el.queueBody.innerHTML = '';
  const next = S.finalized ? nextPending() : null;

  S.entries.forEach((e, i) => {
    const tr = document.createElement('tr');
    tr.dataset.id = e.id;
    if (e.id === S.selectedId) tr.classList.add('selected');
    if (e.live === 'done') tr.classList.add('row-done');
    if (e.live === 'skipped') tr.classList.add('row-skipped');
    if (S.finalized && e === next) tr.classList.add('row-current');

    const handle = S.finalized ? '' : '<span class="drag-handle">≡</span>';
    const trim =
      e.startSeconds !== null || e.endSeconds !== null
        ? fmtTime(e.startSeconds ?? 0) + ' → ' + fmtTime(e.endSeconds)
        : '—';

    tr.innerHTML =
      '<td>' + handle + (i + 1) + '</td>' +
      '<td>' + esc(e.name) + '</td>' +
      '<td><span class="song-title">' + esc(e.titleAndArtist || '(untitled)') + '</span>' +
      '<span class="song-code">' + esc(e.songCode) + '</span></td>' +
      '<td class="trim-cell">' + trim + '</td>' +
      '<td>' + statusBadge(e, next) + '</td>' +
      '<td class="actions-cell"></td>';

    const actions = tr.querySelector('.actions-cell');

    if (!S.finalized && e.matched === 'missing') {
      const b = document.createElement('button');
      b.textContent = 'Browse…';
      b.className = 'small';
      b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const p = await api.pickVideo();
        if (p) {
          e.filePath = p;
          e.manual = true;
          e.matched = 'ok';
          refresh();
          saveSession();
        }
      });
      actions.appendChild(b);
    }

    if (!S.finalized && e.matched === 'dupe') {
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
      sel.addEventListener('change', () => {
        e.filePath = sel.value;
        saveSession();
      });
      actions.appendChild(sel);
    }

    tr.addEventListener('click', () => selectEntry(e.id));

    if (!S.finalized) {
      tr.draggable = true;
      tr.addEventListener('dragstart', () => {
        S.dragId = e.id;
        tr.classList.add('dragging');
      });
      tr.addEventListener('dragend', () => {
        S.dragId = null;
        tr.classList.remove('dragging');
      });
      tr.addEventListener('dragover', (ev) => ev.preventDefault());
      tr.addEventListener('drop', (ev) => {
        ev.preventDefault();
        if (!S.dragId || S.dragId === e.id) return;
        const from = S.entries.findIndex((x) => x.id === S.dragId);
        const to = S.entries.findIndex((x) => x.id === e.id);
        const [moved] = S.entries.splice(from, 1);
        S.entries.splice(to, 0, moved);
        S.dragId = null;
        refresh();
        saveSession();
      });
    }

    el.queueBody.appendChild(tr);
  });

  const allMatched = S.entries.length > 0 && S.entries.every((x) => x.filePath);
  el.finalize.disabled = S.finalized || !allMatched;

  if (S.finalized) {
    el.queueHint.textContent = 'Queue is finalized. Reorder and trimming are locked; use Skip for a no-show.';
  } else if (S.entries.length === 0) {
    el.queueHint.textContent = 'Load registrants and scan the library. Every row needs a matched file before you can finalize.';
  } else {
    const missing = S.entries.filter((x) => !x.filePath).length;
    el.queueHint.textContent = missing
      ? missing + ' row(s) still need a file. Fix them with Browse, then finalize.'
      : 'All rows matched. Trim each song in the preview, reorder by dragging, then finalize.';
  }
}

function renderPreview() {
  const e = S.entries.find((x) => x.id === S.selectedId) || null;
  const locked = S.finalized;
  el.markStart.disabled = locked || !e || !e.filePath;
  el.markEnd.disabled = locked || !e || !e.filePath;
  el.clearMarks.disabled = locked || !e || (e && e.startSeconds === null && e.endSeconds === null);
  if (!e) {
    el.previewTitle.textContent = 'Click a queue row to load its video here.';
    el.marksReadout.textContent = 'Start — · End —';
    return;
  }
  el.previewTitle.textContent = e.name + ' — ' + (e.titleAndArtist || e.songCode);
  el.marksReadout.textContent = 'Start ' + fmtTime(e.startSeconds) + ' · End ' + fmtTime(e.endSeconds);
}

function refresh() {
  setLamp(S.state);
  renderQueue();
  renderLiveStrip();
  renderPreview();
}

// ---------- preview & trim ----------

async function selectEntry(id) {
  const e = S.entries.find((x) => x.id === id);
  if (!e) return;
  S.selectedId = id;
  if (e.filePath) {
    el.preview.src = await api.toFileUrl(e.filePath);
  } else {
    el.preview.removeAttribute('src');
    el.preview.load();
  }
  refresh();
}

el.markStart.addEventListener('click', () => {
  const e = S.entries.find((x) => x.id === S.selectedId);
  if (!e) return;
  const t = Math.round(el.preview.currentTime * 100) / 100;
  if (e.endSeconds !== null && t >= e.endSeconds) {
    banner('Start point must come before the end point (' + fmtTime(e.endSeconds) + ').');
    return;
  }
  e.startSeconds = t;
  refresh();
  saveSession();
});

el.markEnd.addEventListener('click', () => {
  const e = S.entries.find((x) => x.id === S.selectedId);
  if (!e) return;
  const t = Math.round(el.preview.currentTime * 100) / 100;
  if (e.startSeconds !== null && t <= e.startSeconds) {
    banner('End point must come after the start point (' + fmtTime(e.startSeconds) + ').');
    return;
  }
  e.endSeconds = t;
  refresh();
  saveSession();
});

el.clearMarks.addEventListener('click', () => {
  const e = S.entries.find((x) => x.id === S.selectedId);
  if (!e) return;
  e.startSeconds = null;
  e.endSeconds = null;
  refresh();
  saveSession();
});

// ---------- setup actions ----------

el.pickLibrary.addEventListener('click', async () => {
  const p = await api.pickFolder();
  if (!p) return;
  S.prefs = await api.setPrefs({ libraryPath: p });
  el.libraryPath.value = p;
  el.scan.disabled = false;
});

el.scan.addEventListener('click', async () => {
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
});

el.loadRegistrants.addEventListener('click', async () => {
  if (S.finalized) {
    banner('The queue is finalized. Discard the session first if you need to reload registrants.');
    return;
  }
  const url = el.sheetUrl.value.trim();
  if (!url) {
    banner('Paste the published-to-web CSV link first (Sheets: File → Share → Publish to web → CSV).');
    return;
  }
  S.prefs = await api.setPrefs({ sheetUrl: url });
  el.loadRegistrants.disabled = true;
  el.loadSummary.textContent = 'Fetching…';
  const res = await api.fetchSheet(url);
  el.loadRegistrants.disabled = false;
  if (!res.ok) {
    el.loadSummary.textContent = res.error;
    return;
  }

  // Reloading pre-finalize keeps marks and manual fixes for rows that
  // already existed, matched by timestamp + code + name.
  const old = new Map(S.entries.map((e) => [entryKey(e), e]));
  S.entries = res.rows.map((r, i) => {
    const prev = old.get(entryKey(r));
    return {
      id: entryKey(r) + '|' + i,
      timestamp: r.timestamp,
      name: r.name,
      songCode: r.songCode,
      titleAndArtist: r.titleAndArtist,
      filePath: prev ? prev.filePath : '',
      manual: prev ? prev.manual : false,
      candidates: prev ? prev.candidates : [],
      matched: prev ? prev.matched : 'missing',
      startSeconds: prev ? prev.startSeconds : null,
      endSeconds: prev ? prev.endSeconds : null,
      live: 'pending',
    };
  });
  el.loadSummary.textContent = S.entries.length + ' registrant(s) loaded.';
  await matchAll();
  refresh();
  saveSession();
});

el.pickStandby.addEventListener('click', async () => {
  const p = await api.pickImage();
  if (!p) return;
  S.prefs = await api.setPrefs({ standbyImagePath: p });
  el.standbyPath.value = p;
  if (S.state === 'standby') cmdStandby();
});

el.discard.addEventListener('click', async () => {
  if (!window.confirm('Discard this session? Registrants, trim marks, and queue order are all cleared.')) return;
  await api.clearSession();
  S.entries = [];
  S.finalized = false;
  S.state = 'standby';
  S.playingId = null;
  S.selectedId = null;
  S.busy = false;
  el.loadSummary.textContent = 'Nothing loaded yet.';
  cmdStandby();
  refresh();
});

// ---------- finalize (one-shot) ----------

el.finalize.addEventListener('click', () => {
  el.finalize.disabled = true; // locks the instant it's pressed
  S.finalized = true;
  S.state = 'wait';
  const next = nextPending();
  cmdWait(next ? next.name : '');
  refresh();
  saveSession();
});

// ---------- live controls (all one-shot) ----------

el.play.addEventListener('click', () => {
  const e = nextPending();
  if (!e || S.state !== 'wait' || S.busy) return;
  S.busy = true; // Play locks the instant it's pressed
  S.playingId = e.id;
  renderLiveStrip();
  api.playbackCmd({
    type: 'play',
    filePath: e.filePath,
    start: e.startSeconds ?? 0,
    end: e.endSeconds ?? null,
  });
});

el.skip.addEventListener('click', () => {
  const e = nextPending();
  if (!e || S.state !== 'wait' || S.busy) return;
  e.live = 'skipped';
  advanceAfterSong();
  refresh();
  saveSession();
});

el.stop.addEventListener('click', () => {
  if (S.state !== 'playing' || S.busy) return;
  // Locks the instant it's pressed and stays locked through the fade.
  // busy covers the gap before the 'fading' event lands; after that the
  // state itself keeps the button disabled.
  S.busy = true;
  renderLiveStrip();
  api.playbackCmd({ type: 'stop' });
});

function advanceAfterSong() {
  const next = nextPending();
  if (next) {
    S.state = 'wait';
    cmdWait(next.name);
  } else {
    S.state = 'standby';
    cmdStandby();
  }
}

// ---------- fade setting ----------

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
    const next = nextPending();
    cmdWait(next ? next.name : '');
  } else {
    // The playback window reloaded mid-song (or mid-start). The song
    // can't resume, so its singer stays at the top of the queue and the
    // show returns to Wait.
    S.playingId = null;
    S.busy = false;
    S.state = 'wait';
    const next = nextPending();
    cmdWait(next ? next.name : '');
    banner('The playback window reloaded mid-song. Press Play to restart it.');
    refresh();
    saveSession();
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
      refresh();
      break;
    case 'fading':
      S.state = 'fading';
      S.busy = false;
      refresh();
      break;
    case 'faded': {
      const playing = S.entries.find((e) => e.id === S.playingId);
      if (playing) playing.live = 'done';
      S.playingId = null;
      S.busy = false;
      advanceAfterSong();
      refresh();
      saveSession();
      break;
    }
    case 'error': {
      banner(evt.message + ' The singer stays queued; press Play to try again.');
      S.playingId = null;
      S.busy = false;
      S.state = 'wait';
      const next = nextPending();
      cmdWait(next ? next.name : '');
      refresh();
      break;
    }
  }
});

// ---------- init ----------

async function init() {
  S.prefs = await api.getPrefs();
  el.libraryPath.value = S.prefs.libraryPath;
  el.sheetUrl.value = S.prefs.sheetUrl;
  el.standbyPath.value = S.prefs.standbyImagePath;
  el.fadeInput.value = S.prefs.fadeDurationSeconds;
  el.scan.disabled = !S.prefs.libraryPath;

  cmdFade();
  cmdStandby();

  const session = await api.loadSession();
  if (session && Array.isArray(session.entries) && session.entries.length > 0) {
    S.entries = session.entries;
    S.finalized = !!session.finalized;
    el.loadSummary.textContent = S.entries.length + ' registrant(s) restored from the saved session.';
    if (S.finalized) {
      const next = nextPending();
      if (next) {
        S.state = 'wait';
        cmdWait(next.name);
      }
      banner('Restored a finalized session from disk. Discard it if this is a new event.');
    } else {
      banner('Restored an in-progress session from disk. Rescan the library to re-check file matches.');
    }
  }

  refresh();
}

init();
