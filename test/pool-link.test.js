'use strict';

// The player's link client against a fake ThinLink: same auth (Bearer key,
// raw 401 on a bad one), same reply shapes ({type:'ok', ...gmState(), reqId}),
// and the same habit of broadcasting other segments' traffic.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { createPoolLink } = require('../lib/pool-link.js');

const KEY = 'test-key-123';
const FAST = { backoffBase: 40, backoffMax: 200, jitter: 10, request: 300, wake: 2000 };

function fakePool({ key = KEY, silentAfterHello = false } = {}) {
  const state = { open: true, songs: 3, songsAt: 1, player: { linked: false, since: null }, queue: [] };
  const received = [];
  let upgrades = 0;
  let rejected = 0;
  let healthz = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      healthz += 1;
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    upgrades += 1;
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!req.url.startsWith('/link') || auth !== key) {
      rejected += 1;
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => {
    // What the real pool sends first: not karaoke, so the player ignores it.
    ws.send(JSON.stringify({ type: 'roster:snapshot', seq: 0, players: [] }));
    ws.send(JSON.stringify({ type: 'time', now: Date.now() }));
    ws.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      received.push(msg);
      const reply = (payload) => ws.send(JSON.stringify({ ...payload, reqId: msg.reqId }));
      switch (msg.type) {
        case 'karaoke:snapshot':
          reply({ type: 'karaoke:state', ...state });
          break;
        case 'karaoke:hello':
          if (msg.role === 'player') state.player = { linked: true, since: 1 };
          if (!silentAfterHello) reply({ type: 'ok', ...state });
          break;
        case 'karaoke:slow':
          break; // never answers
        case 'karaoke:bad':
          reply({ type: 'error', error: 'unknown queue entry: x', code: 'bad_entry' });
          break;
        default:
          reply({ type: 'ok', ...state });
      }
    });
  });
  return {
    state,
    received,
    get upgrades() {
      return upgrades;
    },
    get rejected() {
      return rejected;
    },
    get healthz() {
      return healthz;
    },
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
    broadcast(msg) {
      for (const c of wss.clients) c.send(JSON.stringify(msg));
    },
    dropAll() {
      for (const c of wss.clients) c.terminate();
    },
    clients: () => wss.clients.size,
    close: () =>
      new Promise((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => r());
      }),
  };
}

const waitFor = async (cond, ms = 3000, label = 'condition') => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + label);
    await new Promise((r) => setTimeout(r, 10));
  }
};

function recorder() {
  const states = [];
  const statuses = [];
  return {
    states,
    statuses,
    onState: (gm) => states.push(gm),
    onStatus: (s, d) => statuses.push([s, d]),
    last: () => statuses[statuses.length - 1]?.[0],
  };
}

test('wakes the pool, links, says hello as the player, and asks for the line', async () => {
  const pool = fakePool();
  const url = await pool.listen();
  pool.state.queue = [{ id: 'e1', nickname: 'Gio', songCode: 'abc', state: 'queued', revealed: false }];
  const rec = recorder();
  const link = createPoolLink({ url, key: KEY, ...rec, timings: FAST });
  try {
    await link.connect();
    await waitFor(() => rec.states.length >= 2, 3000, 'hello + snapshot states');
    assert.ok(pool.healthz >= 1, 'probed /healthz before dialing');
    assert.deepEqual(pool.received.slice(0, 2).map((m) => m.type), ['karaoke:hello', 'karaoke:snapshot']);
    assert.equal(pool.received[0].role, 'player');
    assert.equal(rec.states.at(-1).queue[0].songCode, 'abc');
    assert.equal(rec.states.at(-1).player.linked, true);
    assert.deepEqual(rec.statuses.map((s) => s[0]).slice(0, 3), ['connecting', 'connecting', 'online']);
    // Other segments' traffic never surfaces as karaoke state.
    const before = rec.states.length;
    pool.broadcast({ type: 'cheer:state', cheer: {} });
    pool.broadcast({ type: 'karaoke:state', ...pool.state, queue: [] });
    await waitFor(() => rec.states.length === before + 1, 2000, 'broadcast state');
    assert.deepEqual(rec.states.at(-1).queue, []);
  } finally {
    link.close();
    await pool.close();
  }
});

test('requests: replies by reqId, errors carry the pool\'s code, silence times out', async () => {
  const pool = fakePool();
  const url = await pool.listen();
  const rec = recorder();
  const link = createPoolLink({ url, key: KEY, ...rec, timings: FAST });
  try {
    await link.connect();
    await waitFor(() => link.status === 'online');
    const okReply = await link.request('karaoke:performing', { id: 'e1', readySeconds: 20 });
    assert.equal(okReply.type, 'ok');
    const sent = pool.received.find((m) => m.type === 'karaoke:performing');
    assert.deepEqual([sent.id, sent.readySeconds], ['e1', 20]);
    await assert.rejects(link.request('karaoke:bad', { id: 'x' }), { code: 'bad_entry' });
    await assert.rejects(link.request('karaoke:slow'), { code: 'timeout' });
  } finally {
    link.close();
    await pool.close();
  }
  await assert.rejects(link.request('karaoke:done', { id: 'e1' }), { code: 'offline' });
});

test('redials after the connection drops, and says hello again', async () => {
  const pool = fakePool();
  const url = await pool.listen();
  const rec = recorder();
  const link = createPoolLink({ url, key: KEY, ...rec, timings: FAST });
  try {
    await link.connect();
    await waitFor(() => link.status === 'online');
    pool.dropAll();
    await waitFor(() => rec.statuses.some((s) => s[0] === 'offline'), 2000, 'offline');
    await waitFor(() => link.status === 'online' && pool.upgrades >= 2, 3000, 'second link');
    await waitFor(() => pool.received.filter((m) => m.type === 'karaoke:hello').length >= 2, 2000, 'second hello');
  } finally {
    link.close();
    await pool.close();
  }
});

test('a wrong key reports auth and stops dialing', async () => {
  const pool = fakePool();
  const url = await pool.listen();
  const rec = recorder();
  const link = createPoolLink({ url, key: 'wrong-key', ...rec, timings: FAST });
  try {
    await link.connect();
    await waitFor(() => link.status === 'auth', 2000, 'auth status');
    assert.match(rec.statuses.at(-1)[1], /refused the key/);
    await new Promise((r) => setTimeout(r, 500)); // several backoff periods
    assert.equal(pool.upgrades, 1, 'no retry storm with a bad key');
    assert.equal(link.status, 'auth');
  } finally {
    link.close();
    await pool.close();
  }
});

test('a silent half-open link is torn down and redialed', async () => {
  const pool = fakePool({ silentAfterHello: true });
  const url = await pool.listen();
  const rec = recorder();
  const link = createPoolLink({ url, key: KEY, ...rec, timings: { ...FAST, liveness: 250 } });
  try {
    await link.connect();
    // The snapshot reply is the last thing the fake ever sends; no pings.
    await waitFor(() => pool.upgrades >= 2, 3000, 'redial after silence');
  } finally {
    link.close();
    await pool.close();
  }
});

test('close() stops for good, even mid-backoff', async () => {
  const pool = fakePool();
  const url = await pool.listen();
  const rec = recorder();
  const link = createPoolLink({ url, key: KEY, ...rec, timings: FAST });
  await link.connect();
  await waitFor(() => link.status === 'online');
  pool.dropAll();
  await waitFor(() => link.status === 'offline');
  link.close();
  const ups = pool.upgrades;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(pool.upgrades, ups, 'no redial after close()');
  assert.equal(link.status, 'off');
  await pool.close();
});

test('an unreachable pool keeps retrying with backoff, never throwing', async () => {
  const pool = fakePool();
  const url = await pool.listen();
  await pool.close(); // nothing listening on that port now
  const rec = recorder();
  const link = createPoolLink({ url, key: KEY, ...rec, timings: { ...FAST, wake: 200 } });
  try {
    await link.connect();
    await waitFor(() => rec.statuses.filter((s) => s[0] === 'offline').length >= 2, 4000, 'two failed attempts');
  } finally {
    link.close();
  }
});
