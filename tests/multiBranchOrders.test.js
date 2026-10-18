// Order references across branches.
//
// Regression for a go-live blocker: Order.orderRef is unique across ALL branches, but every branch
// counted its own orders from 1 and minted ORD-<year>-0001. The first branch to take an order owned
// that reference; every later order on any other branch failed with a duplicate-key error, and because
// the failed transaction rolled the second branch's counter back it retried the same reference forever.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const testDb = require('./helpers/testDb');
const { createBranch, createSettings, createUser, createProduct, cartItemFor } = require('./helpers/fixtures');

const orderService = require('../src/services/order.service');
const branchService = require('../src/services/branch.service');
const generateOrderRef = require('../src/utils/generateOrderRef');
const { getBranchCode, resetBranchCodeCache, candidateCodes } = require('../src/utils/branchCode');
const { currentYearEAT } = require('../src/utils/businessTime');
const Branch = require('../src/models/Branch');
const Order = require('../src/models/Order');

before(async () => { await testDb.connect(); });
after(async () => { await testDb.disconnect(); });

const setUpBranch = async (overrides, phone) => {
  const branch = await createBranch(overrides);
  await createSettings(branch._id);
  const admin = await createUser(branch._id, { role: 'admin', phone });
  const product = await createProduct(branch._id, admin._id, { packaging: { stock: 500 } });
  return { branch, product };
};

const place = (branch, product, phone, quantity = 1) => orderService.createGuestOrder({
  name: 'Jane', phone,
  orderItems: [cartItemFor(product, { quantity })],
  deliveryMethod: 'pickup', paymentMethod: 'pickup',
}, branch._id);

describe('order references across branches', () => {
  let nairobi, nakuru;

  beforeEach(async () => {
    await testDb.clearDatabase();
    resetBranchCodeCache();
    nairobi = await setUpBranch({ name: 'Nairobi', slug: 'nairobi-branch', isDefault: true }, '0700000011');
    nakuru = await setUpBranch({ name: 'Nakuru', slug: 'nakuru-branch', isDefault: false }, '0700000012');
  });

  test('every branch can place orders, each numbered from 1 under its own prefix', async () => {
    const a1 = await place(nairobi.branch, nairobi.product, '0712000001');
    const a2 = await place(nairobi.branch, nairobi.product, '0712000002');
    const b1 = await place(nakuru.branch, nakuru.product, '0712000003'); // used to fail with E11000
    const b2 = await place(nakuru.branch, nakuru.product, '0712000004');

    assert.equal(a1.orderRef, `NAI-${currentYearEAT()}-0001`);
    assert.equal(a2.orderRef, `NAI-${currentYearEAT()}-0002`);
    assert.equal(b1.orderRef, `NAK-${currentYearEAT()}-0001`);
    assert.equal(b2.orderRef, `NAK-${currentYearEAT()}-0002`);
  });

  test('two branches ordering at the same moment both succeed', async () => {
    const results = await Promise.allSettled([
      place(nairobi.branch, nairobi.product, '0712000011'),
      place(nakuru.branch, nakuru.product, '0712000012'),
      place(nairobi.branch, nairobi.product, '0712000013'),
      place(nakuru.branch, nakuru.product, '0712000014'),
    ]);
    assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'],
      JSON.stringify(results.filter(r => r.status === 'rejected').map(r => r.reason.message)));

    const refs = (await Order.find().lean()).map(o => o.orderRef);
    assert.equal(new Set(refs).size, 4, `references must be unique across branches: ${refs.join(', ')}`);
  });

  test('a reference issued before branch codes existed never collides with a new one', async () => {
    await Order.collection.insertOne({
      orderRef: `ORD-${currentYearEAT()}-0001`, branchId: nairobi.branch._id, total: 1, status: 'completed',
      orderItems: [], statusHistory: [], createdAt: new Date(), updatedAt: new Date(),
    });
    const order = await place(nairobi.branch, nairobi.product, '0712000021');
    assert.match(order.orderRef, /^NAI-\d{4}-0001$/);
  });

  test('a customer-account order uses the same scheme', async () => {
    const customer = await createUser(null, { role: 'customer', phone: '0712000031' });
    const order = await orderService.createCustomerOrder({
      orderItems: [cartItemFor(nakuru.product, { quantity: 1 })],
      deliveryMethod: 'pickup', paymentMethod: 'pickup',
    }, customer._id, nakuru.branch._id);
    assert.equal(order.orderRef, `NAK-${currentYearEAT()}-0001`);
  });

  test('a failed order gives its number back (no gaps from rejected attempts)', async () => {
    await assert.rejects(
      place(nairobi.branch, nairobi.product, '0712000041', 100000), // far more than the 500 in stock
      (err) => err.errorCode === 'STOCK_INSUFFICIENT'
    );
    const ok = await place(nairobi.branch, nairobi.product, '0712000042');
    assert.match(ok.orderRef, /-0001$/);
  });
});

describe('branch codes', () => {
  beforeEach(async () => {
    await testDb.clearDatabase();
    resetBranchCodeCache();
  });

  test('the code comes from the slug and is stored on the branch', async () => {
    const branch = await createBranch({ name: 'Nakuru', slug: 'nakuru-branch', isDefault: false });
    assert.equal(await getBranchCode(branch._id), 'NAK');
    assert.equal((await Branch.findById(branch._id).lean()).code, 'NAK');
  });

  test('the code never changes once assigned, even if the slug is edited', async () => {
    const branch = await createBranch({ name: 'Nakuru', slug: 'nakuru-branch', isDefault: false });
    assert.equal(await getBranchCode(branch._id), 'NAK');
    await Branch.updateOne({ _id: branch._id }, { slug: 'rift-valley-hub' });
    resetBranchCodeCache(); // force a re-read from the database
    assert.equal(await getBranchCode(branch._id), 'NAK');
  });

  test('two branches that want the same letters get different codes', async () => {
    const a = await createBranch({ name: 'Nairobi', slug: 'nairobi-branch', isDefault: false });
    const b = await createBranch({ name: 'Naivasha', slug: 'naivasha-branch', isDefault: false });
    const codeA = await getBranchCode(a._id);
    const codeB = await getBranchCode(b._id);
    assert.equal(codeA, 'NAI');
    assert.notEqual(codeB, codeA);
    assert.equal(codeB, 'NAIV');
  });

  test('concurrent first orders on one branch settle on a single code', async () => {
    const branch = await createBranch({ name: 'Busia', slug: 'busia-branch', isDefault: false });
    const codes = await Promise.all(Array.from({ length: 8 }, () => getBranchCode(branch._id)));
    assert.equal(new Set(codes).size, 1);
    resetBranchCodeCache();
    assert.equal(await getBranchCode(branch._id), codes[0]);
  });

  test('"ORD" and "INT" are never handed out', () => {
    assert.ok(!candidateCodes({ slug: 'ordinary-branch', name: 'Ordinary' }).includes('ORD'));
    assert.ok(!candidateCodes({ slug: 'internal-branch', name: 'Internal' }).includes('INT'));
    assert.equal(candidateCodes({ slug: 'ordinary-branch', name: 'Ordinary' })[0], 'ORDI');
  });

  test('short or odd slugs still produce valid codes', () => {
    for (const branch of [{ slug: 'kz', name: 'KZ' }, { slug: '123', name: 'Depot 7' }, { slug: '', name: '' }]) {
      const codes = candidateCodes(branch);
      assert.ok(codes.length > 0);
      for (const code of codes) assert.match(code, /^[A-Z0-9]{2,8}$/, `bad code ${code} for ${JSON.stringify(branch)}`);
    }
  });

  test('creating a branch assigns its code straight away', async () => {
    const branch = await branchService.create({ name: 'Eldoret Depot', slug: 'eldoret-depot' }, null);
    assert.equal(branch.code, 'ELD');
    assert.equal((await Branch.findById(branch._id).lean()).code, 'ELD');
  });

  test('the code cannot be edited through a branch update', async () => {
    const branch = await branchService.create({ name: 'Eldoret Depot', slug: 'eldoret-depot' }, null);
    const updated = await branchService.update(branch._id, { name: 'Eldoret Depot 2', code: 'HACK' }, null);
    assert.equal(updated.name, 'Eldoret Depot 2');
    assert.equal(updated.code, 'ELD');
  });

  test('a branch update saves and returns the edited branch', async () => {
    const branch = await branchService.create({ name: 'Kisumu', slug: 'kisumu' }, null);
    const updated = await branchService.update(branch._id, { location: 'Lakeside' }, null);
    assert.equal(updated.location, 'Lakeside');
    assert.equal((await Branch.findById(branch._id).lean()).location, 'Lakeside');
  });
});

describe('order reference year', () => {
  test('follows the Nairobi calendar, not the server clock', () => {
    // 31 Dec 21:30 UTC is already 1 Jan 00:30 in Nairobi (UTC+3).
    assert.equal(currentYearEAT(new Date('2026-12-31T21:30:00Z')), 2027);
    assert.equal(currentYearEAT(new Date('2026-12-31T20:59:59Z')), 2026);
    assert.equal(currentYearEAT(new Date('2027-01-01T00:00:00Z')), 2027);
  });

  test('the reference uses that year and a fresh counter per year', async () => {
    await testDb.clearDatabase();
    resetBranchCodeCache();
    const branch = await createBranch({ name: 'Nairobi', slug: 'nairobi-branch', isDefault: true });
    const first = await generateOrderRef(branch._id);
    const second = await generateOrderRef(branch._id);
    assert.equal(first, `NAI-${currentYearEAT()}-0001`);
    assert.equal(second, `NAI-${currentYearEAT()}-0002`);
  });
});
