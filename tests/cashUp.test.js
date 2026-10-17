process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const testDb = require('./helpers/testDb');
const { createBranch, createUser, objectId } = require('./helpers/fixtures');
const Order = require('../src/models/Order');
const Payment = require('../src/models/Payment');
const reportService = require('../src/services/report.service');

before(async () => { await testDb.connect(); });
after(async () => { await testDb.disconnect(); });

let seq = 0;
const makeOrder = (branch, overrides = {}) => Order.create({
  orderRef: `ORD-CU-${++seq}`, orderItems: [], subtotal: 1000, total: 1000,
  deliveryMethod: 'delivery', paymentMethod: 'delivery', branchId: branch._id,
  status: 'completed', paymentStatus: 'unpaid', deliveredAt: new Date(), ...overrides,
});
const makePayment = (order, overrides = {}) => Payment.create({
  orderId: order._id, method: 'delivery', amount: order.total, status: 'paid', paidAt: new Date(), ...overrides,
});

describe('report.service — cash-up and reconciliation', () => {
  let branch, other, driver, admin;
  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
    other = await createBranch({ name: 'Other', isDefault: false });
    driver = await createUser(branch._id, { role: 'driver', name: 'Dan' });
    admin = await createUser(branch._id, { role: 'admin', name: 'Ann' });
  });

  test('separates automatic M-Pesa, manually confirmed M-Pesa and cash', async () => {
    const a = await makeOrder(branch, { paymentMethod: 'mpesa', paymentStatus: 'paid', deliveryMethod: 'pickup' });
    const b = await makeOrder(branch, { paymentMethod: 'mpesa', paymentStatus: 'paid', deliveryMethod: 'pickup', total: 500, subtotal: 500 });
    const c = await makeOrder(branch, { paymentStatus: 'paid' });
    await makePayment(a, { method: 'mpesa', mpesaTransactionId: 'QAAAAAAAA1' });
    await makePayment(b, { method: 'mpesa', mpesaTransactionId: 'QAAAAAAAA2', confirmedBy: admin._id });
    await makePayment(c, { confirmedBy: admin._id });

    const r = await reportService.getCashUpReport('today', null, null, branch._id);
    assert.deepEqual(r.byMethod.mpesaAutomatic, { count: 1, amount: 1000 });
    assert.deepEqual(r.byMethod.mpesaManual, { count: 1, amount: 500 });
    assert.deepEqual(r.byMethod.cash, { count: 1, amount: 1000 });
    assert.equal(r.totalIn, 2500);
    assert.equal(r.cashByCollector[0].name, 'Ann');
  });

  test('shows what each driver still has to account for', async () => {
    const paid = await makeOrder(branch, { driverId: driver._id, paymentStatus: 'paid', total: 700, subtotal: 700 });
    await makePayment(paid, { confirmedBy: admin._id });
    await makeOrder(branch, { driverId: driver._id, total: 300, subtotal: 300 }); // delivered, not yet confirmed

    const r = await reportService.getCashUpReport('today', null, null, branch._id);
    assert.equal(r.drivers.length, 1);
    assert.equal(r.drivers[0].driverName, 'Dan');
    assert.equal(r.drivers[0].due, 1000);
    assert.equal(r.drivers[0].confirmed, 700);
    assert.equal(r.drivers[0].outstanding, 300);
    assert.equal(r.totals.cashOutstanding, 300);
    assert.equal(r.exceptions.unpaidCompleted.length, 1);
  });

  test('flags M-Pesa money that arrived late and prompts stuck unresolved', async () => {
    const late = await makeOrder(branch, { paymentMethod: 'mpesa', status: 'pending', deliveryMethod: 'pickup' });
    await makePayment(late, { method: 'mpesa', status: 'failed', paidAt: null,
      lateSuccessMeta: { mpesaTransactionId: 'QLATE00001', paidAmount: 1000, receivedAt: new Date() } });
    const stuck = await makeOrder(branch, { paymentMethod: 'mpesa', status: 'pending', deliveryMethod: 'pickup' });
    const p = await makePayment(stuck, { method: 'mpesa', status: 'pending', paidAt: null });
    await Payment.collection.updateOne({ _id: p._id }, { $set: { createdAt: new Date(Date.now() - 40 * 60 * 1000) } });
    const fresh = await makeOrder(branch, { paymentMethod: 'mpesa', status: 'pending', deliveryMethod: 'pickup' });
    await makePayment(fresh, { method: 'mpesa', status: 'pending', paidAt: null }); // still inside the 15 minute window

    const r = await reportService.getCashUpReport('today', null, null, branch._id);
    assert.equal(r.exceptions.lateSuccess.length, 1);
    assert.equal(r.exceptions.stuckPending.length, 1);
  });

  test('never includes another branch', async () => {
    const mine = await makeOrder(branch, { paymentStatus: 'paid' });
    const theirs = await makeOrder(other, { paymentStatus: 'paid' });
    await makePayment(mine);
    await makePayment(theirs, { amount: 9999 });
    await makeOrder(other, { driverId: objectId() });

    const r = await reportService.getCashUpReport('today', null, null, branch._id);
    assert.equal(r.totalIn, 1000);
    assert.equal(r.drivers.length, 0);
  });
});
