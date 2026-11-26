// Pure functions that turn player-pool's view of the karaoke line into the
// control panel's rows, and decide who is up next. No DOM, no IPC, no clocks:
// the control panel loads this with a <script> tag (window.Reconcile) and the
// tests require() it.
//
// Who owns what:
//   player-pool owns the line: who is in it, the order, revealed numbers, and
//   each singer's state (queued / performing / done).
//   This laptop owns the media: which video file plays for a singer, the
//   duplicate-download choice, a hand-picked file, and trim marks. Media is
//   keyed by the pool's entry id and never leaves this machine.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Reconcile = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Media for a singer whose song this laptop has not looked up yet. */
  function blankMedia(code) {
    return {
      code: code || '',
      filePath: '',
      manual: false,
      candidates: [],
      matched: 'unmatched', // unmatched | ok | missing | dupe
      startSeconds: null,
      endSeconds: null,
    };
  }

  /**
   * Merge the pool's queue rows with this laptop's media.
   * @param {Array} gmQueue  gmState().queue from player-pool, in performance order
   * @param {Object} media   id -> media (see blankMedia)
   * @returns {{ entries: Array, media: Object, needMatch: string[] }}
   *   entries  rows in pool order, pool fields plus media fields
   *   media    the media map to keep: rows that left the line are dropped, and a
   *            singer who swapped songs on their phone gets fresh media (the
   *            old file and trim marks belonged to the old song)
   *   needMatch ids whose song still has to be looked up in the library
   */
  function merge(gmQueue, media) {
    const nextMedia = {};
    const needMatch = [];
    const entries = (Array.isArray(gmQueue) ? gmQueue : []).map((row) => {
      const code = row.songCode || '';
      let m = media && media[row.id];
      if (!m || m.code !== code) {
        m = blankMedia(code);
        needMatch.push(row.id);
      } else if (m.matched === 'unmatched') {
        needMatch.push(row.id);
      }
      nextMedia[row.id] = m;
      return {
        id: row.id,
        name: row.nickname || '',
        songCode: code,
        titleAndArtist: row.songTitle || '',
        jpOnly: Boolean(row.jpOnly),
        custom: Boolean(row.custom),
        poolState: row.state, // queued | performing | done
        revealed: row.revealed !== false,
        position: row.position ?? null,
        readyAt: row.readyAt ?? null,
        filePath: m.filePath,
        manual: m.manual,
        candidates: m.candidates,
        matched: m.matched,
        startSeconds: m.startSeconds,
        endSeconds: m.endSeconds,
      };
    });
    return { entries, media: nextMedia, needMatch };
  }

  /**
   * Media after a library lookup. Same rules the player always had: a file
   * the operator picked by hand wins; one hit is a match; several hits are
   * redownloads (newest first, but an earlier choice is kept); none is missing.
   * @param {Object} m     current media
   * @param {Array} hits   [{ date, filePath }], newest first
   */
  function applyMatch(m, hits) {
    if (m.manual && m.filePath) return { ...m, matched: 'ok' };
    const list = Array.isArray(hits) ? hits : [];
    if (list.length === 0) return { ...m, matched: 'missing', filePath: '', candidates: [] };
    if (list.length === 1) return { ...m, matched: 'ok', filePath: list[0].filePath, candidates: [] };
    const candidates = list.map((h) => ({ date: h.date, filePath: h.filePath }));
    const keep = candidates.some((c) => c.filePath === m.filePath);
    return { ...m, matched: 'dupe', candidates, filePath: keep ? m.filePath : candidates[0].filePath };
  }

  /**
   * Show the line as it will be once the pool has caught up with this laptop:
   * a singer this laptop called up reads as performing, one it finished as
   * done, one it removed is gone. Without this, a show that keeps running
   * while the link is down (or detached from a wiped pool) would see the
   * last singer still waiting and call them up again.
   * @param {Array} entries merged rows
   * @param {Object} outbox id -> 'performing' | 'done' | 'removed'
   */
  function overlay(entries, outbox) {
    const out = [];
    for (const e of entries) {
      const want = outbox && outbox[e.id];
      if (want === 'removed') continue;
      out.push(want && want !== e.poolState ? { ...e, poolState: want, pending: true } : e);
    }
    return out;
  }

  const isWaiting = (e) => e.poolState === 'queued';
  const isEligible = (e, skip) => isWaiting(e) && e.revealed && Boolean(e.filePath) && !skip.has(e.id);

  /**
   * Who gets called up next: the first waiting singer whose number is out and
   * whose video is on this laptop. Someone ahead of them without a number yet
   * (a latecomer the host hasn't revealed) or without a video is passed over,
   * never called up to a stage with nothing to play.
   * @param {Array} entries
   * @param {Iterable<string>} skipIds ids to treat as gone (e.g. just skipped)
   */
  function nextEligible(entries, skipIds) {
    const skip = new Set(skipIds || []);
    return entries.find((e) => isEligible(e, skip)) || null;
  }

  /** The waiting singers ahead of the next eligible one (or all of them, when
   *  nobody is eligible), with why each is being passed over. */
  function blockedAhead(entries, skipIds) {
    const skip = new Set(skipIds || []);
    const out = [];
    for (const e of entries) {
      if (!isWaiting(e) || skip.has(e.id)) continue;
      if (isEligible(e, skip)) break;
      // A missing video is the reason that needs the operator; a number only
      // needs a reveal.
      out.push({ id: e.id, name: e.name, reason: e.filePath ? 'hidden' : 'nofile' });
    }
    return out;
  }

  /**
   * Turn a drag of one waiting row onto another into player-pool's
   * karaoke:move spot: 1-based among the waiting rows. The pool puts the
   * dragged singer exactly where the target was, up or down. Only waiting
   * rows move; anything else returns null.
   */
  function spotForDrop(entries, fromId, toId) {
    if (!fromId || !toId || fromId === toId) return null;
    const waiting = entries.filter(isWaiting);
    const from = waiting.findIndex((e) => e.id === fromId);
    const to = waiting.findIndex((e) => e.id === toId);
    if (from === -1 || to === -1) return null;
    return to + 1;
  }

  /**
   * True when the pool came back without a single singer this laptop knew:
   * a restart that lost its state (a redeploy, or the free tier idling out).
   * Only meaningful on the first snapshot after a reconnect: inside a live
   * connection, rows leave one at a time and an empty line is just an
   * empty line.
   * @param {Iterable<string>} knownIds ids in the last line this laptop accepted
   * @param {Array} gmQueue the new snapshot's queue
   */
  function detectWipe(knownIds, gmQueue) {
    const known = [...(knownIds || [])];
    if (known.length === 0) return false;
    const now = new Set((Array.isArray(gmQueue) ? gmQueue : []).map((r) => r.id));
    return !known.some((id) => now.has(id));
  }

  const ORDER = { removed: 0, done: 1, performing: 2 };

  /**
   * What the outbox still owes the pool after a reconnect. The outbox holds
   * the state this laptop wants each singer in, not a log of commands, so a
   * replay is idempotent and stale intentions drop out on their own.
   * @param {Object} outbox id -> 'performing' | 'done' | 'removed'
   * @param {Array} gmQueue the fresh snapshot's queue
   * @returns {{ send: Array<{id: string, desired: string}>, satisfied: string[],
   *             conflicts: Array<{id: string, desired: string, reason: string}> }}
   *   send       commands to replay, removals and finishes before a call-up
   *              (a call-up marks the previous singer done anyway)
   *   satisfied  ids to clear: already in the wanted state, or gone from the line
   *   conflicts  intentions the pool overtook while the link was down; they are
   *              dropped, never forced: replaying a call-up over a singer the
   *              host called meanwhile would mark that singer done unsung
   */
  function outboxReplay(outbox, gmQueue) {
    const queue = Array.isArray(gmQueue) ? gmQueue : [];
    const rows = new Map(queue.map((r) => [r.id, r]));
    const send = [];
    const satisfied = [];
    const conflicts = [];
    for (const [id, desired] of Object.entries(outbox || {})) {
      const row = rows.get(id);
      if (!row) {
        satisfied.push(id); // removed, or never existed on this pool: nothing to do
      } else if (desired === 'removed') {
        send.push({ id, desired });
      } else if (row.state === desired) {
        satisfied.push(id);
      } else if (desired === 'performing' && row.state === 'done') {
        conflicts.push({ id, desired, reason: 'already_done' }); // don't call them back up
      } else if (
        desired === 'performing' &&
        // Someone else is on stage that this replay doesn't itself finish first.
        queue.some((r) => r.state === 'performing' && r.id !== id && !['done', 'removed'].includes(outbox[r.id]))
      ) {
        conflicts.push({ id, desired, reason: 'other_performing' });
      } else {
        send.push({ id, desired });
      }
    }
    send.sort((a, b) => ORDER[a.desired] - ORDER[b.desired]);
    return { send, satisfied, conflicts };
  }

  /** Pool URL as typed by a person -> the thin link's WebSocket URL. */
  function linkUrl(poolUrl) {
    const raw = String(poolUrl || '').trim();
    if (!raw) return '';
    const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : 'https://' + raw;
    const u = new URL(withScheme);
    u.protocol = u.protocol === 'http:' || u.protocol === 'ws:' ? 'ws:' : 'wss:';
    u.pathname = '/link';
    u.search = '';
    u.hash = '';
    return u.toString();
  }

  /** Clamp the between-songs interval the way the Fade box clamps fades. */
  function clampInterval(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(120, Math.max(0, Math.round(n)));
  }

  return {
    blankMedia,
    merge,
    applyMatch,
    overlay,
    nextEligible,
    blockedAhead,
    spotForDrop,
    detectWipe,
    outboxReplay,
    linkUrl,
    clampInterval,
  };
});
