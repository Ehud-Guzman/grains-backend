// What happens when several things hit the same branch / product / order at the same moment.
//
// Regressions for two linked go-live problems:
//   1. Overlapping transactions that write the same document do not queue - MongoDB aborts the second
//      one with a WriteConflict. Every order writes its branch's order counter and the product lines it
//      reserves, so two customers checking out together meant one got a raw 500
//      (10 simultaneous orders -> 1 created, 9 failed). The order flows now go through runTransaction,
//      which re-runs the transaction.
//   2. The duplicate-submission guard was check-then-insert, so a double-click created two orders (and
//      reserved stock twice). It now runs inside the transaction, behind the branch counter write.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const testDb = require('./helpers/testDb');
const { createBranch, createSettings, createUser, createProduct, cartItemFor } = require('./helpers/fixtures');

const orderService = require('../src/services/order.service');
const productService = require('../src/services/product.service');
const { runTransaction, isTransientTransactionError } = require('../src/utils/transaction');
const { resetBranchCodeCache } = require('../src/utils/branchCode');
const Order = require('../src/models/Order');
const Product = require('../src/models/Product');
const Coupon = require('../src/models/Coupon');
const OrderCounter = require('../src/models/OrderCounter');

before(async () => { await testDb.connect(); });
after(async () => { await testDb.disconnect(); });

const transientError = (message = 'simulated write conflict') => {
  const err = new mongoose.mongo.MongoError(message);
  err.addErrorLabel('TransientTransactionError');
  return err;
};

const stockOf = async (product) =>
  (await Product.findById(product._id).lean()).varieties[0].packaging[0].stock;

describe('runTransaction', () => {
  beforeEach(async () => { await testDb.clearDatabase(); });

  test('returns what the work returned', async () => {
    const result = await runTransaction(async () => ({ ok: true }));
    assert.deepEqual(result, { ok: true });
  });

  test('re-runs the whole block after a transient conflict and returns the successful attempt', async () => {
    let attempts = 0;
    const result = await runTransaction(async (_session, attempt) => {
      attempts += 1;
      if (attempt < 3) throw transientError();
      return `done on attempt ${attempt}`;
    });
    assert.equal(attempts, 3);
    assert.equal(result, 'done on attempt 3');
  });

  test('writes made by an attempt that conflicted are rolled back', async () => {
    await runTransaction(async (session, attempt) => {
      await OrderCounter.create([{ _id: `attempt_${attempt}`, branchId: new mongoose.Types.ObjectId(), year: 2026, seq: attempt }], { session });
      if (attempt === 1) throw transientError();
    });
    const ids = (await OrderCounter.find().lean()).map(c => c._id);
    assert.deepEqual(ids, ['attempt_2'], 'only the committed attempt may leave data behind');
  });

  test('gives up with a clear 503 after maxAttempts instead of retrying for minutes', async () => {
    let attempts = 0;
    await assert.rejects(
      runTransaction(async () => { attempts += 1; throw transientError(); }, { maxAttempts: 3 }),
      (err) => err.statusCode === 503 && err.errorCode === 'TRANSACTION_CONFLICT'
    );
    assert.equal(attempts, 3);
  });

  test('a non-transient error is thrown as it is, once, with no retry', async () => {
    let attempts = 0;
    const boom = Object.assign(new Error('bad input'), { statusCode: 400, errorCode: 'BAD' });
    await assert.rejects(
      runTransaction(async () => { attempts += 1; throw boom; }),
      (err) => err === boom
    );
    assert.equal(attempts, 1);
  });

  test('isTransientTransactionError only matches the labelled driver error', () => {
    assert.equal(isTransientTransactionError(transientError()), true);
    assert.equal(isTransientTransactionError(new Error('x')), false);
    assert.equal(isTransientTransactionError(null), false);
    assert.equal(isTransientTransactionError(new mongoose.mongo.MongoError('no label')), false);
  });
});

describe('simultaneous checkouts on one branch', () => {
  let branch, product, admin;

  beforeEach(async () => {
    await testDb.clearDatabase();
    resetBranchCodeCache();
    branch = await createBranch();
    await createSettings(branch._id);
    admin = await createUser(branch._id, { role: 'admin' });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 1000 } });
  });

  const guestOrder = (i, quantity = 2, extra = {}) => orderService.createGuestOrder({
    name: `Customer ${i}`, phone: `07150${String(i).padStart(5, '0')}`,
    orderItems: [cartItemFor(product, { quantity })],
    deliveryMethod: 'pickup', paymentMethod: 'pickup', ...extra,
  }, branch._id);

  test('10 different customers at once: every order is created, references are unique, stock is exact', async () => {
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => guestOrder(i)));
    const failed = results.filter(r => r.status === 'rejected').map(r => r.reason.errorCode || r.reason.message);
    assert.deepEqual(failed, [], 'no order may fail just because another was placed at the same time');

    const orders = await Order.find().lean();
    assert.equal(orders.length, 10);
    assert.equal(new Set(orders.map(o => o.orderRef)).size, 10);
    assert.equal(await stockOf(product), 1000 - 10 * 2, 'each order reserved its stock exactly once');
  });

  test('never oversells: with 5 left, three orders of 2 get two orders and one clean "insufficient stock"', async () => {
    await Product.updateOne({ _id: product._id }, { $set: { 'varieties.0.packaging.0.stock': 5 } });
    const results = await Promise.allSettled([guestOrder(1), guestOrder(2), guestOrder(3)]);

    assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
    const rejected = results.filter(r => r.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.errorCode, 'STOCK_INSUFFICIENT', 'a lost race for stock is a 409, not a server error');
    assert.equal(await stockOf(product), 1);
  });

  test('a coupon with one use left is applied to exactly one of three simultaneous orders', async () => {
    await Coupon.create({
      code: 'ONCE', discountType: 'fixed', discountValue: 100, usageLimit: 1,
      branchId: branch._id, createdBy: admin._id,
    });
    const results = await Promise.allSettled([1, 2, 3].map(i => guestOrder(i, 1, { couponCode: 'ONCE' })));

    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    for (const r of results.filter(x => x.status === 'rejected')) {
      assert.equal(r.reason.errorCode, 'COUPON_EXHAUSTED');
    }
    assert.equal((await Coupon.findOne({ code: 'ONCE' }).lean()).usedCount, 1);
  });
});

describe('double submission of the same checkout', () => {
  let branch, product;

  beforeEach(async () => {
    await testDb.clearDatabase();
    resetBranchCodeCache();
    branch = await createBranch();
    await createSettings(branch._id);
    const admin = await createUser(branch._id, { role: 'admin' });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 100 } });
  });

  test('a guest double-clicking creates ONE order; the repeat is told it is a duplicate (5 rounds)', async () => {
    for (let round = 0; round < 5; round++) {
      await testDb.clearDatabase();
      resetBranchCodeCache();
      branch = await createBranch();
      await createSettings(branch._id);
      const admin = await createUser(branch._id, { role: 'admin' });
      product = await createProduct(branch._id, admin._id, { packaging: { stock: 100 } });

      const submit = () => orderService.createGuestOrder({
        name: 'Jane', phone: '0798765432',
        orderItems: [cartItemFor(product, { quantity: 2 })],
        deliveryMethod: 'pickup', paymentMethod: 'pickup',
      }, branch._id);

      const results = await Promise.allSettled([submit(), submit()]);
      const ok = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      assert.equal(ok.length, 1, `round ${round}: exactly one order`);
      assert.equal(rejected[0].reason.errorCode, 'DUPLICATE_SUBMISSION', `round ${round}: the repeat is a clean 409`);
      assert.equal(await Order.countDocuments(), 1);
      assert.equal(await stockOf(product), 98, `round ${round}: stock reserved once, not twice`);
    }
  });

  test('a signed-in customer double-clicking creates ONE order', async () => {
    const customer = await createUser(null, { role: 'customer', phone: '0711222333' });
    const submit = () => orderService.createCustomerOrder({
      orderItems: [cartItemFor(product, { quantity: 3 })],
      deliveryMethod: 'pickup', paymentMethod: 'pickup',
    }, customer._id, branch._id);

    const results = await Promise.allSettled([submit(), submit(), submit()]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    for (const r of results.filter(x => x.status === 'rejected')) {
      assert.equal(r.reason.errorCode, 'DUPLICATE_SUBMISSION');
    }
    assert.equal(await stockOf(product), 97);
  });

  test('two genuinely different orders from the same customer are both accepted', async () => {
    const submit = (quantity) => orderService.createGuestOrder({
      name: 'Jane', phone: '0798765432',
      orderItems: [cartItemFor(product, { quantity })],
      deliveryMethod: 'pickup', paymentMethod: 'pickup',
    }, branch._id);
    const results = await Promise.allSettled([submit(2), submit(5)]); // different totals
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
    assert.equal(await stockOf(product), 93);
  });
});

describe('admin and customer acting on the same order at once', () => {
  let branch, product, customer, admin;

  beforeEach(async () => {
    await testDb.clearDatabase();
    resetBranchCodeCache();
    branch = await createBranch();
    await createSettings(branch._id);
    admin = await createUser(branch._id, { role: 'admin' });
    customer = await createUser(null, { role: 'customer', phone: '0711999888' });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 50 } });
  });

  test('approve vs customer cancel: one wins, the other gets a clean 400, stock stays consistent', async () => {
    for (let round = 0; round < 4; round++) {
      const order = await orderService.createCustomerOrder({
        orderItems: [cartItemFor(product, { quantity: 1 + round })],
        deliveryMethod: 'pickup', paymentMethod: 'pickup',
      }, customer._id, branch._id);
      const stockBefore = await stockOf(product);

      const results = await Promise.allSettled([
        orderService.approve(order._id, admin._id, branch._id),
        orderService.cancel(order._id, customer._id),
      ]);

      const winners = results.filter(r => r.status === 'fulfilled');
      const losers = results.filter(r => r.status === 'rejected');
      assert.equal(winners.length, 1, `round ${round}: exactly one action may win`);
      assert.equal(losers.length, 1);
      assert.equal(losers[0].reason.errorCode, 'INVALID_STATUS_TRANSITION', `round ${round}: the loser is a clean 400 (${losers[0].reason.message})`);

      const final = await Order.findById(order._id).lean();
      if (final.status === 'cancelled') {
        assert.equal(await stockOf(product), stockBefore + order.orderItems[0].quantity, 'a cancel gives the stock back');
      } else {
        assert.equal(final.status, 'approved');
        assert.equal(await stockOf(product), stockBefore, 'an approval keeps the stock reserved');
      }
    }
  });
});

describe('editing a product while orders reserve its stock', () => {
  test('stock reserved by orders during product edits is never overwritten', async () => {
    await testDb.clearDatabase();
    resetBranchCodeCache();
    const branch = await createBranch();
    await createSettings(branch._id);
    const admin = await createUser(branch._id, { role: 'admin' });
    const product = await createProduct(branch._id, admin._id, { packaging: { stock: 500 } });

    // The admin edit form was loaded with stock 500 and keeps submitting that stale figure.
    const editPayload = (i) => ({
      name: 'Test Maize', description: `edit ${i}`,
      varieties: [{ varietyName: 'Yellow', packaging: [{ size: '50kg', priceKES: 1000, stock: 500, lowStockThreshold: 10, quoteOnly: false }] }],
    });

    for (let round = 0; round < 4; round++) {
      const before = await stockOf(product);
      const orders = Array.from({ length: 5 }, (_, i) => orderService.createGuestOrder({
        name: `C${round}-${i}`, phone: `07160${round}${String(i).padStart(4, '0')}`,
        orderItems: [cartItemFor(product, { quantity: 2 })],
        deliveryMethod: 'pickup', paymentMethod: 'pickup',
      }, branch._id));
      const edits = Array.from({ length: 4 }, (_, i) => productService.update(product._id, editPayload(i), admin._id, branch._id));

      const settled = await Promise.allSettled([...orders, ...edits]);
      const placed = settled.slice(0, 5).filter(r => r.status === 'fulfilled').length;
      const editFailures = settled.slice(5).filter(r => r.status === 'rejected').map(r => r.reason.message);
      assert.deepEqual(editFailures, [], 'product edits must not fail because orders are being placed');

      assert.equal(await stockOf(product), before - placed * 2,
        `round ${round}: ${placed} orders of 2 were placed, so stock must have dropped by ${placed * 2}`);
    }
    // The four edits ran together, so any of them may have committed last - but one of them did.
    assert.match((await Product.findById(product._id).lean()).description, /^edit [0-3]$/);
  });
});
