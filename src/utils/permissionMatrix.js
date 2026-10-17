const { verifyToken } = require('../middleware/auth.middleware');

// Who may do what, read out of the routes themselves.
//
// ROLES_AND_PERMISSIONS-style tables written by hand drift. One generated from the very
// guards that decide each request cannot: what this prints is what the server enforces.
// The rules are Express's own — a `router.use(requireRole(...))` applies to the routes
// declared after it, a role list on a single route narrows it further, and two lists on
// one route both have to be satisfied, so the allowed roles are their intersection.
//
// What it cannot see is a rule written inside a controller or service (e.g. a supervisor
// may approve an order but only a superadmin may unlock a branch; "customers see only
// their own orders"). A cell marked `partial` means the role reaches only some of an
// area's routes; the route list underneath says which.

// What each mounted group of routes is, in the words the business uses. A mount this
// table does not know still appears, under its path, so a new router can never be
// silently missing from the grid.
const AREAS = {
  '/api/auth':             { label: 'Sign-in and accounts',  note: 'Anyone can sign in or register; changing your own password and profile needs sign-in.' },
  '/api/products':         { label: 'Storefront catalogue',  note: 'Public product browsing and search.' },
  '/api/orders':           { label: 'Placing & tracking orders', note: 'Guests and customers place orders; customers see their own.' },
  '/api/settings':         { label: 'Shop info (public)',    note: 'Public shop details, delivery fee and receipt settings.' },
  '/api/payments':         { label: 'M-Pesa payments',       note: 'Start a payment, and Safaricom’s callback.' },
  '/api/driver':           { label: 'Driver portal',         note: 'A driver’s own deliveries.' },
  '/api/alerts':           { label: 'Back-in-stock alerts',  note: 'Customer subscriptions.' },
  '/api/lists':            { label: 'Saved lists',           note: 'Customer favourites and re-order lists.' },
  '/api/coupons':          { label: 'Coupons (customer)',    note: 'Validate a coupon at checkout.' },
  '/api/promotions':       { label: 'Promotions (public)',   note: 'Banners and offers on the storefront.' },
  '/api/branches':         { label: 'Branches (public)',     note: 'Branch list and nearest-branch lookup.' },
  '/api/admin/orders':     { label: 'Order management',      note: 'Approve, reject, dispatch, cancel, complete.' },
  '/api/admin/payments':   { label: 'Payment confirmation',  note: 'Manually confirm or refund payments.' },
  '/api/admin/products':   { label: 'Product management',    note: 'Catalogue, pricing, images, Excel import.' },
  '/api/admin/stock':      { label: 'Stock',                 note: 'Levels, adjustments and movement log.' },
  '/api/admin/stock-intake': { label: 'Stock intake',        note: 'Raw truck arrivals before packing.' },
  '/api/admin/customers':  { label: 'Customers',             note: 'Profiles, notes, lock/unlock.' },
  '/api/admin/drivers':    { label: 'Drivers',               note: 'Driver accounts and assignments.' },
  '/api/admin/coupons':    { label: 'Coupon management',     note: 'Create and manage discount codes.' },
  '/api/admin/promotions': { label: 'Promotion management',  note: 'Storefront banners and offers.' },
  '/api/admin/broadcast':  { label: 'SMS broadcast',         note: 'Bulk promotional SMS to consenting customers.' },
  '/api/admin/reports':    { label: 'Reports',               note: 'Sales, stock and customer reports.' },
  '/api/admin/alerts':     { label: 'Admin alerts',          note: 'Dormant customers, payment failures, order spikes.' },
  '/api/admin/settings':   { label: 'Shop settings',         note: 'Per-branch configuration.' },
  '/api/admin/branches':   { label: 'Branch management',     note: 'Create, edit and deactivate branches; assign staff.' },
  '/api/admin/users':      { label: 'Staff accounts',        note: 'Create staff, change roles, lock, reset passwords.' },
  '/api/admin/logs':       { label: 'Activity log',          note: 'The audit trail.' },
  '/api/admin/backups':    { label: 'Backups',               note: 'Create, download and restore.' },
  '/api/admin/global-settings': { label: 'KRA eTIMS settings', note: 'System-wide fiscal credentials. Superadmin, or anyone granted manage_etims.' },
  '/api/admin/control-center': { label: 'Control Center',    note: 'The superadmin’s oversight and override tools.' },
};

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// `^\/api\/admin\/orders\/?(?=\/|$)` -> `/api/admin/orders`. Express 4 keeps a mount
// path only as a regexp.
function mountPathOf(layer) {
  return layer.regexp.source
    .replace('\\/?(?=\\/|$)', '')
    .replace(/^\^/, '')
    .replace(/\\\//g, '/');
}

function intersect(current, next) {
  if (!next) return current;
  if (!current) return next.slice();
  return current.filter((role) => next.includes(role));
}

// Every route the app serves, with the roles that may reach it. `roles: null` means
// "any signed-in role"; `auth: false` means no sign-in is required at all.
function collectRoutes(app) {
  const found = [];
  const stack = app._router?.stack || [];

  for (const layer of stack) {
    // A route declared straight on the app (health check, CSP report).
    if (layer.route) {
      const path = layer.route.path;
      for (const method of Object.keys(layer.route.methods)) {
        found.push({ method: method.toUpperCase(), path, mount: path, roles: null, auth: false, grantedBy: null });
      }
      continue;
    }
    if (layer.name !== 'router' || !layer.handle?.stack) continue;

    const mount = mountPathOf(layer);
    let routerRoles = null;
    let routerAuth = false;
    let routerGrant = null;

    for (const inner of layer.handle.stack) {
      if (!inner.route) {
        // router.use(...): applies to everything declared after it.
        if (inner.handle === verifyToken) routerAuth = true;
        if (inner.handle?.allowedRoles) {
          routerRoles = intersect(routerRoles, inner.handle.allowedRoles);
          routerAuth = true;
          routerGrant = inner.handle.grantedByPermission || routerGrant;
        }
        continue;
      }

      let roles = routerRoles;
      let auth = routerAuth;
      let grantedBy = routerGrant;
      for (const handler of inner.route.stack) {
        if (handler.handle === verifyToken) auth = true;
        if (handler.handle?.allowedRoles) {
          roles = intersect(roles, handler.handle.allowedRoles);
          auth = true;
          grantedBy = handler.handle.grantedByPermission || grantedBy;
        }
      }
      for (const method of Object.keys(inner.route.methods)) {
        found.push({
          method: method.toUpperCase(),
          path: mount + (inner.route.path === '/' ? '' : inner.route.path),
          mount,
          roles,
          auth,
          grantedBy,
        });
      }
    }
  }
  return found;
}

// The grid: one row per area, one cell per role, saying whether that role can read
// and/or write.
function buildPermissionMatrix(app, roles) {
  const routes = collectRoutes(app).filter((route) => !route.path.startsWith('/api/health') && !route.path.startsWith('/api/csp-report'));
  const byMount = new Map();
  for (const route of routes) {
    if (!byMount.has(route.mount)) byMount.set(route.mount, []);
    byMount.get(route.mount).push(route);
  }

  // Public routes (auth === false) are reachable by every role, signed in or not.
  const allows = (route, role) => (route.auth === false ? true : !route.roles || route.roles.includes(role));

  const areas = [...byMount.entries()].map(([mount, list]) => {
    const readable = list.filter((route) => !WRITE_METHODS.has(route.method));
    const writable = list.filter((route) => WRITE_METHODS.has(route.method));
    const cells = {};
    for (const role of roles) {
      const reads = readable.filter((route) => allows(route, role));
      const writes = writable.filter((route) => allows(route, role));
      cells[role] = {
        read: reads.length > 0,
        write: writes.length > 0,
        // Some of the routes, not all: worth a different colour because "yes" would
        // overstate it.
        partial:
          (reads.length > 0 && reads.length < readable.length) ||
          (writes.length > 0 && writes.length < writable.length),
      };
    }
    const info = AREAS[mount] || { label: mount, note: '' };
    return {
      mount,
      label: info.label,
      note: info.note,
      public: list.every((route) => route.auth === false),
      grantedBy: [...new Set(list.map((route) => route.grantedBy).filter(Boolean))],
      cells,
      routes: list.map((route) => ({
        method: route.method,
        path: route.path,
        public: route.auth === false,
        roles: route.auth === false ? null : route.roles || roles,
      })),
    };
  });

  // The order the business thinks in, not the order the app happens to mount things.
  const order = Object.keys(AREAS);
  areas.sort((a, b) => {
    const ia = order.indexOf(a.mount);
    const ib = order.indexOf(b.mount);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  return { roles, areas };
}

module.exports = { buildPermissionMatrix, collectRoutes, mountPathOf, AREAS };
