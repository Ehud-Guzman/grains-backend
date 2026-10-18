// Bad input must produce a 4xx, never a 5xx - a 500 is an unhandled crash, shows the visitor
// "An unexpected error occurred", and fires the admin's server-error alert email.
//
// Found by firing hostile requests at every route (see SYSTEM-AUDIT notes): an array where a phone
// number belongs, an object where a coupon code belongs, ?limit=abc on a report, an invalid id in a
// URL. Also covers request-size handling and the upload-error mapping.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'a'.repeat(64);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'b'.repeat(64);
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const testDb = require('./helpers/testDb');
const { createBranch, createSettings, createUser, createProduct } = require('./helpers/fixtures');
const { errorHandler, AppError } = require('../src/middleware/errorHandler.middleware');
const { resetBranchCodeCache } = require('../src/utils/branchCode');
const { invalidateDefaultBranchCache } = require('../src/services/defaultBranch.service');

let server, base, branch, product, adminToken, sourceCounter = 0;

before(async () => {
  await testDb.connect();
  const app = require('../src/app');
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await testDb.disconnect(); });

beforeEach(async () => {
  await testDb.clearDatabase();
  resetBranchCodeCache();
  invalidateDefaultBranchCache(); // the default branch is cached for 60s; each test makes a new one
  branch = await createBranch();
  await createSettings(branch._id);
  const admin = await createUser(branch._id, { role: 'admin', phone: '0700000001' });
  product = await createProduct(branch._id, admin._id, { packaging: { stock: 100 } });
  adminToken = jwt.sign({ id: admin._id, role: 'admin', branchId: String(branch._id), customPermissions: [] },
    process.env.JWT_ACCESS_SECRET, { expiresIn: '1h', jwtid: crypto.randomUUID() });
});

// Each request gets its own source address (the app trusts one proxy hop), so the per-IP rate limits
// never interfere with what is being tested.
const call = async (method, path, { body, token, raw, headers = {} } = {}) => {
  sourceCounter += 1;
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': `10.${(sourceCounter >> 8) & 255}.${sourceCounter & 255}.7`,
      ...(token && { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json };
};

const validGuestOrder = () => ({
  name: 'Jane Wanjiru', phone: '0712345678', deliveryMethod: 'pickup', paymentMethod: 'pickup',
  orderItems: [{ productId: String(product._id), variety: 'Yellow', packaging: '50kg', quantity: 1 }],
});

describe('public order endpoint: a wrongly-typed field is a 400, not a crash', () => {
  const junk = { array: ['x'], object: { $ne: null }, number: 12345, boolean: true };
  const FIELDS = ['name', 'phone', 'email', 'deliveryAddress', 'specialInstructions', 'couponCode',
    'buyerKraPin', 'preferredDriverId', 'preferredDeliveryDate', 'branchId', 'deliveryMethod', 'paymentMethod'];

  for (const field of FIELDS) {
    test(`${field}: array / object / number / boolean`, async () => {
      for (const [kind, value] of Object.entries(junk)) {
        const { status, json } = await call('POST', '/api/orders/guest', { body: { ...validGuestOrder(), [field]: value } });
        assert.ok(status >= 400 && status < 500, `${field} as ${kind} -> ${status} ${JSON.stringify(json)}`);
      }
    });
  }

  test('the sanity case: a correct order is accepted', async () => {
    const { status, json } = await call('POST', '/api/orders/guest', { body: validGuestOrder() });
    assert.equal(status, 201, JSON.stringify(json));
    assert.match(json.data.orderRef, /^[A-Z0-9]{2,8}-\d{4}-\d{4}$/);
  });

  test('null and empty optional fields are still fine', async () => {
    const { status } = await call('POST', '/api/orders/guest', {
      body: { ...validGuestOrder(), email: null, specialInstructions: null, couponCode: '', buyerKraPin: null },
    });
    assert.equal(status, 201);
  });
});

describe('payment endpoints', () => {
  test('a phone number sent as an array is a 400', async () => {
    const orderId = new (require('mongoose').Types.ObjectId)().toString();
    const { status } = await call('POST', '/api/payments/mpesa/initiate', { body: { orderId, phone: ['0712345678'] } });
    assert.equal(status, 400);
    const second = await call('POST', '/api/payments/mpesa/initiate', { body: { orderId, phone: '0712345678', contactPhone: { a: 1 } } });
    assert.equal(second.status, 400);
  });
});

describe('coupon service', () => {
  test('a coupon code that is not text is "invalid", not a crash', async () => {
    const couponService = require('../src/services/coupon.service');
    for (const bad of [{ $ne: null }, ['A'], 123, null, undefined, '   ']) {
      await assert.rejects(
        couponService.validate(bad, branch._id, null, 1000),
        (err) => err.statusCode === 400 && err.errorCode === 'COUPON_INVALID',
        `code ${JSON.stringify(bad)}`
      );
    }
  });
});

describe('request size', () => {
  test('a login body over 10kb is refused with a plain 413', async () => {
    const { status, json } = await call('POST', '/api/auth/login', { body: { phone: '0712345678', password: 'x'.repeat(11 * 1024) } });
    assert.equal(status, 413);
    assert.equal(json.error, 'PAYLOAD_TOO_LARGE');
    assert.match(json.message, /too large/i);
  });

  test('malformed JSON is a 400 with a stable code, not the parser\'s raw message', async () => {
    const { status, json } = await call('POST', '/api/auth/login', { raw: '{"phone": ' });
    assert.equal(status, 400);
    assert.equal(json.error, 'INVALID_JSON');
  });

  test('checkout carrying a full 100-line cart is not cut off by the size limit', async () => {
    const item = { productId: String(product._id), variety: 'Yellow Maize Premium Grade', packaging: '50kg', quantity: 1 };
    const body = { ...validGuestOrder(), orderItems: Array.from({ length: 100 }, () => ({ ...item })) };
    assert.ok(JSON.stringify(body).length > 10 * 1024, 'the test payload must exceed the 10kb default');
    const { status } = await call('POST', '/api/orders/guest', { body });
    assert.notEqual(status, 413);
  });

  test('an admin can save a product with a very large variety / pack-size tree', async () => {
    const packaging = (size) => ({ size: `${size}kg`, priceKES: 1000 + size, stock: 10, lowStockThreshold: 2, quoteOnly: false,
      costPriceKES: 900, pricingTiers: [{ minQty: 10, priceKES: 950 }, { minQty: 50, priceKES: 900 }] });
    const image = 'https://res.cloudinary.com/demo/image/upload/v1/grains-shop/products/some-long-product-image-name.jpg';
    const body = {
      name: 'Bulk Maize', category: 'Cereals', description: 'd'.repeat(400),
      varieties: Array.from({ length: 8 }, (_, v) => ({
        varietyName: `Variety number ${v}`, description: 'v'.repeat(150), imageURLs: [image, image, image],
        packaging: [1, 2, 5, 10, 25, 50, 90, 100].map(packaging),
      })),
    };
    assert.ok(JSON.stringify(body).length > 10 * 1024, 'the payload must exceed the old 10kb limit');
    const { status, json } = await call('POST', '/api/admin/products', { body, token: adminToken });
    assert.equal(status, 201, JSON.stringify(json));
  });

  test('but even admin requests have a ceiling', async () => {
    const { status, json } = await call('POST', '/api/admin/products', {
      body: { name: 'x', blob: 'y'.repeat(150 * 1024) }, token: adminToken,
    });
    assert.equal(status, 413);
    assert.equal(json.error, 'PAYLOAD_TOO_LARGE');
  });
});

describe('admin report and stock queries', () => {
  test('best-sellers: a non-numeric or silly limit is clamped, not a 500', async () => {
    for (const limit of ['abc', '0', '-5', '1e9', '99999', '']) {
      const { status } = await call('GET', `/api/admin/reports/best-sellers?period=month&limit=${limit}`, { token: adminToken });
      assert.equal(status, 200, `limit=${limit}`);
    }
  });

  test('slow-movers: a non-numeric day count falls back to the default', async () => {
    const { status, json } = await call('GET', '/api/admin/reports/slow-movers?days=abc', { token: adminToken });
    assert.equal(status, 200);
    assert.equal(json.data.days, 30);
  });

  test('exporting an unknown report type is a 400', async () => {
    const { status, json } = await call('GET', '/api/admin/reports/export/not-a-report', { token: adminToken });
    assert.equal(status, 400);
    assert.equal(json.error, 'UNKNOWN_REPORT_TYPE');
  });

  test('stock history: a malformed product id or date is a 400', async () => {
    for (const path of [
      '/api/admin/stock/not-an-id/logs',
      `/api/admin/stock/${product._id}/logs?performedBy=zzz`,
      `/api/admin/stock/${product._id}/logs?from=not-a-date`,
    ]) {
      const { status } = await call('GET', path, { token: adminToken });
      assert.equal(status, 400, path);
    }
    const ok = await call('GET', `/api/admin/stock/${product._id}/logs`, { token: adminToken });
    assert.equal(ok.status, 200);
  });
});

describe('upload errors', () => {
  const run = (err) => {
    const res = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
    errorHandler(err, { requestId: 't', method: 'POST', originalUrl: '/x', user: null }, res, () => {});
    return res;
  };

  test('a file over the size limit is a 413 "file too large", not a server error', () => {
    const res = run(new multer.MulterError('LIMIT_FILE_SIZE', 'photo'));
    assert.equal(res.statusCode, 413);
    assert.equal(res.body.error, 'FILE_TOO_LARGE');
  });

  test('any other multer failure is a 400', () => {
    const res = run(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'surprise'));
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'UPLOAD_ERROR');
  });

  test('a wrong file type (thrown by the upload filters) is a 400', () => {
    const res = run(new AppError('Only JPEG, PNG, or WebP images are allowed', 400, 'INVALID_FILE_TYPE'));
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'INVALID_FILE_TYPE');
  });
});
