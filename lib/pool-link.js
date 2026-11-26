// The player's end of player-pool's "thin link": a POOL_KEY-authenticated
// WebSocket at /link that this laptop dials outbound (no ports to open at the
// venue). It carries the karaoke line in (karaoke:state, the host's view with
// every song code) and the player's commands out (call up, done, remove, move,
// reveal).
//
// The pool broadcasts every segment's traffic on this socket (trivia rounds,
// cheer ticks, roster changes…); everything that isn't karaoke is ignored.
//
// Resilience, because venue Wi-Fi and a free-tier host both misbehave:
//  - A wake-up probe (GET /healthz) before each connect: a sleeping free
//    instance takes 30-60 s to start, longer than the socket's handshake.
//  - Reconnect with backoff + jitter, the same curve as the GM console.
//  - A 401 means the key is wrong: report it and stop retrying until the
//    operator changes the settings (no hammering the pool with a bad key).
//  - A liveness timer: the pool pings every 30 s, so 75 s of silence means a
//    half-open connection (Wi-Fi dropped without a FIN). Terminate and redial.
//  - A keep-alive GET /healthz every 4.5 min while linked, so the free
//    instance never idles out (an idle-out wipes its state). Whether frames
//    on an open socket count as traffic is disputed; an HTTP request does.

'use strict';

const WebSocket = require('ws');
const { linkUrl } = require('../renderer/reconcile.js');

const DEFAULTS = {
  request: 8000, // a command's reply, same as the GM console's request()
  handshake: 30000, // venue networks are slow; the wake-up probe already ran
  wake: 75000,
  liveness: 75000,
  keepalive: 4.5 * 60 * 1000, // well inside the free tier's 15-minute idle-out
  backoffBase: 500,
  backoffMax: 15000,
  jitter: 800,
};

function linkError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const stateOf = (msg) => ({
  open: msg.open,
  songs: msg.songs,
  songsAt: msg.songsAt,
  player: msg.player || null,
  queue: Array.isArray(msg.queue) ? msg.queue : [],
});

/**
 * @param {object} opts
 * @param {string} opts.url       the pool's address, e.g. https://player-pool.onrender.com
 * @param {string} opts.key       POOL_KEY
 * @param {(gm: object) => void} opts.onState   every karaoke:state (and ok-with-queue)
 * @param {(status: string, detail: string) => void} opts.onStatus
 *        status: connecting | online | offline | auth | off
 * @param {object} [opts.timings] overrides for DEFAULTS (tests)
 * @param {Function} [opts.fetchImpl]
 */
function createPoolLink({ url, key, onState, onStatus, timings = {}, fetchImpl = globalThis.fetch }) {
  const t = { ...DEFAULTS, ...timings };
  const wsUrl = linkUrl(url);
  const httpBase = wsUrl.replace(/^ws/, 'http').replace(/\/link$/, '');

  let ws = null;
  let stopped = false;
  let authFailed = false;
  let connecting = false; // inside connect(): the wake-up probe is in flight
  let closeDetail = ''; // why the last attempt failed, shown while redialing
  let retries = 0;
  let reqSeq = 0;
  let status = 'off';
  let reconnectTimer = null;
  let livenessTimer = null;
  let keepaliveTimer = null;
  const pending = new Map(); // reqId -> { resolve, reject, timer }

  function setStatus(next, detail = '') {
    status = next;
    if (onStatus) onStatus(next, detail);
  }

  async function probe(timeoutMs) {
    try {
      await fetchImpl(httpBase + '/healthz', { signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      // Not fatal: the socket attempt that follows reports the real problem.
    }
  }

  function alive() {
    clearTimeout(livenessTimer);
    livenessTimer = setTimeout(() => {
      if (ws) ws.terminate(); // 'close' follows and schedules the redial
    }, t.liveness);
  }

  function rejectAll(err) {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  }

  function scheduleReconnect() {
    if (stopped || authFailed) return;
    const delay = Math.min(t.backoffMax, t.backoffBase * 2 ** retries) + Math.random() * t.jitter;
    retries += 1;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  }

  function handleMessage(buf) {
    alive();
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    // A reply settles its request whatever its type: the snapshot's reply is
    // karaoke:state, most others are ok, failures are error.
    if (msg.reqId && pending.has(msg.reqId)) {
      const p = pending.get(msg.reqId);
      pending.delete(msg.reqId);
      clearTimeout(p.timer);
      if (msg.type === 'error') p.reject(linkError(msg.error || 'the pool refused that', msg.code || 'pool_error'));
      else p.resolve(msg);
    }
    if (msg.type === 'karaoke:state' || (msg.type === 'ok' && Array.isArray(msg.queue))) {
      if (onState) onState(stateOf(msg));
    }
  }

  function open() {
    const sock = new WebSocket(wsUrl, {
      headers: { Authorization: 'Bearer ' + key },
      handshakeTimeout: t.handshake,
    });
    ws = sock;

    sock.on('unexpected-response', (req, res) => {
      if (res.statusCode === 401) {
        authFailed = true;
        setStatus('auth', 'player-pool refused the key. Check POOL_KEY and connect again.');
      } else {
        closeDetail = 'player-pool answered HTTP ' + res.statusCode + ' instead of opening the link.';
      }
      sock.terminate();
    });

    sock.on('open', () => {
      retries = 0;
      closeDetail = '';
      setStatus('online');
      alive();
      clearInterval(keepaliveTimer);
      keepaliveTimer = setInterval(() => probe(30000), t.keepalive);
      // Say what we are (so consoles hide their Call up / Done), then ask for
      // the line: the pool doesn't push karaoke state on connect.
      request('karaoke:hello', { role: 'player' }).catch(() => {});
      request('karaoke:snapshot').catch(() => {});
    });

    sock.on('ping', alive);
    sock.on('message', handleMessage);
    // Every failure surfaces as 'close' too; this only keeps 'error' from
    // throwing for want of a listener.
    sock.on('error', () => {});

    sock.on('close', () => {
      if (ws === sock) ws = null;
      clearTimeout(livenessTimer);
      clearInterval(keepaliveTimer);
      rejectAll(linkError('the link to player-pool closed', 'offline'));
      if (stopped) return;
      if (authFailed) return; // status already says why; wait for new settings
      setStatus('offline', closeDetail || 'Reconnecting to player-pool…');
      closeDetail = '';
      scheduleReconnect();
    });
  }

  async function connect() {
    if (stopped || authFailed || ws || connecting) return;
    connecting = true;
    try {
      setStatus('connecting', 'Waking player-pool…');
      await probe(t.wake);
    } finally {
      connecting = false;
    }
    if (stopped || authFailed || ws) return;
    setStatus('connecting', 'Opening the link…');
    open();
  }

  /** Send a command; resolves with the pool's reply, rejects with .code. */
  function request(type, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(linkError('not connected to player-pool', 'offline'));
        return;
      }
      reqSeq += 1;
      const reqId = 'omp-' + reqSeq;
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(linkError('player-pool did not answer in time', 'timeout'));
      }, t.request);
      pending.set(reqId, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...payload, type, reqId }));
    });
  }

  /** Redial now: after the laptop wakes from sleep the old socket is likely
   *  dead and the backoff timer stale. Clears a bad-key stop too. */
  function reconnectNow() {
    if (stopped) return;
    authFailed = false;
    retries = 0;
    clearTimeout(reconnectTimer);
    if (ws) ws.terminate(); // 'close' schedules a redial at the base delay
    else connect();
  }

  function close() {
    stopped = true;
    clearTimeout(reconnectTimer);
    clearTimeout(livenessTimer);
    clearInterval(keepaliveTimer);
    rejectAll(linkError('disconnected', 'offline'));
    if (ws) ws.terminate();
    ws = null;
    setStatus('off');
  }

  return {
    connect,
    request,
    reconnectNow,
    close,
    get status() {
      return status;
    },
  };
}

module.exports = { createPoolLink, DEFAULTS };
