// 2026-10 audit F-33 (price guard), F-19 (auto-cancel vs paid orders), F-20 (internal notes stay internal).
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const testDb = require('./helpers/testDb');
const { createBranch, createSettings, createUser, createProduct, cartItemFor, objectId } = require('./helpers/fixtures');
const orderService = require('../src/services/order.service');
const Order = require('../src/models/Order');
const Settings = require('../src/models/Settings');
const settingsService = require('../src/services/settings.service');

before(async () => { await testDb.connect(); });
after(async () => { await testDb.disconnect(); });

describe('order guards', () => {
  let branch; let admin; let product; let seq = 0;
  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
    await createSettings(branch._id);
    admin = await createUser(branch._id, { role: 'admin' });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 500, priceKES: 1000 } });
  });

  const guest = (extra = {}) => orderService.createGuestOrder({
    name: 'Jane', phone: `07${40000000 + (++seq)}`,
    orderItems: [cartItemFor(product, { quantity: 2 })], deliveryMethod: 'pickup', paymentMethod: 'pickup', ...extra,
  }, branch._id);

  describe('expectedTotal (F-33)', () => {
    test('a price that moved since the customer looked is refused with the new total', async () => {
      await assert.rejects(
        guest({ expectedTotal: 1500 }),    // customer saw 1,500; the live total is 2,000
        (e) => e.statusCode === 409 && e.errorCode === 'PRICE_CHANGED' && /2,000/.test(e.message)
      );
      assert.equal(await Order.countDocuments(), 0, 'nothing was created or reserved');
    });
    test('a matching total (within a shilling) goes through; a missing or junk hint is ignored', async () => {
      assert.ok((await guest({ expectedTotal: 2000 })).orderRef);
      assert.ok((await guest({ expectedTotal: 1999.5 })).orderRef);
      assert.ok((await guest({})).orderRef);
      assert.ok((await guest({ expectedTotal: 'abc' })).orderRef);
    });
    test('a signed-in customer is guarded the same way', async () => {
      const customer = await createUser(null, { role: 'customer', branchId: null, phone: '0711999888' });
      await assert.rejects(
        orderService.createCustomerOrder({ orderItems: [cartItemFor(product, { quantity: 2 })], deliveryMethod: 'pickup', paymentMethod: 'pickup', expectedTotal: 100 }, customer._id, branch._id),
        (e) => e.errorCode === 'PRICE_CHANGED'
      );
    });
  });

  describe('auto-cancel (F-19)', () => {
    const age = (id, hours) => Order.collection.updateOne({ _id: id }, { $set: { createdAt: new Date(Date.now() - hours * 3600 * 1000) } });
    beforeEach(async () => {
      await Settings.updateOne({ branchId: branch._id }, { autoCancelHours: 24 });
      settingsService.invalidateCache(branch._id);
    });

    test('an old unpaid pending order is cancelled; a paid one and one with a prompt in flight are left for staff', async () => {
      const unpaid = await guest();
      const paid = await guest({ paymentMethod: 'mpesa' });
      const prompting = await guest({ paymentMethod: 'mpesa' });
      await Order.updateOne({ _id: paid._id }, { paymentStatus: 'paid' });
      await Order.updateOne({ _id: prompting._id }, { paymentStatus: 'pending' });
      for (const o of [unpaid, paid, prompting]) await age(o._id, 30);

      await orderService.autoCancelExpiredPendingOrders(branch._id);

      const status = async (o) => (await Order.findById(o._id).lean()).status;
      assert.equal(await status(unpaid), 'cancelled');
      assert.equal(await status(paid), 'pending', 'money already taken: do not cancel');
      assert.equal(await status(prompting), 'pending', 'the M-Pesa prompt may still complete');
    });
  });

  describe('what customers can see of an order history (F-20)', () => {
    test('internal notes and staff ids never reach the customer or the tracking page', async () => {
      const customer = await createUser(null, { role: 'customer', branchId: null, phone: '0711555444' });
      const order = await orderService.createCustomerOrder({
        orderItems: [cartItemFor(product)], deliveryMethod: 'pickup', paymentMethod: 'pickup',
      }, customer._id, branch._id);
      await Order.updateOne({ _id: order._id }, {
        $push: { statusHistory: { status: 'approved', changedAt: new Date(), changedBy: admin._id, note: 'INTERNAL: check distance before approving', publicNote: 'Your order is approved' } },
      });

      const mine = await orderService.getMyOrderById(customer._id, order._id);
      const text = JSON.stringify(mine.statusHistory);
      assert.ok(!text.includes('INTERNAL'), text);
      assert.ok(!text.includes(String(admin._id)), 'no staff id');
      assert.ok(text.includes('Your order is approved'), 'the public note is shown');
      for (const h of mine.statusHistory) assert.deepEqual(Object.keys(h).sort(), ['changedAt', 'note', 'status']);

      const list = await orderService.getMyOrders(customer._id, {}, branch._id);
      assert.ok(!JSON.stringify(list).includes('INTERNAL'));
    });

    test('the guest tracking lookup is just as clean', async () => {
      const o = await guest();
      const row = await Order.findById(o._id).lean();
      await Order.updateOne({ _id: o._id }, { $set: { 'statusHistory.0.note': 'INTERNAL remark' } });
      const tracked = await orderService.trackByRef(row.guestPhone, row.orderRef);
      assert.ok(!JSON.stringify(tracked).includes('INTERNAL'));
      assert.ok(objectId());
    });
  });
});
