// Regression tests for the 2026-10 system audit (SYSTEM-AUDIT-2026-10-17.md).
// Each test pins a bug that was reproduced against a real database before it was fixed.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'a'.repeat(64);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'b'.repeat(64);
process.env.SKIP_2FA = 'true';

const testDb = require('./helpers/testDb');
const { createBranch, createSettings, createUser, createProduct, cartItemFor, objectId } = require('./helpers/fixtures');

const orderService = require('../src/services/order.service');
const paymentService = require('../src/services/payment.service');
const productService = require('../src/services/product.service');
const couponService = require('../src/services/coupon.service');
const authService = require('../src/services/auth.service');
const importExport = require('../src/services/productImportExport.service');
const { generateTimestamp } = require('../src/utils/mpesaHelpers');
const { findProductRuleViolation } = require('../src/utils/productRules');
const { appEvents, ORDER_EVENTS } = require('../src/events/appEvents');
const Order = require('../src/models/Order');
const Payment = require('../src/models/Payment');
const Product = require('../src/models/Product');
const Settings = require('../src/models/Settings');
const User = require('../src/models/User');
const settingsService = require('../src/services/settings.service');

before(async () => { await testDb.connect(); });
after(async () => { await testDb.disconnect(); });

const placeGuest = (branch, product, over = {}) => orderService.createGuestOrder({
  name: 'Jane', phone: '0712345678',
  orderItems: [cartItemFor(product, { quantity: 2 })],
  deliveryMethod: 'pickup', paymentMethod: 'mpesa', ...over,
}, branch._id);

const markPaid = async (order) => {
  const pay = await Payment.create({
    orderId: order._id, method: 'mpesa', amount: order.total, status: 'paid',
    mpesaTransactionId: `T${String(Math.random()).slice(2, 11)}`,
  });
  await Order.findByIdAndUpdate(order._id, { paymentStatus: 'paid', paymentId: pay._id });
  return pay;
};

describe('audit fixes', () => {
  let branch, admin, product;

  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
    await createSettings(branch._id);
    admin = await createUser(branch._id, { role: 'admin' });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 50 } });
  });

  // ── payments ───────────────────────────────────────────────────────────────
  describe('M-Pesa initiation', () => {
    const env = { ...process.env };
    after(() => { process.env = env; });

    test('an unconfigured server does not leave the order claimed', async () => {
      delete process.env.MPESA_SHORTCODE; delete process.env.MPESA_PASSKEY; delete process.env.MPESA_CALLBACK_URL;
      const order = await placeGuest(branch, product);
      for (let i = 0; i < 2; i++) {
        await assert.rejects(paymentService.initiateStkPush(order._id, '0712345678'), (e) => e.errorCode === 'MPESA_NOT_CONFIGURED');
      }
      const fresh = await Order.findById(order._id).lean();
      assert.equal(fresh.paymentStatus, 'unpaid');
      assert.equal(fresh.paymentId, null);
    });

    test('refuses cancelled orders and orders that are not M-Pesa', async () => {
      process.env.MPESA_SHORTCODE = '174379'; process.env.MPESA_PASSKEY = 'k'; process.env.MPESA_CALLBACK_URL = 'https://x/cb';
      const pickup = await placeGuest(branch, product, { paymentMethod: 'pickup' });
      await assert.rejects(paymentService.initiateStkPush(pickup._id, '0712345678'), (e) => e.errorCode === 'NOT_MPESA_ORDER');

      const mpesa = await placeGuest(branch, product, { phone: '0711111111' });
      await orderService.updateStatus(mpesa._id, 'cancelled', admin._id, 'test', branch._id, 'admin');
      await assert.rejects(paymentService.initiateStkPush(mpesa._id, '0711111111'), (e) => e.errorCode === 'ORDER_NOT_PAYABLE');
    });

    test('a claim whose Payment document never existed counts as stale', async () => {
      process.env.MPESA_SHORTCODE = '174379'; process.env.MPESA_PASSKEY = 'k'; process.env.MPESA_CALLBACK_URL = 'https://x/cb';
      const order = await placeGuest(branch, product);
      await Order.findByIdAndUpdate(order._id, { paymentStatus: 'pending', paymentId: objectId() });
      // It gets past the "already in progress" guard (and then fails at Daraja, which is unreachable here).
      await assert.rejects(paymentService.initiateStkPush(order._id, '0712345678'), (e) => e.errorCode !== 'PAYMENT_IN_PROGRESS');
    });
  });

  test('manual confirmation is refused on a cancelled order', async () => {
    const order = await placeGuest(branch, product, { paymentMethod: 'pickup' });
    await orderService.updateStatus(order._id, 'cancelled', admin._id, 'test', branch._id, 'admin');
    await assert.rejects(
      paymentService.manualConfirmPayment(order._id, admin._id, null, 'admin', branch._id, order.total),
      (e) => e.errorCode === 'ORDER_NOT_PAYABLE'
    );
    const fresh = await Order.findById(order._id).lean();
    assert.notEqual(fresh.paymentStatus, 'paid');
  });

  describe('changing payment method', () => {
    test('moves an unpaid pending order off M-Pesa so it can be approved', async () => {
      const order = await placeGuest(branch, product);
      const stale = await Payment.create({ orderId: order._id, method: 'mpesa', amount: order.total, status: 'pending', checkoutRequestId: 'ws_1' });
      await Order.findByIdAndUpdate(order._id, { paymentStatus: 'failed', paymentId: stale._id });
      await Payment.findByIdAndUpdate(stale._id, { status: 'failed' });

      // Before: an M-Pesa order that is not paid can never be approved.
      await assert.rejects(orderService.approve(order._id, admin._id, branch._id), (e) => e.errorCode === 'PAYMENT_NOT_CONFIRMED');

      const updated = await paymentService.changePaymentMethod(order._id, 'pickup');
      assert.equal(updated.paymentMethod, 'pickup');
      assert.equal(updated.paymentStatus, 'unpaid');
      assert.equal(updated.paymentId, null);

      const approved = await orderService.approve(order._id, admin._id, branch._id);
      assert.equal(approved.status, 'approved');
    });

    test('rules: pickup only for pickup orders, not after approval, not mid-prompt', async () => {
      const delivery = await placeGuest(branch, product, { deliveryMethod: 'delivery', deliveryAddress: 'Somewhere 1', phone: '0722222222' });
      await assert.rejects(paymentService.changePaymentMethod(delivery._id, 'pickup'), (e) => e.errorCode === 'INVALID_PAYMENT_METHOD');
      const ok = await paymentService.changePaymentMethod(delivery._id, 'delivery');
      assert.equal(ok.paymentMethod, 'delivery');

      const live = await placeGuest(branch, product, { phone: '0733333333' });
      const fresh = await Payment.create({ orderId: live._id, method: 'mpesa', amount: live.total, status: 'pending', checkoutRequestId: 'ws_2' });
      await Order.findByIdAndUpdate(live._id, { paymentStatus: 'pending', paymentId: fresh._id });
      await assert.rejects(paymentService.changePaymentMethod(live._id, 'pickup'), (e) => e.errorCode === 'PAYMENT_IN_PROGRESS');

      const pickup = await placeGuest(branch, product, { paymentMethod: 'pickup', phone: '0744444444' });
      await orderService.approve(pickup._id, admin._id, branch._id);
      await assert.rejects(paymentService.changePaymentMethod(pickup._id, 'mpesa'), (e) => e.errorCode === 'ORDER_NOT_EDITABLE');
    });
  });

  test('payment callback marks Payment and Order paid together, and tells the customer', async () => {
    const order = await placeGuest(branch, product);
    const payment = await Payment.create({ orderId: order._id, method: 'mpesa', amount: order.total, status: 'pending', checkoutRequestId: 'ws_cb' });
    await Order.findByIdAndUpdate(order._id, { paymentStatus: 'pending', paymentId: payment._id });

    const seen = new Promise((resolve) => appEvents.once(ORDER_EVENTS.PAID, resolve));
    await paymentService.handleCallback({ Body: { stkCallback: {
      CheckoutRequestID: 'ws_cb', ResultCode: 0,
      CallbackMetadata: { Item: [{ Name: 'Amount', Value: order.total + 50 }, { Name: 'MpesaReceiptNumber', Value: 'QDK14KSHD7' }] },
    } } });
    assert.equal((await Order.findById(order._id).lean()).paymentStatus, 'paid');
    assert.equal((await Payment.findById(payment._id).lean()).status, 'paid');
    assert.ok(await seen, 'order:paid event emitted');
    // overpayment is recorded, not just logged
    const ActivityLog = require('../src/models/ActivityLog');
    assert.equal(await ActivityLog.countDocuments({ action: 'PAYMENT_OVERPAID' }), 1);
  });

  test('Daraja timestamp is Nairobi time', () => {
    assert.equal(generateTimestamp(new Date('2026-10-17T07:30:05Z')), '20261017103005');
    assert.equal(generateTimestamp(new Date('2026-12-31T22:00:00Z')), '20270101010000');
  });

  // ── order integrity ────────────────────────────────────────────────────────
  describe('failures around commit', () => {
    test('a failed refund rolls the cancel back and reports the real error', async () => {
      const user = await createUser(branch._id, { phone: '0700000001' });
      const order = await placeGuest(branch, product);
      await Order.findByIdAndUpdate(order._id, { userId: user._id, guestId: null });
      await markPaid(order);

      const orig = Payment.findByIdAndUpdate;
      Payment.findByIdAndUpdate = () => { throw new Error('simulated DB blip'); };
      try {
        await assert.rejects(orderService.cancel(order._id, user._id), (e) => e.message === 'simulated DB blip');
      } finally { Payment.findByIdAndUpdate = orig; }

      const fresh = await Order.findById(order._id).lean();
      assert.equal(fresh.status, 'pending', 'cancel rolled back with the refund');
      assert.equal(fresh.stockReservationStatus, 'held');
    });

    test('cancelling a paid order records the refund atomically and emits the event', async () => {
      const order = await placeGuest(branch, product);
      const pay = await markPaid(order);
      const seen = new Promise((resolve) => appEvents.once(ORDER_EVENTS.CANCELLED, resolve));

      await orderService.updateStatus(order._id, 'cancelled', admin._id, 'out of stock', branch._id, 'admin');
      const fresh = await Order.findById(order._id).lean();
      assert.equal(fresh.paymentStatus, 'refunded');
      assert.equal((await Payment.findById(pay._id).lean()).status, 'refunded');
      const evt = await seen;
      assert.equal(evt.refundOwed, true);
    });

    test('auto-cancel carries on past an order that fails', async () => {
      await Settings.updateOne({ branchId: branch._id }, { autoCancelHours: 1 });
      settingsService.invalidateCache(branch._id);
      const o1 = await placeGuest(branch, product, { phone: '0711000001' });
      const o2 = await placeGuest(branch, product, { phone: '0711000002' });
      await Order.collection.updateMany({ _id: { $in: [o1._id, o2._id] } }, { $set: { createdAt: new Date(Date.now() - 3 * 3600 * 1000) } });
      await markPaid(o1); await markPaid(o2);

      const orig = Payment.findByIdAndUpdate;
      let calls = 0;
      Payment.findByIdAndUpdate = (...a) => { calls++; if (calls === 1) throw new Error('blip'); return orig.apply(Payment, a); };
      try { await orderService.autoCancelExpiredPendingOrders(branch._id); } finally { Payment.findByIdAndUpdate = orig; }

      const statuses = (await Order.find({ _id: { $in: [o1._id, o2._id] } }).lean()).map(o => `${o.status}/${o.paymentStatus}`).sort();
      assert.deepEqual(statuses, ['cancelled/refunded', 'pending/paid']);
    });
  });

  // ── products & stock ───────────────────────────────────────────────────────
  describe('product structure', () => {
    test('rules: duplicate varieties/sizes and unpriced packaging are rejected', () => {
      assert.match(findProductRuleViolation([
        { varietyName: 'White', packaging: [{ size: '50kg', priceKES: 1 }] },
        { varietyName: ' white ', packaging: [{ size: '50kg', priceKES: 1 }] },
      ]), /more than once/);
      assert.match(findProductRuleViolation([
        { varietyName: 'White', packaging: [{ size: '50kg', priceKES: 1 }, { size: '50KG', priceKES: 2 }] },
      ]), /more than once/);
      assert.match(findProductRuleViolation([{ varietyName: 'W', packaging: [{ size: '1kg', priceKES: null }] }]), /needs a price/);
      assert.match(findProductRuleViolation([{ varietyName: 'W', packaging: [{ size: '1kg', priceKES: 0 }] }]), /needs a price/);
      assert.equal(findProductRuleViolation([{ varietyName: 'W', packaging: [{ size: 'Bulk', priceKES: null, quoteOnly: true }] }]), null);
    });

    test('service refuses to create a product with duplicate variety names', async () => {
      await assert.rejects(productService.create({
        name: 'Dupe', category: 'Cereals',
        varieties: [
          { varietyName: 'White', packaging: [{ size: '50kg', priceKES: 100, stock: 1 }] },
          { varietyName: 'White', packaging: [{ size: '50kg', priceKES: 100, stock: 1 }] },
        ],
      }, admin._id, branch._id), (e) => e.errorCode === 'INVALID_PRODUCT_STRUCTURE');
    });

    test('an order cannot be placed for a packaging with no price', async () => {
      const free = await createProduct(branch._id, admin._id, { name: 'NoPrice', packaging: { priceKES: null, stock: 10 } });
      await assert.rejects(
        orderService.createGuestOrder({
          name: 'J', phone: '0712345679', orderItems: [cartItemFor(free, { quantity: 3 })],
          deliveryMethod: 'pickup', paymentMethod: 'pickup',
        }, branch._id),
        (e) => e.errorCode === 'PRICE_NOT_SET'
      );
    });

    test('renaming a pack size that an open order uses is refused', async () => {
      await placeGuest(branch, product, { paymentMethod: 'pickup' });
      await assert.rejects(productService.update(product._id, {
        varieties: [{ varietyName: 'Yellow', packaging: [{ size: '50 kg', priceKES: 1000, stock: 0, lowStockThreshold: 10 }] }],
      }, admin._id, branch._id), (e) => e.errorCode === 'PACKAGING_IN_USE');
    });

    test('an order whose packaging was removed anyway can still be cancelled', async () => {
      const order = await placeGuest(branch, product, { paymentMethod: 'pickup' });
      // Simulate legacy damage: the line is gone from the catalogue behind the order's back.
      await Product.updateOne({ _id: product._id }, { $set: { 'varieties.0.packaging.0.size': '50 kg' } });
      const cancelled = await orderService.updateStatus(order._id, 'cancelled', admin._id, 'cleanup', branch._id, 'admin');
      assert.equal(cancelled.status, 'cancelled');
    });
  });

  describe('excel import', () => {
    test('a re-import keeps volume tiers and cost price', async () => {
      const p = await createProduct(branch._id, admin._id, {
        name: 'Tiered', packaging: { pricingTiers: [{ minQty: 10, priceKES: 900 }], costPriceKES: 700, stock: 40 },
      });
      const buf = await importExport.exportProducts(branch._id);
      await importExport.importProducts(buf, admin._id, { branchId: branch._id, actorRole: 'admin' });
      const pkg = (await Product.findById(p._id).lean()).varieties[0].packaging[0];
      assert.equal(pkg.pricingTiers.length, 1);
      assert.equal(pkg.costPriceKES, 700);
    });

    test('a blank Active cell leaves an existing product switched on', async () => {
      const p = await createProduct(branch._id, admin._id, { name: 'Stays On', isActive: true });
      const buf = await importExport.exportProducts(branch._id);
      const wb = XLSX.read(buf, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      ws.D2 = { t: 's', v: '' };
      const edited = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      await importExport.importProducts(edited, admin._id, { branchId: branch._id, actorRole: 'admin' });
      assert.equal((await Product.findById(p._id).lean()).isActive, true);
    });

    test('a zero price is a row error unless the packaging is quote-only', () => {
      const row = ['P', 'C', '', 'TRUE', 'V', '', '50kg', 0, 5, 10, 'FALSE', '', 'TRUE'];
      assert.equal(importExport.__private.validateRow(row, 2).valid, false);
    });
  });

  describe('catalogue search', () => {
    test('partial words fall back to a substring match', async () => {
      await Product.init();
      await createProduct(branch._id, admin._id, { name: 'Yellow Maize', isActive: true });
      const whole = await productService.getAll({ search: 'maize' }, {}, branch._id);
      const part = await productService.getAll({ search: 'mai' }, {}, branch._id);
      const none = await productService.getAll({ search: 'zzzz' }, {}, branch._id);
      assert.equal(whole.products.length >= 1, true);
      assert.equal(part.products.length >= 1, true);
      assert.equal(none.products.length, 0);
    });
  });

  // ── accounts ───────────────────────────────────────────────────────────────
  describe('phone numbers and lockout', () => {
    const PW = 'Passw0rdX';

    test('one number cannot register twice in different formats; any format can log in', async () => {
      await authService.register({ name: 'A One', phone: '+254712111222', password: PW });
      await assert.rejects(authService.register({ name: 'A Two', phone: '0712111222', password: PW }), (e) => e.errorCode === 'PHONE_TAKEN');
      assert.equal(await User.countDocuments({ phone: /712111222/ }), 1);

      const stored = await User.findOne({ phone: /712111222/ }).lean();
      assert.equal(stored.phone, '0712111222', 'new accounts are stored in local format');
      for (const typed of ['0712111222', '+254712111222']) {
        const res = await authService.login({ phone: typed, password: PW }, '1.1.1.1');
        assert.equal(res.requiresBranchSelection, false);
      }
    });

    test('an account stored in the old +254 form is still found', async () => {
      await createUser(branch._id, { phone: '+254799888777', role: 'customer', passwordHash: await require('bcryptjs').hash(PW, 4) });
      const res = await authService.login({ phone: '0799888777', password: PW }, '1.1.1.1');
      assert.equal(res.requiresBranchSelection, false);
    });

    test('five wrong passwords block sign-in temporarily, not permanently', async () => {
      await authService.register({ name: 'Lock Me', phone: '0701234567', password: PW });
      for (let i = 0; i < 5; i++) {
        await assert.rejects(authService.login({ phone: '0701234567', password: 'Wrong1234' }, '1.1.1.1'), (e) => e.errorCode === 'INVALID_CREDENTIALS');
      }
      await assert.rejects(authService.login({ phone: '0701234567', password: PW }, '1.1.1.1'), (e) => e.errorCode === 'ACCOUNT_TEMP_LOCKED' && e.statusCode === 429);

      const u = await User.findOne({ phone: '0701234567' });
      assert.equal(u.isLocked, false, 'not a permanent lock');
      u.loginLockedUntil = new Date(Date.now() - 1000);
      await u.save();
      const ok = await authService.login({ phone: '0701234567', password: PW }, '1.1.1.1');
      assert.equal(ok.requiresBranchSelection, false);
    });
  });

  // ── coupons ────────────────────────────────────────────────────────────────
  describe('coupons', () => {
    test('a percentage coupon cannot be edited above 100%', async () => {
      const c = await couponService.create({ code: 'TEN', discountType: 'percentage', discountValue: 10 }, branch._id, admin._id);
      await assert.rejects(couponService.update(c._id, { discountValue: 500 }, branch._id), (e) => e.errorCode === 'INVALID_DISCOUNT');
      await assert.rejects(couponService.update(c._id, { discountType: 'percentage', discountValue: 101 }, branch._id), (e) => e.errorCode === 'INVALID_DISCOUNT');
      const ok = await couponService.update(c._id, { discountType: 'fixed', discountValue: 500 }, branch._id);
      assert.equal(ok.discountValue, 500);
    });

    test('per-customer limit stops reuse by a customer and by a returning guest', async () => {
      await couponService.create({ code: 'ONCE', discountType: 'fixed', discountValue: 100, perCustomerLimit: 1 }, branch._id, admin._id);
      const customer = await createUser(branch._id, { phone: '0700000009' });

      await orderService.createCustomerOrder({
        orderItems: [cartItemFor(product, { quantity: 1 })], deliveryMethod: 'pickup', paymentMethod: 'pickup', couponCode: 'ONCE',
      }, customer._id, branch._id);
      await assert.rejects(couponService.validate('ONCE', branch._id, customer._id, 1000), (e) => e.errorCode === 'COUPON_CUSTOMER_LIMIT');

      await orderService.createGuestOrder({
        name: 'G', phone: '0755555555', orderItems: [cartItemFor(product, { quantity: 1 })],
        deliveryMethod: 'pickup', paymentMethod: 'pickup', couponCode: 'ONCE',
      }, branch._id);
      await assert.rejects(couponService.validate('ONCE', branch._id, null, 1000, '+254755555555'), (e) => e.errorCode === 'COUPON_CUSTOMER_LIMIT');
    });
  });

  // ── order records ──────────────────────────────────────────────────────────
  test('a guest order snapshots the name given at checkout, and customers can see the discount', async () => {
    await orderService.createGuestOrder({
      name: 'First Name', phone: '0766666666', orderItems: [cartItemFor(product, { quantity: 1 })],
      deliveryMethod: 'pickup', paymentMethod: 'pickup',
    }, branch._id);
    const second = await orderService.createGuestOrder({
      name: 'Second Person', phone: '0766666666', orderItems: [cartItemFor(product, { quantity: 2 })],
      deliveryMethod: 'pickup', paymentMethod: 'pickup',
    }, branch._id);
    assert.equal(second.guestName, 'Second Person');

    await couponService.create({ code: 'SAVE', discountType: 'fixed', discountValue: 50 }, branch._id, admin._id);
    const customer = await createUser(branch._id, { phone: '0700000010' });
    const withCoupon = await orderService.createCustomerOrder({
      orderItems: [cartItemFor(product, { quantity: 1 })], deliveryMethod: 'pickup', paymentMethod: 'pickup', couponCode: 'SAVE',
    }, customer._id, branch._id);
    const seen = await orderService.getMyOrderById(customer._id, withCoupon._id);
    assert.equal(seen.couponDiscount, 50);
    assert.equal(seen.couponCode, 'SAVE');
  });

  test('distance pricing with no location shared is flagged on the order', async () => {
    await Settings.updateOne({ branchId: branch._id }, { deliveryPricingMode: 'distance', deliveryFee: 300 });
    settingsService.invalidateCache(branch._id);
    const o = await placeGuest(branch, product, { deliveryMethod: 'delivery', deliveryAddress: 'Far away', paymentMethod: 'delivery', phone: '0777000111' });
    assert.match(o.statusHistory[0].note, /no location shared/);
  });

  test('bulk actions run one at a time and report each result', async () => {
    const a = await placeGuest(branch, product, { paymentMethod: 'pickup', phone: '0788000001' });
    const b = await placeGuest(branch, product, { paymentMethod: 'pickup', phone: '0788000002' });
    await orderService.updateStatus(b._id, 'cancelled', admin._id, 'x', branch._id, 'admin');
    const res = await orderService.bulkApprove([a._id.toString(), b._id.toString()], admin._id, branch._id);
    assert.equal(res.approved.length, 1);
    assert.equal(res.failed.length, 1);
  });
});
