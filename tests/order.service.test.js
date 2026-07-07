const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const testDb = require('./helpers/testDb');
const { createBranch, createSettings, createUser, createProduct, cartItemFor, objectId } = require('./helpers/fixtures');

const orderService = require('../src/services/order.service');
const couponService = require('../src/services/coupon.service');
const Order = require('../src/models/Order');
const Product = require('../src/models/Product');
const Coupon = require('../src/models/Coupon');

before(async () => { await testDb.connect(); });
after(async () => { await testDb.disconnect(); });

describe('order.service — guest order placement reserves stock', () => {
  let branch, product;

  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
    await createSettings(branch._id);
    const admin = await createUser(branch._id, { role: 'admin' });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 20 } });
  });

  test('deducts stock at placement time (not at approval)', async () => {
    const order = await orderService.createGuestOrder({
      name: 'Jane', phone: '0712345678',
      orderItems: [cartItemFor(product, { quantity: 5 })],
      deliveryMethod: 'pickup',
      paymentMethod: 'pickup',
    }, branch._id);

    assert.equal(order.stockReservationStatus, 'held');
    assert.ok(order.stockReservedAt);

    const refreshed = await Product.findById(product._id).lean();
    assert.equal(refreshed.varieties[0].packaging[0].stock, 15, 'stock should drop by 5 immediately');
  });

  test('rejects an order that exceeds available stock', async () => {
    await assert.rejects(
      orderService.createGuestOrder({
        name: 'Jane', phone: '0712345678',
        orderItems: [cartItemFor(product, { quantity: 999 })],
        deliveryMethod: 'pickup',
        paymentMethod: 'pickup',
      }, branch._id),
      (err) => err.errorCode === 'STOCK_INSUFFICIENT'
    );
  });
});

describe('order.service — approve', () => {
  let branch, product, order;

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
  });

  test('marks reservation consumed without deducting stock a second time', async () => {
    const adminId = objectId();
    await orderService.approve(order._id, adminId, branch._id);

    const refreshedOrder = await Order.findById(order._id).lean();
    assert.equal(refreshedOrder.status, 'approved');
    assert.equal(refreshedOrder.stockReservationStatus, 'consumed');

    const refreshedProduct = await Product.findById(product._id).lean();
    assert.equal(refreshedProduct.varieties[0].packaging[0].stock, 15, 'stock must not be deducted again on approval');
  });

  test('blocks approval of an unpaid M-Pesa order', async () => {
    const mpesaOrder = await Order.findByIdAndUpdate(order._id, { paymentMethod: 'mpesa', paymentStatus: 'unpaid' }, { new: true });
    await assert.rejects(
      orderService.approve(mpesaOrder._id, objectId(), branch._id),
      (err) => err.errorCode === 'PAYMENT_NOT_CONFIRMED'
    );
  });

  test('rejects an illegal transition (approved order cannot be approved again)', async () => {
    await orderService.approve(order._id, objectId(), branch._id);
    await assert.rejects(
      orderService.approve(order._id, objectId(), branch._id),
      (err) => err.errorCode === 'INVALID_STATUS_TRANSITION'
    );
  });
});

describe('order.service — reject releases stock and coupon usage', () => {
  let branch, product, coupon, order;

  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
    await createSettings(branch._id);
    const admin = await createUser(branch._id, { role: 'admin' });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 20 } });

    coupon = await Coupon.create({
      code: 'SAVE10', discountType: 'percentage', discountValue: 10,
      branchId: branch._id, createdBy: admin._id, usedCount: 0,
    });

    order = await orderService.createGuestOrder({
      name: 'Jane', phone: '0712345678',
      orderItems: [cartItemFor(product, { quantity: 5 })],
      deliveryMethod: 'pickup',
      paymentMethod: 'pickup',
      couponCode: 'SAVE10',
    }, branch._id);
  });

  test('coupon usage is incremented on order placement', async () => {
    const refreshed = await Coupon.findById(coupon._id).lean();
    assert.equal(refreshed.usedCount, 1);
  });

  test('reject releases held stock and decrements coupon usage', async () => {
    await orderService.reject(order._id, objectId(), 'Out of stock at supplier', branch._id);

    const refreshedOrder = await Order.findById(order._id).lean();
    assert.equal(refreshedOrder.status, 'rejected');
    assert.equal(refreshedOrder.stockReservationStatus, 'released');

    const refreshedProduct = await Product.findById(product._id).lean();
    assert.equal(refreshedProduct.varieties[0].packaging[0].stock, 20, 'stock should be fully restored');

    const refreshedCoupon = await Coupon.findById(coupon._id).lean();
    assert.equal(refreshedCoupon.usedCount, 0, 'coupon use should be given back');
  });

  test('reject requires a reason', async () => {
    await assert.rejects(orderService.reject(order._id, objectId(), '', branch._id));
  });
});

describe('order.service — customer cancel', () => {
  let branch, product, customer, order;

  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
    await createSettings(branch._id);
    const admin = await createUser(branch._id, { role: 'admin' });
    customer = await createUser(branch._id, { role: 'customer', branchId: null });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 20 } });
    order = await orderService.createCustomerOrder({
      orderItems: [cartItemFor(product, { quantity: 3 })],
      deliveryMethod: 'pickup',
      paymentMethod: 'pickup',
    }, customer._id, branch._id);
  });

  test('customer can cancel their own pending order and stock is released', async () => {
    await orderService.cancel(order._id, customer._id);

    const refreshedOrder = await Order.findById(order._id).lean();
    assert.equal(refreshedOrder.status, 'cancelled');

    const refreshedProduct = await Product.findById(product._id).lean();
    assert.equal(refreshedProduct.varieties[0].packaging[0].stock, 20);
  });

  test('a different customer cannot cancel this order', async () => {
    const otherCustomer = await createUser(branch._id, { role: 'customer', branchId: null });
    await assert.rejects(
      orderService.cancel(order._id, otherCustomer._id),
      (err) => err.errorCode === 'FORBIDDEN'
    );
  });

  test('cannot cancel once approved (only pending is cancellable by customer)', async () => {
    await orderService.approve(order._id, objectId(), branch._id);
    await assert.rejects(
      orderService.cancel(order._id, customer._id),
      (err) => err.errorCode === 'INVALID_STATUS_TRANSITION'
    );
  });
});

describe('order.service — admin cancel via updateStatus releases stock at any stage', () => {
  let branch, product, order;

  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
    await createSettings(branch._id);
    const admin = await createUser(branch._id, { role: 'admin' });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 20 } });
    order = await orderService.createGuestOrder({
      name: 'Jane', phone: '0712345678',
      orderItems: [cartItemFor(product, { quantity: 4 })],
      deliveryMethod: 'pickup',
      paymentMethod: 'pickup',
    }, branch._id);
    await orderService.approve(order._id, objectId(), branch._id);
  });

  test('admin cancel after approval still releases the held/consumed stock', async () => {
    await orderService.updateStatus(order._id, 'cancelled', objectId(), 'Customer no longer wants it', branch._id);

    const refreshedProduct = await Product.findById(product._id).lean();
    assert.equal(refreshedProduct.varieties[0].packaging[0].stock, 20, 'stock should be restored on admin cancel too');
  });
});
