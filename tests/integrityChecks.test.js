// 2026-10 audit F-29: the integrity scan used to say "0 problems" while a cancelled order sat marked paid.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const testDb = require('./helpers/testDb');
const { createBranch, createSettings, createUser, createProduct, cartItemFor, objectId } = require('./helpers/fixtures');
const orderService = require('../src/services/order.service');
const { CHECKS, runScan } = require('../src/services/integrity.service');
const Order = require('../src/models/Order');
const Payment = require('../src/models/Payment');
const Coupon = require('../src/models/Coupon');
const couponService = require('../src/services/coupon.service');

before(async () => { await testDb.connect(); });
after(async () => { await testDb.disconnect(); });

const check = (id) => CHECKS.find((c) => c.id === id);
const count = async (id) => (await check(id).run()).count;

describe('integrity scan — new checks', () => {
  let branch; let admin; let product; let seq = 0;
  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
    await createSettings(branch._id);
    admin = await createUser(branch._id, { role: 'admin' });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 500 } });
  });

  const place = (extra = {}) => orderService.createGuestOrder({
    name: 'Jane', phone: `07${30000000 + (++seq)}`,
    orderItems: [cartItemFor(product)], deliveryMethod: 'pickup', paymentMethod: 'mpesa', ...extra,
  }, branch._id);
  const payFor = (order, over = {}) => Payment.create({ orderId: order._id, method: 'mpesa', amount: Math.ceil(order.total), status: 'paid', paidAt: new Date(), ...over });

  test('a healthy shop reports nothing', async () => {
    const order = await place();
    await payFor(order);
    await Order.updateOne({ _id: order._id }, { paymentStatus: 'paid' });
    for (const id of ['closed-order-paid', 'paid-payment-unpaid-order', 'payment-amount-mismatch', 'coupon-usage-drift', 'etims-pending-stuck']) {
      assert.equal(await count(id), 0, id);
    }
  });

  test('closed-order-paid: a rejected order still marked paid is found', async () => {
    const order = await place();
    await Order.updateOne({ _id: order._id }, { status: 'rejected', paymentStatus: 'paid' });
    assert.equal(await count('closed-order-paid'), 1);
    const scan = await runScan();
    assert.ok(scan.checks.find((c) => c.id === 'closed-order-paid' && !c.ok), 'the scan as a whole now flags it');
  });

  test('paid-payment-unpaid-order: a paid payment on an order that says unpaid is found', async () => {
    const order = await place();
    await payFor(order);                       // order.paymentStatus stays 'unpaid'
    assert.equal(await count('paid-payment-unpaid-order'), 1);
  });

  test('payment-amount-mismatch', async () => {
    const order = await place();
    await payFor(order, { amount: Math.ceil(order.total) + 50 });
    assert.equal(await count('payment-amount-mismatch'), 1);
  });

  test('coupon-usage-drift: counts match when orders use the coupon, mismatch when the counter is wrong', async () => {
    await couponService.create({ code: 'SAVE', discountType: 'fixed', discountValue: 50 }, branch._id, admin._id);
    await place({ couponCode: 'SAVE' });
    assert.equal(await count('coupon-usage-drift'), 0);
    await Coupon.updateOne({ code: 'SAVE' }, { usedCount: 4 });
    assert.equal(await count('coupon-usage-drift'), 1);
  });

  test('etims-pending-stuck: only claims older than an hour', async () => {
    const fresh = await place();
    const old = await place();
    await Order.updateOne({ _id: fresh._id }, { etimsStatus: 'pending' });
    await Order.updateOne({ _id: old._id }, { etimsStatus: 'pending' });
    await Order.collection.updateOne({ _id: old._id }, { $set: { updatedAt: new Date(Date.now() - 3 * 3600 * 1000) } });
    assert.equal(await count('etims-pending-stuck'), 1);
  });

  test('every check still runs without throwing on an empty database', async () => {
    await testDb.clearDatabase();
    const scan = await runScan();
    assert.deepEqual(scan.checks.filter((c) => c.error), []);
    assert.ok(objectId());
  });
});
