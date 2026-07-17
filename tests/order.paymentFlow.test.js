// Covers the 2026-07-17 payment-pipeline behaviours: per-method completion
// gates, the refund flip on terminal transitions away from a paid order,
// guest email capture at checkout, and the DPA consent-gated broadcast audience.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const testDb = require('./helpers/testDb');
const { createBranch, createSettings, createUser, createProduct, cartItemFor, objectId } = require('./helpers/fixtures');

const orderService = require('../src/services/order.service');
const broadcastService = require('../src/services/broadcast.service');
const Order = require('../src/models/Order');
const Payment = require('../src/models/Payment');
const Product = require('../src/models/Product');
const Guest = require('../src/models/Guest');

before(async () => { await testDb.connect(); });
after(async () => { await testDb.disconnect(); });

const advanceTo = async (orderId, branchId, statuses) => {
  for (const status of statuses) {
    await orderService.updateStatus(orderId, status, objectId(), null, branchId);
  }
};

// Simulates a confirmed M-Pesa payment without going through the STK flow.
const markPaid = async (order) => {
  const payment = await Payment.create({
    orderId: order._id,
    method: 'mpesa',
    amount: order.total,
    status: 'paid',
    paidAt: new Date(),
  });
  await Order.findByIdAndUpdate(order._id, {
    paymentMethod: 'mpesa',
    paymentStatus: 'paid',
    paymentId: payment._id,
  });
  return payment;
};

describe('order.service — pay-on-pickup completion gate', () => {
  let branch, order;

  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
    await createSettings(branch._id);
    const admin = await createUser(branch._id, { role: 'admin' });
    const product = await createProduct(branch._id, admin._id);
    order = await orderService.createGuestOrder({
      name: 'Jane', phone: '0712345678',
      orderItems: [cartItemFor(product, { quantity: 2 })],
      deliveryMethod: 'pickup',
      paymentMethod: 'pickup',
    }, branch._id);
    await orderService.approve(order._id, objectId(), branch._id);
    await advanceTo(order._id, branch._id, ['preparing', 'out_for_delivery']);
  });

  test('blocks completion while the cash is unconfirmed', async () => {
    await assert.rejects(
      orderService.updateStatus(order._id, 'completed', objectId(), null, branch._id),
      (err) => err.errorCode === 'PAYMENT_NOT_CONFIRMED'
    );

    const refreshed = await Order.findById(order._id).lean();
    assert.equal(refreshed.status, 'out_for_delivery', 'order must not advance past the gate');
  });

  test('completes once the cash payment is confirmed', async () => {
    await Order.findByIdAndUpdate(order._id, { paymentStatus: 'paid' });

    await orderService.updateStatus(order._id, 'completed', objectId(), null, branch._id);

    const refreshed = await Order.findById(order._id).lean();
    assert.equal(refreshed.status, 'completed');
    assert.ok(refreshed.deliveredAt, 'deliveredAt should be stamped on completion');
  });
});

describe('order.service — cash-on-delivery completes unpaid', () => {
  test('the driver cannot confirm payments, so a COD order completes with paymentStatus still unpaid', async () => {
    await testDb.clearDatabase();
    const branch = await createBranch();
    await createSettings(branch._id);
    const admin = await createUser(branch._id, { role: 'admin' });
    const product = await createProduct(branch._id, admin._id);

    const order = await orderService.createGuestOrder({
      name: 'Jane', phone: '0712345678',
      orderItems: [cartItemFor(product, { quantity: 2 })],
      deliveryMethod: 'delivery',
      deliveryAddress: '123 Test Rd, Nairobi',
      paymentMethod: 'delivery',
    }, branch._id);
    await orderService.approve(order._id, objectId(), branch._id);
    await advanceTo(order._id, branch._id, ['preparing', 'out_for_delivery', 'completed']);

    const refreshed = await Order.findById(order._id).lean();
    assert.equal(refreshed.status, 'completed');
    assert.equal(refreshed.paymentStatus, 'unpaid', 'COD cash is confirmed later, when the driver remits it');
  });
});

describe('order.service — terminal transitions flip a paid order to refunded', () => {
  let branch, product, order, payment;

  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
    await createSettings(branch._id);
    const admin = await createUser(branch._id, { role: 'admin' });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 20 } });
    order = await orderService.createGuestOrder({
      name: 'Jane', phone: '0712345678',
      orderItems: [cartItemFor(product, { quantity: 5 })],
      deliveryMethod: 'pickup',
      paymentMethod: 'pickup',
    }, branch._id);
    payment = await markPaid(order);
  });

  test('rejecting a paid pending order refunds both the Payment record and the order', async () => {
    await orderService.reject(order._id, objectId(), 'Cannot fulfil this week', branch._id);

    const refreshedPayment = await Payment.findById(payment._id).lean();
    assert.equal(refreshedPayment.status, 'refunded');
    assert.ok(refreshedPayment.refundedAt);
    assert.equal(refreshedPayment.refundReason, 'Cannot fulfil this week');

    const refreshedOrder = await Order.findById(order._id).lean();
    assert.equal(refreshedOrder.paymentStatus, 'refunded', 'a rejected order must not keep a green Paid badge');
  });

  test('admin cancel after approval refunds and restores stock', async () => {
    await orderService.approve(order._id, objectId(), branch._id);
    await orderService.updateStatus(order._id, 'cancelled', objectId(), 'Customer changed their mind', branch._id);

    const refreshedPayment = await Payment.findById(payment._id).lean();
    assert.equal(refreshedPayment.status, 'refunded');

    const refreshedOrder = await Order.findById(order._id).lean();
    assert.equal(refreshedOrder.paymentStatus, 'refunded');

    const refreshedProduct = await Product.findById(product._id).lean();
    assert.equal(refreshedProduct.varieties[0].packaging[0].stock, 20, 'stock should be restored alongside the refund');
  });

  test('cancelling an unpaid order records no refund', async () => {
    await Order.findByIdAndUpdate(order._id, { paymentStatus: 'unpaid' });
    await orderService.updateStatus(order._id, 'cancelled', objectId(), 'Duplicate order', branch._id);

    const refreshedPayment = await Payment.findById(payment._id).lean();
    assert.equal(refreshedPayment.status, 'paid', 'no money was owed back, so the Payment record stays untouched');

    const refreshedOrder = await Order.findById(order._id).lean();
    assert.equal(refreshedOrder.paymentStatus, 'unpaid');
  });
});

describe('order.service — guest email capture at checkout', () => {
  let branch, product;

  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
    await createSettings(branch._id);
    const admin = await createUser(branch._id, { role: 'admin' });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 50 } });
  });

  const placeOrder = (extra = {}, quantity = 2) => orderService.createGuestOrder({
    name: 'Jane', phone: '0712345678',
    orderItems: [cartItemFor(product, { quantity })],
    deliveryMethod: 'pickup',
    paymentMethod: 'pickup',
    ...extra,
  }, branch._id);

  test('stores a normalised email on the Guest record for order-status emails', async () => {
    await placeOrder({ email: '  Jane@Example.COM ' });

    const guest = await Guest.findOne({ phone: /712345678$/ }).lean();
    assert.equal(guest.email, 'jane@example.com');
  });

  test('a repeat guest supplying a new email gets their record updated', async () => {
    await placeOrder({ email: 'old@example.com' });
    // Different quantity → different total, so the 20s duplicate-submission
    // guard (assertNoDuplicateOrder) doesn't reject the second checkout.
    await placeOrder({ email: 'new@example.com' }, 3);

    const guests = await Guest.find({ phone: /712345678$/ }).lean();
    assert.equal(guests.length, 1, 'repeat checkout must reuse the same guest record');
    assert.equal(guests[0].email, 'new@example.com');
  });
});

describe('broadcast.service — marketing audience is consent-gated (Kenya DPA opt-in)', () => {
  test('only consented customers are counted; roles and non-consenters are excluded', async () => {
    await testDb.clearDatabase();
    const branch = await createBranch();

    await createUser(null, { role: 'customer', marketingConsent: true });
    await createUser(null, { role: 'customer', marketingConsent: false });
    await createUser(null, { role: 'customer' }); // consent defaults to false
    await createUser(branch._id, { role: 'driver', marketingConsent: true });
    await createUser(null, { role: 'customer', marketingConsent: true, isB2B: true });

    assert.equal(await broadcastService.getAudienceCount('all'), 2, 'two consented customers total');
    assert.equal(await broadcastService.getAudienceCount('b2b'), 1, 'only the consented B2B customer');
  });
});
