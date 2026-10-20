// A tiny in-process cache for expensive, read-only results (analytical reports). Entries expire by age and the
// map is bounded, so it can never grow without limit. Per process: with several instances each keeps its own
// copy, which is fine for figures that are allowed to be a minute old.
const createTtlCache = ({ ttlMs = 60 * 1000, maxEntries = 200 } = {}) => {
  const store = new Map();

  const get = (key) => {
    const hit = store.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > hit.ttl) { store.delete(key); return undefined; }
    return hit.value;
  };

  const set = (key, value, ttl = ttlMs) => {
    if (store.size >= maxEntries) store.delete(store.keys().next().value); // oldest first
    store.set(key, { value, at: Date.now(), ttl });
    return value;
  };

  // Returns the cached value, or computes it once (concurrent callers share the same in-flight promise).
  const wrap = async (key, compute, ttl = ttlMs) => {
    const hit = get(key);
    if (hit !== undefined) return hit;
    const inflight = store.get(`pending:${key}`);
    if (inflight) return inflight.value;
    const promise = compute().then(
      (value) => { store.delete(`pending:${key}`); set(key, value, ttl); return value; },
      (err) => { store.delete(`pending:${key}`); throw err; }
    );
    store.set(`pending:${key}`, { value: promise, at: Date.now(), ttl: 0 });
    return promise;
  };

  return { get, set, wrap, clear: () => store.clear(), size: () => store.size };
};

module.exports = { createTtlCache };
