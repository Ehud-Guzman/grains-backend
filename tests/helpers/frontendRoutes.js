const fs = require('fs');
const path = require('path');

// The pages the React app serves and who may open each, read from App.jsx — so a test can
// check that a "Take me there" link from the help assistant never lands on a page that then
// bounces the person. The API guards and the route guards are written separately; this is
// what ties them together.
//
// Returns null when the frontend is not checked out next to the backend.
//
//   Map<'/admin/orders', { roles: ['staff', ...] | null, permission: boolean }>
//   roles === null means anyone (a public page).

const APP_FILE = path.join(__dirname, '../../../vittoriosfrontend/src/App.jsx');

function readFrontendPages() {
  if (!fs.existsSync(APP_FILE)) return null;
  const source = fs.readFileSync(APP_FILE, 'utf8');

  // const ADMIN_ROLES = ["staff", ...]
  const groups = {};
  for (const [, name, list] of source.matchAll(/const (\w+)\s*=\s*\[([^\]]*)\]/g)) {
    groups[name] = [...list.matchAll(/"(\w+)"/g)].map((m) => m[1]);
  }
  const rolesOf = (expr) => {
    if (!expr) return undefined;
    if (expr.startsWith('[')) return [...expr.matchAll(/"(\w+)"/g)].map((m) => m[1]);
    return groups[expr];
  };

  // The app is laid out as public/auth routes, then the driver portal, then the admin panel.
  const driverAt = source.indexOf('DRIVER PORTAL');
  const adminAt = source.indexOf('{/* ── ADMIN');
  if (driverAt < 0 || adminAt < 0) throw new Error('App.jsx layout changed: cannot find the driver/admin sections');
  const sections = [
    { text: source.slice(0, driverAt), prefix: '', parent: null },
    { text: source.slice(driverAt, adminAt), prefix: '/driver', parent: '/driver' },
    { text: source.slice(adminAt), prefix: '/admin', parent: '/admin' },
  ];

  const pages = new Map();
  for (const { text, prefix, parent } of sections) {
    const starts = [...text.matchAll(/<Route\s+path="([^"]+)"/g)];
    let parentRoles; // a layout route's role list applies to every page inside it
    starts.forEach((match, i) => {
      const routePath = match[1];
      if (routePath === '*') return;
      const chunk = text.slice(match.index, i + 1 < starts.length ? starts[i + 1].index : text.length);
      const guard = chunk.match(/requireRole=\{(\w+|\[[^\]]*\])\}/);
      const own = rolesOf(guard && guard[1]);
      const permission = /requirePermission=/.test(chunk);

      const absolute = routePath.startsWith('/') ? routePath : `${prefix}/${routePath}`;
      if (parent && absolute === parent) {
        parentRoles = own;
        return;
      }
      pages.set(absolute, { roles: own !== undefined ? own : (parent ? parentRoles : null) ?? null, permission });
    });
  }
  return pages;
}

module.exports = { readFrontendPages };
