// 2026-10 audit F-03: public catalogue GETs may be shared-cached briefly; everything else is private.
process.env.NODE_ENV = 'test';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://grains-fronten.netlify.app';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const testDb = require('./helpers/testDb');
const { createBranch, createSettings, createUser } = require('./helpers/fixtures');
const app = require('../src/app');

let server; let baseUrl; let customerToken;
before(async () => {
  await testDb.connect();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testDb.disconnect();
});
beforeEach(async () => {
  await testDb.clearDatabase();
  const branch = await createBranch();
  await createSettings(branch._id);
  const c = await createUser(null, { role: 'customer', branchId: null, tokenValidAfter: new Date(Date.now() - 3600000) });
  customerToken = jwt.sign({ id: String(c._id), role: 'customer', branchId: null }, process.env.JWT_ACCESS_SECRET, { expiresIn: '5m' });
});

const cc = async (path, headers = {}) => (await fetch(`${baseUrl}${path}`, { headers })).headers.get('cache-control');

describe('Cache-Control', () => {
  test('anonymous catalogue, settings, branches and promotions GETs are shareable for a short time', async () => {
    for (const p of ['/api/products', '/api/products/categories', '/api/settings', '/api/branches', '/api/promotions']) {
      const header = await cc(p);
      assert.match(header, /public/, p);
      assert.match(header, /s-maxage=\d+/, p);
      assert.match(header, /stale-while-revalidate=\d+/, p);
    }
  });

  test('accounts, orders, payments, admin and the authenticated receipt settings are never stored', async () => {
    assert.equal(await cc('/api/auth/me', { Authorization: `Bearer ${customerToken}` }), 'no-store');
    assert.equal(await cc('/api/orders/my', { Authorization: `Bearer ${customerToken}` }), 'no-store');
    assert.equal(await cc('/api/admin/customers', { Authorization: `Bearer ${customerToken}` }), 'no-store');
    assert.equal(await cc('/api/settings/receipt', { Authorization: `Bearer ${customerToken}` }), 'no-store');
    assert.equal(await cc('/api/health'), 'no-store');
  });

  test('the public product list says nothing about cost price (the shared copy must be safe for everyone)', async () => {
    const res = await fetch(`${baseUrl}/api/products`);
    assert.ok(!(await res.text()).includes('costPriceKES'));
  });
});
