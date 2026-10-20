// 2026-10 audit (section 8, "authorization sweep"): every route that needs no sign-in is listed here on purpose.
// Adding a public route means adding it to this list - which is the moment someone has to ask "should this
// really be open to the internet?". Admin routes must be unreachable to customers and drivers.
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../src/app');
const { collectRoutes } = require('../src/utils/permissionMatrix');

const EXPECTED_PUBLIC = [
  // storefront catalogue (identical for every visitor; cost price is stripped)
  'GET /api/branches', 'GET /api/branches/:branchId/riders', 'GET /api/branches/nearest',
  'GET /api/products', 'GET /api/products/:id', 'GET /api/products/:id/best-time', 'GET /api/products/:id/price-history',
  'GET /api/products/batch', 'GET /api/products/categories', 'GET /api/products/price-changes', 'GET /api/products/suggestions',
  'GET /api/promotions', 'GET /api/settings', 'GET /api/settings/delivery-fee',
  // uptime monitor + browser CSP reports
  'GET /api/health', 'POST /api/csp-report',
  // accounts: nobody is signed in yet when these are called
  'POST /api/auth/forgot-password', 'POST /api/auth/login', 'POST /api/auth/logout', 'POST /api/auth/refresh',
  'POST /api/auth/register', 'POST /api/auth/reset-password', 'POST /api/auth/select-branch', 'POST /api/auth/verify-2fa',
  // guest checkout, tracking and payment (the guest proves ownership with order phone / reference)
  'POST /api/coupons/validate', 'POST /api/orders/guest', 'GET /api/orders/track', 'POST /api/orders/track',
  'POST /api/payments/change-method', 'POST /api/payments/mpesa/initiate',
  'GET /api/payments/status/:orderId', 'POST /api/payments/status/:orderId',
  // Safaricom calls these; authenticated by source address and/or the secret token in the URL
  'POST /api/payments/mpesa/callback', 'POST /api/payments/mpesa/callback/:token',
];

const routes = collectRoutes(app);

describe('route guards', () => {
  test('the set of routes open without signing in is exactly the reviewed list', () => {
    const actual = routes.filter((r) => r.auth === false).map((r) => `${r.method} ${r.path}`).sort();
    const unexpected = actual.filter((r) => !EXPECTED_PUBLIC.includes(r));
    const vanished = EXPECTED_PUBLIC.filter((r) => !actual.includes(r));
    assert.deepEqual(unexpected, [], `New public routes - review each one, then add it to EXPECTED_PUBLIC: ${unexpected.join(', ')}`);
    assert.deepEqual(vanished, [], `Listed as public but no longer: ${vanished.join(', ')}`);
  });

  test('every /api/admin route requires sign-in and excludes customers and drivers', () => {
    const admin = routes.filter((r) => r.path.startsWith('/api/admin'));
    assert.ok(admin.length > 80, 'the sweep found the admin routes');
    const weak = admin.filter((r) => r.auth === false || !r.roles || r.roles.includes('customer') || r.roles.includes('driver'));
    assert.deepEqual(weak.map((r) => `${r.method} ${r.path} ${JSON.stringify(r.roles)}`), []);
  });

  test('destructive and platform-wide admin areas are superadmin only', () => {
    for (const prefix of ['/api/admin/backups', '/api/admin/users', '/api/admin/control-center', '/api/admin/branches']) {
      for (const r of routes.filter((x) => x.path.startsWith(prefix) && x.method !== 'GET')) {
        assert.ok(r.roles && r.roles.length === 1 && r.roles[0] === 'superadmin', `${r.method} ${r.path} is ${JSON.stringify(r.roles)}`);
      }
    }
  });

  test('the driver portal is for drivers (and the staff who manage them) only', () => {
    for (const r of routes.filter((x) => x.path.startsWith('/api/driver'))) {
      assert.equal(r.auth, true, `${r.method} ${r.path}`);
      assert.ok(!r.roles || !r.roles.includes('customer'), `${r.method} ${r.path} must not admit customers`);
    }
  });
});
