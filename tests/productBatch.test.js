// 2026-10 audit F-03: the cart's price refresh asks for all its products in one request.
process.env.NODE_ENV = 'test';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://grains-fronten.netlify.app';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const testDb = require('./helpers/testDb');
const { createBranch, createSettings, createUser, createProduct } = require('./helpers/fixtures');
const app = require('../src/app');
const Product = require('../src/models/Product');

let server; let baseUrl;
before(async () => {
  await testDb.connect();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); await testDb.disconnect(); });

describe('GET /api/products/batch', () => {
  let branch; let other; let a; let b; let hidden; let foreign;
  beforeEach(async () => {
    await testDb.clearDatabase();
    require('../src/services/defaultBranch.service').invalidateDefaultBranchCache();
    branch = await createBranch({ name: 'Main', slug: 'main' });
    other = await createBranch({ name: 'Other', slug: 'other', isDefault: false });
    await createSettings(branch._id); await createSettings(other._id);
    const admin = await createUser(branch._id, { role: 'admin' });
    a = await createProduct(branch._id, admin._id, { name: 'Maize' });
    b = await createProduct(branch._id, admin._id, { name: 'Beans' });
    hidden = await createProduct(branch._id, admin._id, { name: 'Hidden', isActive: false });
    foreign = await createProduct(other._id, admin._id, { name: 'Elsewhere' });
  });

  const get = async (ids, query = '') => {
    const res = await fetch(`${baseUrl}/api/products/batch?ids=${ids.join(',')}${query}`);
    return { status: res.status, json: await res.json() };
  };

  test('returns the active products of the branch in one answer, with cost price stripped', async () => {
    const r = await get([a._id, b._id]);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data.map((p) => p.name).sort(), ['Beans', 'Maize']);
    assert.ok(!JSON.stringify(r.json).includes('costPriceKES'));
  });

  test('inactive, other-branch and malformed ids are simply absent; duplicates collapse', async () => {
    const r = await get([a._id, a._id, hidden._id, foreign._id, 'not-an-id']);
    assert.deepEqual(r.json.data.map((p) => p.name), ['Maize']);
    assert.deepEqual((await get([])).json.data, []);
    assert.equal(await Product.countDocuments(), 4);
  });

  test('another branch is selectable with ?branchId', async () => {
    const r = await get([foreign._id], `&branchId=${other._id}`);
    assert.deepEqual(r.json.data.map((p) => p.name), ['Elsewhere']);
  });
});
