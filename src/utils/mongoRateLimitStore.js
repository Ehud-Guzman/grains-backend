const mongoose = require('mongoose');
const logger = require('./logger');

// An express-rate-limit store that keeps its counters in MongoDB instead of process memory.
//
// With ONE server process the default in-memory store is right (no extra database traffic). With two or more
// (Render scale-out, PM2 cluster) each process counts separately, so every limit silently multiplies - the
// login cap of 10/min becomes 20/min across two instances. Set RATE_LIMIT_STORE=mongo to share the counters
// (2026-10 audit, F-12). Cost: one small database write per rate-limited request.
//
// One atomic upsert per hit: if the window has expired the count restarts at 1, otherwise it increments.
// Expired rows are removed by a TTL index. If the database is unreachable the limiter fails OPEN (the
// request is allowed) - an unreachable database already means the API cannot do real work.
class MongoRateLimitStore {
  constructor(prefix) {
    this.prefix = prefix;
    this.localKeys = false;
    this.windowMs = 60 * 1000;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  get collection() {
    return mongoose.connection.collection('ratelimits');
  }

  id(key) { return `${this.prefix}:${key}`; }

  async increment(key) {
    const now = new Date();
    const resetTime = new Date(now.getTime() + this.windowMs);
    try {
      const live = { $gt: [{ $ifNull: ['$resetAt', new Date(0)] }, now] };
      const doc = await this.collection.findOneAndUpdate(
        { _id: this.id(key) },
        [{
          $set: {
            count: { $cond: [live, { $add: [{ $ifNull: ['$count', 0] }, 1] }, 1] },
            resetAt: { $cond: [live, '$resetAt', resetTime] },
          },
        }],
        { upsert: true, returnDocument: 'after' }
      );
      const row = doc?.value || doc; // driver 5 returns the document, older drivers { value }
      return { totalHits: row.count, resetTime: row.resetAt };
    } catch (err) {
      logger.warn('[rate-limit] Mongo store unavailable - allowing request', { err: err.message });
      return { totalHits: 1, resetTime };
    }
  }

  async decrement(key) {
    try { await this.collection.updateOne({ _id: this.id(key), count: { $gt: 0 } }, { $inc: { count: -1 } }); } catch { /* best effort */ }
  }

  async resetKey(key) {
    try { await this.collection.deleteOne({ _id: this.id(key) }); } catch { /* best effort */ }
  }
}

let indexReady = false;
const ensureIndex = () => {
  if (indexReady) return;
  indexReady = true;
  mongoose.connection.collection('ratelimits').createIndex({ resetAt: 1 }, { expireAfterSeconds: 60 }).catch(() => { indexReady = false; });
};

// `{ store }` to spread into a rateLimit({...}) config, or {} to keep the default in-memory store.
const storeOption = (prefix) => {
  if (process.env.RATE_LIMIT_STORE !== 'mongo') return {};
  if (mongoose.connection.readyState === 1) ensureIndex();
  else mongoose.connection.once('connected', ensureIndex);
  return { store: new MongoRateLimitStore(prefix) };
};

module.exports = { MongoRateLimitStore, storeOption };
