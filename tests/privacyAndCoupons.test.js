// 2026-10 audit F-14 (personal data in URLs) and F-32 (coupon code oracle).
process.env.NODE_ENV = 'test';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://grains-fronten.netlify.app';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const testDb = require('./helpers/testDb');
const { createBranch, createSettings, createUser } = require('./helpers/fixtures');
const app = require('../src/app');
const Coupon = require('../src/models/Coupon');
const { redactUrl, redactQuery } = require('../src/utils/redactUrl');

describe('redactUrl', () => {
  test('hides phone, coordinates, search and order ref values but keeps harmless parameters', () => {
    assert.equal(
      redactUrl('/api/orders/track?phone=0712345678&ref=NAI-2026-0001&limit=5'),
      '/api/orders/track?phone=[redacted]&ref=[redacted]&limit=5'
    );
    assert.equal(redactUrl('/api/branches/nearest?lat=-1.28&lng=36.8'), '/api/branches/nearest?lat=[redacted]&lng=[redacted]');
    assert.equal(redactUrl('/api/products?search=maize&page=2'), '/api/products?search=[redacted]&page=2');
    assert.equal(redactUrl('/api/products?Phone=07123'), '/api/products?Phone=[redacted]', 'case-insensitive keys');
  });
  test('leaves URLs without a query string, and non-strings, alone', () => {
    assert.equal(redactUrl('/api/health'), '/api/health');
    assert.equal(redactUrl(undefined), undefined);
  });
  test('a malformed escape never leaks the query', () => {
    const out = redactUrl('/x?phone=%E0%A4%A&other=1');
    assert.ok(!out.includes('%E0'));
  });
  test('redactQuery works on a bare query string (Sentry query_string)', () => {
    assert.equal(redactQuery('phone=0712&x=1'), 'phone=[redacted]&x=1');
  });
});

describe('HTTP behaviour', () => {
  let server; let baseUrl; let branch;
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
    branch = await createBranch();
    await createSettings(branch._id);
  });

  const post = async (url, body) => {
    const res = await fetch(`${baseUrl}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  test('order tracking and payment status accept the phone in a POST body (F-14)', async () => {
    const track = await post('/api/orders/track', { phone: '0712345678', ref: 'NAI-2026-9999' });
    assert.notEqual(track.json?.error, 'MISSING_PARAMS', 'body parameters must be read');
    assert.ok([404, 400].includes(track.status));

    const missing = await post('/api/orders/track', {});
    assert.equal(missing.json.error, 'MISSING_PARAMS');

    const pay = await post('/api/payments/status/6ad71b078aa386a0238963b4', { phone: '0712345678' });
    // Reaching the service (which says the order does not exist) proves the POST route is wired up.
    assert.equal(pay.json?.error, 'ORDER_NOT_FOUND', `got ${pay.status} ${JSON.stringify(pay.json)}`);
  });

  test('a dead coupon looks identical whether it never existed, expired, was used up or belongs to someone else (F-32)', async () => {
    const admin = await createUser(branch._id, { role: 'admin' });
    const someoneElse = await createUser(null, { role: 'customer', branchId: null });
    const base = { branchId: branch._id, createdBy: admin._id, discountType: 'fixed', discountValue: 100 };
    await Coupon.create({ ...base, code: 'LIVE10' });
    await Coupon.create({ ...base, code: 'OLD', expiresAt: new Date(Date.now() - 5 * 86400000) });
    await Coupon.create({ ...base, code: 'USEDUP', usageLimit: 1, usedCount: 1 });
    await Coupon.create({ ...base, code: 'MINE', assignedTo: someoneElse._id });
    await Coupon.create({ ...base, code: 'BIG', minOrderValue: 100000 });

    const ask = (code) => post('/api/coupons/validate', { code, subtotal: 1000, branchId: String(branch._id) });
    const answers = await Promise.all(['NOPE', 'OLD', 'USEDUP', 'MINE'].map(ask));
    for (const a of answers) {
      assert.equal(a.status, 400);
      assert.equal(a.json.error, 'COUPON_INVALID');
      assert.equal(a.json.message, answers[0].json.message, 'same wording for every dead code');
    }
    const live = await ask('LIVE10');
    assert.equal(live.status, 200);
    // A code that exists and is usable but not for this basket keeps its helpful, specific answer.
    const big = await ask('BIG');
    assert.equal(big.json.error, 'COUPON_MIN_NOT_MET');
  });

  test('coupon checks are capped per IP (F-32)', async () => {
    let limited = null;
    for (let i = 0; i < 25 && !limited; i++) {
      const r = await post('/api/coupons/validate', { code: `GUESS${i}`, subtotal: 1000, branchId: String(branch._id) });
      if (r.status === 429) limited = r;
    }
    assert.ok(limited, 'should have been rate limited within 25 attempts');
    assert.equal(limited.json.error, 'RATE_LIMIT_EXCEEDED');
  });
});
