// 2026-10 audit F-05 / F-06 / F-36 / F-32: order placement under load, after a stuck transaction, the
// double-submit guard's precision, and the per-customer coupon cap under concurrency.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const testDb = require('./helpers/testDb');
const { createBranch, createSettings, createUser, createProduct, cartItemFor } = require('./helpers/fixtures');
const orderService = require('../src/services/order.service');
const couponService = require('../src/services/coupon.service');
const { createKeyedLimiter } = require('../src/utils/keyedLimiter');
const { resetBranchCodeCache } = require('../src/utils/branchCode');
const Order = require('../src/models/Order');
const Product = require('../src/models/Product');

before(async () => { await testDb.connect(); });
after(async () => { await testDb.disconnect(); });

const stockOf = async (product) => (await Product.findById(product._id).lean()).varieties[0].packaging[0].stock;
const phone = (i) => `07${String(20000000 + i)}`;

describe('keyedLimiter', () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  test('never runs more than `concurrency` tasks per key, serves in order, and keys are independent', async () => {
    const run = createKeyedLimiter({ concurrency: 2 });
    let active = 0; let peak = 0; const order = [];
    const task = (name) => run('k', async () => {
      active += 1; peak = Math.max(peak, active); order.push(name);
      await sleep(15); active -= 1;
    });
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map(task));
    assert.equal(peak, 2);
    assert.deepEqual(order, ['a', 'b', 'c', 'd', 'e']);

    let other = 0;
    const slow = run('x', () => sleep(40));
    await run('y', async () => { other += 1; });
    assert.equal(other, 1, 'another key is not held up');
    await slow;
  });

  test('a task that throws still frees its slot', async () => {
    const run = createKeyedLimiter({ concurrency: 1 });
    await assert.rejects(run('k', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await run('k', async () => 'fine'), 'fine');
    assert.deepEqual(run.stats('k'), { active: 0, waiting: 0 });
  });

  test('a full line, or a wait that is too long, is a clean 503', async () => {
    const run = createKeyedLimiter({ concurrency: 1, maxWaiting: 1, maxWaitMs: 30 });
    const hold = run('k', () => sleep(120));
    const waiter = run('k', async () => 'late');
    await assert.rejects(run('k', async () => 'overflow'), (e) => e.statusCode === 503 && e.errorCode === 'ORDER_QUEUE_BUSY');
    await assert.rejects(waiter, (e) => e.statusCode === 503);
    await hold;
  });
});

describe('order placement', () => {
  let branch; let admin; let product;
  beforeEach(async () => {
    await testDb.clearDatabase();
    resetBranchCodeCache();
    branch = await createBranch();
    await createSettings(branch._id);
    admin = await createUser(branch._id, { role: 'admin' });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 1000 } });
  });

  const guestOrder = (i, p = product, quantity = 1) => orderService.createGuestOrder({
    name: `Guest ${i}`, phone: phone(i),
    orderItems: [cartItemFor(p, { quantity })],
    deliveryMethod: 'pickup', paymentMethod: 'pickup',
  }, branch._id);

  test('a burst of 40 simultaneous checkouts for the SAME product all succeed with unique references (F-05)', async () => {
    const results = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => guestOrder(i)));
    const failed = results.filter((r) => r.status === 'rejected').map((r) => `${r.reason.errorCode}: ${r.reason.message}`);
    assert.deepEqual(failed, [], 'every customer in the burst gets an order');
    const refs = (await Order.find().select('orderRef').lean()).map((o) => o.orderRef);
    assert.equal(new Set(refs).size, 40, 'references are unique');
    assert.equal(await stockOf(product), 960, 'stock reserved exactly once per order');
  });

  test('a burst across different products also all succeed', async () => {
    const products = await Promise.all(Array.from({ length: 5 }, () => createProduct(branch._id, admin._id, { packaging: { stock: 1000 } })));
    const results = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => guestOrder(100 + i, products[i % 5])));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 40);
  });

  test('two different baskets with the same total and line count are NOT treated as a double-click (F-36)', async () => {
    const other = await createProduct(branch._id, admin._id, { name: 'Test Beans', packaging: { stock: 100 } });
    const results = await Promise.allSettled([guestOrder(1, product), guestOrder(1, other)]); // same guest, same price, 1 line
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
  });

  test('a real double-click is still refused, and does not burn an order number', async () => {
    const [a, b] = await Promise.allSettled([guestOrder(7), guestOrder(7)]);
    const winner = [a, b].find((r) => r.status === 'fulfilled');
    const loser = [a, b].find((r) => r.status === 'rejected');
    assert.ok(winner && loser);
    assert.equal(loser.reason.errorCode, 'DUPLICATE_SUBMISSION');
    // A repeat after the first has committed is caught by the cheap pre-check, before a number is allocated.
    const OrderCounter = require('../src/models/OrderCounter');
    const before = (await OrderCounter.findOne().lean()).seq;
    await assert.rejects(guestOrder(7), (e) => e.errorCode === 'DUPLICATE_SUBMISSION');
    assert.equal((await OrderCounter.findOne().lean()).seq, before);
  });

  test('a transaction left open by a crashed process only blocks the products it touched (F-06)', async () => {
    const other = await createProduct(branch._id, admin._id, { name: 'Test Beans', packaging: { stock: 100 } });

    // Simulate the orphan: an open transaction that has written (and so locked) `product` and never ends.
    process.env.ORDER_RETRY_BUDGET_MS = '1500';   // fail fast for this test only (default is 8 s)
    const session = await mongoose.startSession();
    session.startTransaction();
    await Product.updateOne({ _id: product._id }, { $set: { 'varieties.0.packaging.0.lowStockThreshold': 11 } }, { session });

    try {
      const t0 = Date.now();
      const free = await guestOrder(1, other);               // untouched product: must go straight through
      const freeMs = Date.now() - t0;
      assert.ok(free.orderRef);

      const t1 = Date.now();
      const stuck = await guestOrder(2, product).then(() => null, (e) => e);   // locked product: clean 503, not a hang
      const stuckMs = Date.now() - t1;
      assert.ok(freeMs < stuckMs, `an unrelated order (${freeMs} ms) is not held up like the blocked one (${stuckMs} ms)`);
      assert.ok(stuck, 'the blocked order must fail cleanly');
      assert.equal(stuck.errorCode, 'TRANSACTION_CONFLICT');
      assert.equal(stuck.statusCode, 503);
    } finally {
      delete process.env.ORDER_RETRY_BUDGET_MS;
      await session.abortTransaction();
      await session.endSession();
    }
    // ...and once the stuck transaction is gone the product orders normally again.
    assert.ok((await guestOrder(3, product)).orderRef);
  });
});

describe('per-customer coupon limit under concurrency (F-32)', () => {
  test('two simultaneous checkouts by one customer cannot both redeem a once-per-customer coupon', async () => {
    await testDb.clearDatabase();
    const branch = await createBranch();
    await createSettings(branch._id);
    const admin = await createUser(branch._id, { role: 'admin' });
    const product = await createProduct(branch._id, admin._id, { packaging: { stock: 500 } });
    const other = await createProduct(branch._id, admin._id, { name: 'Test Beans', packaging: { stock: 500 } });
    await couponService.create({ code: 'ONCE', discountType: 'fixed', discountValue: 100, perCustomerLimit: 1 }, branch._id, admin._id);
    const customer = await createUser(null, { role: 'customer', phone: '0711000222', branchId: null });

    const place = (p) => orderService.createCustomerOrder({
      orderItems: [cartItemFor(p, { quantity: 1 })], deliveryMethod: 'pickup', paymentMethod: 'pickup', couponCode: 'ONCE',
    }, customer._id, branch._id);

    const results = await Promise.allSettled([place(product), place(other)]);   // different baskets, so not a "double click"
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'only one redemption');
    const loser = results.find((r) => r.status === 'rejected');
    assert.equal(loser.reason.errorCode, 'COUPON_CUSTOMER_LIMIT');
    assert.equal(await Order.countDocuments({ couponCode: 'ONCE' }), 1);
  });
});
