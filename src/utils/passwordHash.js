// Password and one-time-code hashing.
//
// 2026-10 audit (F-07): bcryptjs is pure JavaScript. One cost-12 hash is ~400 ms of CPU, and a burst of logins
// (staff arriving, an SMS broadcast, an attacker) left a trivial public endpoint at 20 req/s instead of ~1,000
// because every concurrent hash competed for the one event loop. Three layers here, best first:
//   1. If the native `bcrypt` package happens to be installed it is used (libuv threadpool, never blocks the
//      loop). It is optional and NOT installed today; the hashes are interchangeable ($2a/$2b).
//   2. Otherwise bcryptjs runs inside a small pool of worker threads (BCRYPT_WORKERS, default 1) so the main
//      thread stays responsive; a login burst queues for the worker instead of freezing the API.
//   3. If worker threads cannot be used, bcryptjs runs in-thread behind a concurrency cap (BCRYPT_MAX_CONCURRENT).
// One-time codes (6 digits, 10 minutes) are NOT bcrypted: a short numeric secret behind a slow hash is still
// crackable offline in minutes, so the hash was both costly and ineffective. They use an HMAC keyed with a
// server secret instead, which is cheap and useless to anyone who only has a copy of the database.
const path = require('path');
const crypto = require('crypto');
const bcryptjs = require('bcryptjs');
const { AUTH_LIMITS } = require('./constants');

let native = null;
try { native = require('bcrypt'); } catch { /* optional */ }

const MAX_CONCURRENT = Number(process.env.BCRYPT_MAX_CONCURRENT) || 2;
const WORKERS = process.env.BCRYPT_WORKERS === undefined || process.env.BCRYPT_WORKERS === ''
  ? 1
  : Math.max(0, Number(process.env.BCRYPT_WORKERS) || 0);
const IDLE_CLOSE_MS = 5 * 60 * 1000;

// ── in-thread, capped (native bcrypt, or the last-resort bcryptjs path) ───────
let running = 0;
const waiting = [];
const limited = async (fn) => {
  if (running >= MAX_CONCURRENT) {
    await new Promise((resolve) => waiting.push(resolve));
  }
  running += 1;
  try {
    return await fn();
  } finally {
    running -= 1;
    const next = waiting.shift();
    if (next) next();
  }
};

// ── worker pool ───────────────────────────────────────────────────────────────
let Worker = null;
try { ({ Worker } = require('worker_threads')); } catch { /* not available */ }
let pool = [];
const queue = [];
let jobSeq = 0;
let workersBroken = false;

const pump = () => {
  while (queue.length) {
    let w = pool.find((x) => !x.busy);
    if (!w && pool.length < WORKERS) w = spawn();
    if (!w) return;
    const job = queue.shift();
    w.busy = job;
    w.worker.ref();                       // a hash in flight must keep a short-lived script alive...
    w.worker.postMessage({ id: job.id, op: job.op, a: job.a, b: job.b });
  }
};

const spawn = () => {
  const w = { worker: new Worker(path.join(__dirname, 'hashWorker.js')), busy: null, lastUsed: Date.now() };
  const fail = (err) => {
    const job = w.busy;
    w.busy = null;
    pool = pool.filter((x) => x !== w);
    if (job) job.reject(err);
    pump();
  };
  w.worker.on('message', ({ id, result, error }) => {
    const job = w.busy;
    if (!job || job.id !== id) return;
    w.busy = null;
    w.worker.unref();                     // ...but an idle worker must never keep the process alive
    w.lastUsed = Date.now();
    if (error) job.reject(new Error(error)); else job.resolve(result);
    pump();
  });
  w.worker.on('error', fail);
  w.worker.on('exit', () => { if (pool.includes(w)) fail(new Error('hash worker exited')); });
  // After the listeners: attaching a 'message' listener re-references the worker, which undoes an earlier unref().
  w.worker.unref();
  pool.push(w);
  return w;
};

// Give idle workers back (each costs tens of MB, which matters on a 512 MB instance).
setInterval(() => {
  const cutoff = Date.now() - IDLE_CLOSE_MS;
  for (const w of [...pool]) {
    if (!w.busy && w.lastUsed < cutoff && queue.length === 0) {
      pool = pool.filter((x) => x !== w);
      w.worker.terminate().catch(() => {});
    }
  }
}, 60 * 1000).unref();

const viaWorker = (op, a, b) => new Promise((resolve, reject) => {
  queue.push({ id: ++jobSeq, op, a, b, resolve, reject });
  pump();
});

const compute = (op, a, b) => {
  if (native) return limited(() => (op === 'hash' ? native.hash(a, b) : native.compare(a, b)));
  if (Worker && WORKERS > 0 && !workersBroken) {
    return viaWorker(op, a, b).catch((err) => {
      // The worker itself failed (could not start / crashed): finish this one in-thread and stop trying.
      if (/worker/i.test(err.message)) {
        workersBroken = true;
        return limited(() => (op === 'hash' ? bcryptjs.hash(a, b) : bcryptjs.compare(a, b)));
      }
      throw err;
    });
  }
  return limited(() => (op === 'hash' ? bcryptjs.hash(a, b) : bcryptjs.compare(a, b)));
};

const hashPassword = (plain, rounds = AUTH_LIMITS.BCRYPT_WORK_FACTOR) => compute('hash', plain, rounds);

const comparePassword = (plain, hash) => {
  if (typeof plain !== 'string' || typeof hash !== 'string' || !hash) return Promise.resolve(false);
  return compute('compare', plain, hash);
};

// ── One-time codes ────────────────────────────────────────────────────────────
const OTP_PREFIX = 'h1$';

const otpKey = () => {
  const secret = process.env.OTP_HMAC_SECRET || process.env.JWT_REFRESH_SECRET || process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error('A JWT secret (or OTP_HMAC_SECRET) is required to hash one-time codes');
  return crypto.createHmac('sha256', secret).update('vittorios:otp:v1').digest();
};

// `scope` binds a code to one person and purpose, so a code is never valid for another user or flow.
const otpDigest = (scope, otp) =>
  crypto.createHmac('sha256', otpKey()).update(`${scope}\u0000${otp}`).digest('hex');

const hashOtp = (scope, otp) => `${OTP_PREFIX}${otpDigest(scope, String(otp))}`;

// Accepts codes stored by the previous implementation (a bcrypt hash) so a code issued just before a deploy
// still works for its remaining few minutes.
const verifyOtp = async (scope, otp, stored) => {
  if (typeof otp !== 'string' || typeof stored !== 'string' || !stored) return false;
  if (stored.startsWith(OTP_PREFIX)) {
    const a = Buffer.from(stored.slice(OTP_PREFIX.length), 'hex');
    const b = Buffer.from(otpDigest(scope, otp), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return comparePassword(otp, stored);
};

module.exports = {
  hashPassword,
  comparePassword,
  hashOtp,
  verifyOtp,
  isNative: () => !!native,
  // For tests/diagnostics: how many hashes are being computed and how many are queued.
  _state: () => (native || !Worker || WORKERS === 0 || workersBroken
    ? { mode: native ? 'native' : 'in-thread', running, waiting: waiting.length, max: MAX_CONCURRENT }
    : { mode: 'worker', running: pool.filter((w) => w.busy).length, waiting: queue.length, max: WORKERS }),
  _shutdown: async () => { await Promise.all(pool.map((w) => w.worker.terminate())); pool = []; },
};
