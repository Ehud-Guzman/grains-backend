// HTTP caching rules for the API (2026-10 audit, F-03).
//
// Every response used to carry no Cache-Control at all, so nothing between the browser and Render could
// reuse a shared answer: each shop page fired 8-10 API calls that cost ~1 s apiece, for data that is
// identical for every visitor (settings, branches, categories, products, promotions).
//
//   noStoreByDefault - everything under /api is private to the caller (accounts, orders, payments, admin)
//                      and must not be stored by the browser or a proxy. It runs first; a route that is
//                      safe to share then opts in with publicCache().
//   publicCache()    - for the few anonymous, per-branch GETs: shared caches may keep it for `sMaxAge`
//                      seconds and serve it stale while refreshing for `swr` more, and the browser
//                      revalidates (ETag) while showing the stale copy. Trade-off: stock badges and prices
//                      can be up to ~30-60 s old on screen. The server still checks prices and stock when an
//                      order is placed, and checkout/cart refreshes bypass the cache.
const noStoreByDefault = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

const publicCache = ({ sMaxAge = 30, swr = 120 } = {}) => (req, res, next) => {
  // Never share anything that was produced for a signed-in caller.
  if (req.method === 'GET' && !req.user) {
    res.set('Cache-Control', `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`);
  }
  next();
};

module.exports = { noStoreByDefault, publicCache };
