const { AppError } = require('../middleware/errorHandler.middleware');

// Runs tasks with at most `concurrency` in flight per key (FIFO), a bounded waiting line and a maximum wait.
// Used to feed a branch's checkouts to MongoDB a few at a time instead of all at once: 40 simultaneous
// orders that all write the same product document otherwise collide, retry and collide again, and the
// unlucky ones are told to try later even though a short orderly queue would have served everyone in
// well under a second (2026-10 audit, F-05). The queue is per process; across several server instances
// MongoDB's own conflict detection plus runTransaction's retries remain the safety net.
const createKeyedLimiter = ({
  concurrency = 3,
  maxWaiting = 200,
  maxWaitMs = 10000,
  busyMessage = 'We are handling a lot of orders right now. Please try again in a moment.',
  busyCode = 'ORDER_QUEUE_BUSY',
} = {}) => {
  const state = new Map();
  const busy = () => new AppError(busyMessage, 503, busyCode);

  const acquire = (key) => new Promise((resolve, reject) => {
    let s = state.get(key);
    if (!s) { s = { active: 0, waiting: [] }; state.set(key, s); }
    if (s.active < concurrency) { s.active += 1; return resolve(s); }
    if (s.waiting.length >= maxWaiting) return reject(busy());
    const entry = { resolve: () => resolve(s) };
    entry.timer = setTimeout(() => {
      const i = s.waiting.indexOf(entry);
      if (i >= 0) s.waiting.splice(i, 1);
      reject(busy());
    }, maxWaitMs);
    s.waiting.push(entry);
  });

  const release = (key, s) => {
    const next = s.waiting.shift();
    if (next) {            // hand the slot straight to the next in line
      clearTimeout(next.timer);
      next.resolve();
      return;
    }
    s.active -= 1;
    if (s.active === 0 && s.waiting.length === 0) state.delete(key);
  };

  const run = async (key, task) => {
    const s = await acquire(String(key));
    try {
      return await task();
    } finally {
      release(String(key), s);
    }
  };
  run.stats = (key) => {
    const s = state.get(String(key));
    return { active: s?.active || 0, waiting: s?.waiting.length || 0 };
  };
  return run;
};

module.exports = { createKeyedLimiter };
