process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const testDb = require('./helpers/testDb');
const { createBranch, createUser, createProduct } = require('./helpers/fixtures');
const Order = require('../src/models/Order');
const stockService = require('../src/services/stock.service');

before(async () => { await testDb.connect(); });
after(async () => { await testDb.disconnect(); });

let seq = 0;
const orderOf = (branch, product, qty, overrides = {}) => Order.create({
  orderRef: `ORD-FC-${++seq}`, subtotal: qty * 1000, total: qty * 1000,
  deliveryMethod: 'pickup', paymentMethod: 'pickup', branchId: branch._id, status: 'completed',
  orderItems: [{ productId: product._id, productName: product.name, variety: 'Yellow', packaging: '50kg', quantity: qty, unitPrice: 1000, lineTotal: qty * 1000 }],
  ...overrides,
});

// An item-less order dated 30 days ago: gives the shop a full month of history, so a 30-unit sale
// reads as one a day instead of being squeezed into the days the shop has existed.
const withMonthOfHistory = async (branch) => {
  const base = await Order.create({
    orderRef: `ORD-BASE-${++seq}`, orderItems: [], subtotal: 0, total: 0,
    deliveryMethod: 'pickup', paymentMethod: 'pickup', branchId: branch._id, status: 'completed',
  });
  await Order.collection.updateOne({ _id: base._id }, { $set: { createdAt: new Date(Date.now() - 30 * 86400000 + 60000) } });
};

describe('stock.service — forecast', () => {
  let branch, admin;
  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
    admin = await createUser(branch._id, { role: 'admin' });
    await withMonthOfHistory(branch);
  });

  test('works out days left from the recent selling pace', async () => {
    const product = await createProduct(branch._id, admin._id, { packaging: { stock: 20 } });
    await orderOf(branch, product, 30); // 30 units in a 30-day window = 1 a day

    const [row] = await stockService.getForecast(branch._id);
    assert.equal(row.perDay, 1);
    assert.equal(row.daysLeft, 20);
    assert.equal(row.severity, 'ok');
  });

  test('grades urgency and sorts the most urgent first', async () => {
    const fast = await createProduct(branch._id, admin._id, { name: 'Fast', packaging: { stock: 6 } });
    const slow = await createProduct(branch._id, admin._id, { name: 'Slow', packaging: { stock: 90 } });
    await orderOf(branch, fast, 60); // 2 a day -> 3 days
    await orderOf(branch, slow, 30); // 1 a day -> 90 days

    const rows = await stockService.getForecast(branch._id);
    assert.deepEqual(rows.map(r => r.productName), ['Fast', 'Slow']);
    assert.equal(rows[0].daysLeft, 3);
    assert.equal(rows[0].severity, 'critical');
  });

  test('counts pending demand but ignores cancelled and rejected orders and old sales', async () => {
    const product = await createProduct(branch._id, admin._id, { packaging: { stock: 10 } });
    await orderOf(branch, product, 15, { status: 'pending' });
    await orderOf(branch, product, 500, { status: 'cancelled' });
    await orderOf(branch, product, 500, { status: 'rejected' });
    const old = await orderOf(branch, product, 500);
    await Order.collection.updateOne({ _id: old._id }, { $set: { createdAt: new Date(Date.now() - 90 * 86400000) } });

    const [row] = await stockService.getForecast(branch._id);
    assert.equal(row.unitsSold, 15);
  });

  test('skips items that never sold and never mixes in another branch', async () => {
    const other = await createBranch({ name: 'Other', isDefault: false });
    const otherAdmin = await createUser(other._id, { role: 'admin' });
    const mine = await createProduct(branch._id, admin._id, { name: 'Unsold' });
    const theirs = await createProduct(other._id, otherAdmin._id, { name: 'Theirs' });
    await orderOf(other, theirs, 10);

    const rows = await stockService.getForecast(branch._id);
    assert.equal(rows.length, 0);
    assert.ok(mine);
  });

  test('a young shop is measured over its real history, not a full month', async () => {
    await testDb.clearDatabase();
    const fresh = await createBranch({ name: 'Fresh', isDefault: false });
    const freshAdmin = await createUser(fresh._id, { role: 'admin' });
    const product = await createProduct(fresh._id, freshAdmin._id, { packaging: { stock: 10 } });
    await orderOf(fresh, product, 14); // all sold today: floor of 7 days -> 2 a day, 5 days left

    const [row] = await stockService.getForecast(fresh._id);
    assert.equal(row.windowDays, 7);
    assert.equal(row.perDay, 2);
    assert.equal(row.daysLeft, 5);
  });

  test('an item already at zero is critical with no days left', async () => {
    const product = await createProduct(branch._id, admin._id, { packaging: { stock: 0 } });
    await orderOf(branch, product, 5);
    const [row] = await stockService.getForecast(branch._id);
    assert.equal(row.daysLeft, 0);
    assert.equal(row.severity, 'critical');
  });
});
