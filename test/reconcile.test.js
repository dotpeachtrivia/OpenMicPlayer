'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../renderer/reconcile.js');

// Rows shaped like player-pool's gmState().queue.
const row = (id, over = {}) => ({
  id,
  nickname: id.toUpperCase(),
  songTitle: `Song ${id}`,
  songCode: `code-${id}`,
  jpOnly: false,
  custom: false,
  state: 'queued',
  revealed: true,
  position: null,
  readyAt: null,
  requestedAt: 0,
  ...over,
});

const ok = (m, filePath) => ({ ...m, matched: 'ok', filePath });

test('merge keeps pool order, maps fields, and asks for lookups of new songs', () => {
  const gm = [row('a', { state: 'done' }), row('b', { state: 'performing', readyAt: 123 }), row('c', { jpOnly: true })];
  const { entries, media, needMatch } = R.merge(gm, {});
  assert.deepEqual(entries.map((e) => e.id), ['a', 'b', 'c']);
  assert.deepEqual(entries.map((e) => e.poolState), ['done', 'performing', 'queued']);
  assert.equal(entries[1].name, 'B');
  assert.equal(entries[1].titleAndArtist, 'Song b');
  assert.equal(entries[1].readyAt, 123);
  assert.equal(entries[2].jpOnly, true);
  assert.deepEqual(needMatch, ['a', 'b', 'c']);
  assert.equal(media.c.matched, 'unmatched');
  assert.equal(media.c.code, 'code-c');
});

test('merge carries this laptop\'s media by id, and drops rows that left the line', () => {
  const first = R.merge([row('a'), row('b')], {});
  const media = { ...first.media, a: { ...ok(first.media.a, '/v/a.mp4'), startSeconds: 12, endSeconds: 90 } };
  const second = R.merge([row('b'), row('a')], media); // the host reordered; b's lookup still pending
  assert.deepEqual(second.entries.map((e) => e.id), ['b', 'a']);
  const a = second.entries.find((e) => e.id === 'a');
  assert.equal(a.filePath, '/v/a.mp4');
  assert.equal(a.startSeconds, 12);
  assert.deepEqual(second.needMatch, ['b']); // a is matched; b still unmatched

  const third = R.merge([row('a')], second.media); // b cancelled on their phone
  assert.deepEqual(Object.keys(third.media), ['a']);
});

test('a song swap on the phone resets that singer\'s file and trims', () => {
  const first = R.merge([row('a')], {});
  const media = { a: { ...ok(first.media.a, '/v/old.mp4'), startSeconds: 5, endSeconds: 60 } };
  const swapped = R.merge([row('a', { songCode: 'new-code', songTitle: 'New song' })], media);
  const a = swapped.entries[0];
  assert.equal(a.filePath, '');
  assert.equal(a.startSeconds, null);
  assert.equal(a.endSeconds, null);
  assert.equal(a.matched, 'unmatched');
  assert.equal(swapped.media.a.code, 'new-code');
  assert.deepEqual(swapped.needMatch, ['a']);
});

test('applyMatch: one hit, none, redownloads, and a hand-picked file', () => {
  const m = R.blankMedia('x');
  assert.deepEqual(R.applyMatch(m, [{ date: '260101', filePath: '/v/x.mp4' }]).filePath, '/v/x.mp4');
  assert.equal(R.applyMatch(m, []).matched, 'missing');

  const dupe = R.applyMatch(m, [{ date: '260301', filePath: '/new.mp4' }, { date: '250101', filePath: '/old.mp4' }]);
  assert.equal(dupe.matched, 'dupe');
  assert.equal(dupe.filePath, '/new.mp4'); // newest by default
  const chose = { ...dupe, filePath: '/old.mp4' };
  assert.equal(R.applyMatch(chose, dupe.candidates.map((c) => ({ ...c }))).filePath, '/old.mp4'); // choice kept

  const manual = { ...m, manual: true, filePath: '/picked.mp4' };
  const kept = R.applyMatch(manual, []);
  assert.equal(kept.matched, 'ok');
  assert.equal(kept.filePath, '/picked.mp4');
});

function lineWithFiles(rows, files) {
  const { entries } = R.merge(rows, {});
  return entries.map((e) => (files.includes(e.id) ? { ...e, filePath: `/v/${e.id}.mp4`, matched: 'ok' } : e));
}

test('next up is the first waiting singer with a number out and a video', () => {
  const entries = lineWithFiles(
    [row('done', { state: 'done' }), row('hidden', { revealed: false }), row('nofile'), row('c'), row('d')],
    ['done', 'hidden', 'c', 'd']
  );
  assert.equal(R.nextEligible(entries).id, 'c');
  assert.deepEqual(
    R.blockedAhead(entries).map((b) => [b.id, b.reason]),
    [['hidden', 'hidden'], ['nofile', 'nofile']]
  );
  // A just-skipped singer is treated as gone before the pool confirms it.
  assert.equal(R.nextEligible(entries, ['c']).id, 'd');
  // Nobody eligible: everyone waiting is listed as blocked.
  const none = lineWithFiles([row('x', { revealed: false }), row('y')], []);
  assert.equal(R.nextEligible(none), null);
  assert.deepEqual(R.blockedAhead(none).map((b) => b.id), ['x', 'y']);
});

test('overlay: an offline show never calls the same singer twice', () => {
  // The pool hasn't heard anything since the link dropped: everyone waits.
  const entries = lineWithFiles([row('a'), row('b'), row('c')], ['a', 'b', 'c']);
  // a was called up, sang, and was finished; b was called up and skipped.
  const outbox = { a: 'done', b: 'removed' };
  const view = R.overlay(entries, outbox);
  assert.deepEqual(view.map((e) => [e.id, e.poolState, Boolean(e.pending)]), [
    ['a', 'done', true],
    ['c', 'queued', false],
  ]);
  assert.equal(R.nextEligible(view).id, 'c');
  // Without the overlay the line would offer a again.
  assert.equal(R.nextEligible(entries).id, 'a');
  // Once the pool agrees, nothing is marked pending.
  const caughtUp = lineWithFiles([row('a', { state: 'done' }), row('c')], ['a', 'c']);
  assert.equal(R.overlay(caughtUp, { a: 'done' })[0].pending, undefined);
});

test('spotForDrop gives player-pool the target\'s spot among the waiting', () => {
  const { entries } = R.merge([row('p', { state: 'performing' }), row('a'), row('b'), row('c')], {});
  assert.equal(R.spotForDrop(entries, 'c', 'a'), 1); // drag c up onto a
  assert.equal(R.spotForDrop(entries, 'a', 'c'), 3); // drag a down onto c
  assert.equal(R.spotForDrop(entries, 'a', 'a'), null);
  assert.equal(R.spotForDrop(entries, 'p', 'a'), null); // the called-up singer can't move
  assert.equal(R.spotForDrop(entries, 'a', 'p'), null);
});

test('spotForDrop matches player-pool\'s own move semantics', async () => {
  // Cross-check against the real KaraokeQueue when the sibling repo is here.
  let KaraokeQueue;
  try {
    ({ KaraokeQueue } = await import('../../player-pool/src/pool/karaoke.js'));
  } catch {
    return; // player-pool not checked out next to this repo
  }
  const k = new KaraokeQueue();
  k.setSongs([{ DateString: '260101', SongCode: 's1', TitleAndArtist: 'Song One' }]);
  k.setOpen(true);
  for (const n of ['A', 'B', 'C', 'D']) {
    k.register({ deviceToken: `dev-${n}-token`, nickname: n, songCode: 's1' });
    k.lastPost.clear();
  }
  const names = () => k.gmState().queue.filter((e) => e.state === 'queued').map((e) => e.nickname);
  const idOf = (n) => k.gmState().queue.find((e) => e.nickname === n).id;
  const drop = (from, to) => {
    const { entries } = R.merge(k.gmState().queue, {});
    k.move(idOf(from), R.spotForDrop(entries, idOf(from), idOf(to)));
  };
  drop('D', 'B'); // up: D takes B's spot
  assert.deepEqual(names(), ['A', 'D', 'B', 'C']);
  drop('A', 'B'); // down: A takes B's spot
  assert.deepEqual(names(), ['D', 'B', 'A', 'C']);
});

test('detectWipe: a restarted pool with none of the singers this laptop knew', () => {
  assert.equal(R.detectWipe([], []), false); // knew nobody
  assert.equal(R.detectWipe(['a', 'b'], []), true);
  assert.equal(R.detectWipe(['a', 'b'], [row('x')]), true); // only new sign-ups
  assert.equal(R.detectWipe(['a', 'b'], [row('b'), row('x')]), false);
  assert.equal(R.detectWipe(new Set(['a']), [row('a', { state: 'done' })]), false);
});

test('outboxReplay sends only what the pool still lacks, finishes before call-ups', () => {
  const gm = [row('a', { state: 'performing' }), row('b'), row('c', { state: 'done' }), row('d')];
  const { send, satisfied, conflicts } = R.outboxReplay(
    { a: 'done', b: 'performing', d: 'removed', gone: 'done', a2: 'removed' },
    gm
  );
  // a is still performing on the pool, so finishing a frees the stage for b.
  assert.deepEqual(send, [
    { id: 'd', desired: 'removed' },
    { id: 'a', desired: 'done' },
    { id: 'b', desired: 'performing' },
  ]);
  assert.deepEqual(satisfied.sort(), ['a2', 'gone']);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(R.outboxReplay({ a: 'performing' }, gm), { send: [], satisfied: ['a'], conflicts: [] });
});

test('outboxReplay never forces a call-up the pool overtook while offline', () => {
  // The host called up h from the console while the laptop's link was down.
  const gm = [row('h', { state: 'performing' }), row('x'), row('c', { state: 'done' })];
  const { send, conflicts } = R.outboxReplay({ x: 'performing', c: 'performing' }, gm);
  assert.deepEqual(send, []);
  assert.deepEqual(
    conflicts.map((k) => [k.id, k.reason]).sort(),
    [['c', 'already_done'], ['x', 'other_performing']]
  );
  // But finishing the laptop's own singer still goes through.
  assert.deepEqual(R.outboxReplay({ x: 'done' }, gm).send, [{ id: 'x', desired: 'done' }]);
});

test('linkUrl and clampInterval', () => {
  assert.equal(R.linkUrl('https://pool.onrender.com'), 'wss://pool.onrender.com/link');
  assert.equal(R.linkUrl('pool.onrender.com/'), 'wss://pool.onrender.com/link');
  assert.equal(R.linkUrl('http://127.0.0.1:3000/gm#x'), 'ws://127.0.0.1:3000/link');
  assert.equal(R.linkUrl('  '), '');
  assert.equal(R.clampInterval('20', 5), 20);
  assert.equal(R.clampInterval(999, 5), 120);
  assert.equal(R.clampInterval(-3, 5), 0);
  assert.equal(R.clampInterval('abc', 5), 5);
});
