// Reports page upgrade (2026-10): sales shows how much of the revenue is paid and compares with the previous
// period; the orders report returns the whole 24-hour profile; slow movers say how long, how much stock and how
// much money is tied up; the customer list can be narrowed to a segment (who has stopped ordering).
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const testDb = require('./helpers/testDb');
const { createBranch, createUser, createProduct } = require('./helpers/fixtures');
const Order = require('../src/models/Order');
require('../src/models/Guest');
const reportService = require('../src/services/report.service');

before(async () => { await testDb.connect(); });
after(async () => { await testDb.disconnect(); });

const DAY = 24 * 3600 * 1000;
let seq = 0;
const makeOrder = (branch, overrides = {}) => Order.create({
  orderRef: `ORD-RI-${++seq}`, orderItems: [], subtotal: 1000, total: 1000, deliveryMethod: 'pickup',
  paymentMethod: 'pickup', branchId: branch._id, status: 'completed', paymentStatus: 'paid', ...overrides,
});
const line = (product, over = {}) => ({
  productId: product._id, productName: product.name, variety: 'Yellow', packaging: '50kg', quantity: 1, unitPrice: 1000, lineTotal: 1000, ...over,
});

describe('sales report: collected vs outstanding, and the previous period', () => {
  let branch;
  beforeEach(async () => {
    await testDb.clearDatabase();
    reportService._clearReportCache();
    branch = await createBranch();
  });

  test('splits revenue into paid and not-yet-paid, counting only approved-onwards orders', async () => {
    await makeOrder(branch, { total: 1000, paymentStatus: 'paid' });
    await makeOrder(branch, { total: 400, paymentStatus: 'paid', status: 'approved' });
    await makeOrder(branch, { total: 600, paymentStatus: 'unpaid', status: 'out_for_delivery' });   // owed
    await makeOrder(branch, { total: 250, paymentStatus: 'refunded', status: 'completed' });         // not money in hand
    await makeOrder(branch, { total: 9000, paymentStatus: 'unpaid', status: 'pending' });            // not revenue yet
    await makeOrder(branch, { total: 7000, paymentStatus: 'refunded', status: 'cancelled' });        // never revenue
    const { summary } = await reportService.getSalesReport('month', null, null, branch._id);
    assert.equal(summary.totalRevenue, 2250);
    assert.equal(summary.paidRevenue, 1400);
    assert.equal(summary.paidOrders, 2);
    assert.equal(summary.unpaidRevenue, 850);
    assert.equal(summary.unpaidOrders, 2);
    assert.equal(summary.paidRevenue + summary.unpaidRevenue, summary.totalRevenue, 'the two halves add up to the whole');
  });

  test('compares with the window of the same length straight before it', async () => {
    const now = Date.now();
    await makeOrder(branch, { total: 3000, createdAt: new Date(now - 2 * DAY) });        // this week
    await makeOrder(branch, { total: 1000, createdAt: new Date(now - 9 * DAY) });        // the week before
    await makeOrder(branch, { total: 2000, createdAt: new Date(now - 10 * DAY) });       // the week before
    await makeOrder(branch, { total: 500, createdAt: new Date(now - 30 * DAY) });        // older: in neither
    const r = await reportService.getSalesReport('week', null, null, branch._id);
    assert.equal(r.summary.totalRevenue, 3000);
    assert.equal(r.previous.totalRevenue, 3000);
    assert.equal(r.previous.totalOrders, 2);
    assert.equal(r.previous.avgOrderValue, 1500);
    assert.ok(new Date(r.previous.end) < new Date(r.period.start), 'the previous window ends before this one starts');
    assert.ok(Math.abs((new Date(r.previous.end) - new Date(r.previous.start)) - (new Date(r.period.end) - new Date(r.period.start))) <= 2,
      'and is the same length');
  });

  test('a custom range is compared with the equal span before it, per branch', async () => {
    const other = await createBranch({ name: 'Other', slug: 'other', isDefault: false });
    await makeOrder(branch, { total: 800, createdAt: new Date('2026-09-15T09:00:00+03:00') });
    await makeOrder(branch, { total: 1200, createdAt: new Date('2026-09-25T09:00:00+03:00') });
    await makeOrder(other, { total: 99999, createdAt: new Date('2026-09-15T09:00:00+03:00') });  // another branch
    const r = await reportService.getSalesReport(null, '2026-09-21', '2026-09-30', branch._id);
    assert.equal(r.summary.totalRevenue, 1200);
    assert.equal(r.previous.totalRevenue, 800, '21-30 Sept is compared with the ten days before it (11-20 Sept)');
  });
});

describe('orders report: the whole day by hour', () => {
  test('returns 24 hours on the Nairobi clock, zeros included, with the busiest five kept', async () => {
    await testDb.clearDatabase();
    const branch = await createBranch();
    const at = (hourEAT) => new Date(`2026-10-20T${String(hourEAT).padStart(2, '0')}:15:00+03:00`);
    await makeOrder(branch, { createdAt: at(9) });
    await makeOrder(branch, { createdAt: at(9) });
    await makeOrder(branch, { createdAt: at(14) });
    await makeOrder(branch, { createdAt: at(0) });         // 00:15 EAT is 21:15 UTC the day before
    const r = await reportService.getOrdersByStatus(null, '2026-10-20', '2026-10-20', branch._id);
    assert.equal(r.byHour.length, 24);
    assert.deepEqual(r.byHour.map(h => h.hour), Array.from({ length: 24 }, (_, i) => i));
    assert.equal(r.byHour[9].orders, 2);
    assert.equal(r.byHour[14].orders, 1);
    assert.equal(r.byHour[0].orders, 1, 'the midnight order is bucketed on the Nairobi clock, not UTC');
    assert.equal(r.byHour[3].orders, 0);
    assert.equal(r.peakHours[0].hour, 9);
    assert.ok(r.peakHours.length <= 5);
  });
});

describe('slow movers: how long, how much stock, how much money', () => {
  let branch; let admin;
  beforeEach(async () => {
    await testDb.clearDatabase();
    reportService._clearReportCache();
    branch = await createBranch();
    admin = await createUser(branch._id, { role: 'admin' });
  });

  test('lists only products with no sale in the window, biggest money tied up first, with last-sold dates', async () => {
    const selling = await createProduct(branch._id, admin._id, { name: 'Selling' });
    const old = await createProduct(branch._id, admin._id, { name: 'Sold long ago', packaging: { stock: 10, priceKES: 1000, costPriceKES: 800 } });
    const never = await createProduct(branch._id, admin._id, { name: 'Never sold', packaging: { stock: 50, priceKES: 500 } });   // no cost: retail fallback
    await createProduct(branch._id, admin._id, { name: 'Out of stock', packaging: { stock: 0, priceKES: 700, costPriceKES: 600 } });
    await makeOrder(branch, { orderItems: [line(selling)], createdAt: new Date(Date.now() - 3 * DAY) });
    await makeOrder(branch, { orderItems: [line(old)], createdAt: new Date(Date.now() - 100 * DAY) });
    await makeOrder(branch, { orderItems: [line(old)], createdAt: new Date(Date.now() - 200 * DAY), status: 'cancelled' });  // never counts

    const r = await reportService.getSlowMovers(30, branch._id);
    const names = r.slowMovers.map(m => m.name);
    assert.deepEqual(names, ['Never sold', 'Sold long ago', 'Out of stock'], 'sorted by value tied up');
    const byName = Object.fromEntries(r.slowMovers.map(m => [m.name, m]));

    assert.equal(byName['Never sold'].stockValueKES, 25000);            // 50 x 500 retail fallback
    assert.equal(byName['Never sold'].usedRetailFallback, true);
    assert.equal(byName['Never sold'].neverSold, true);
    assert.equal(byName['Never sold'].daysWithoutSale, null);

    assert.equal(byName['Sold long ago'].stockValueKES, 8000);          // 10 x 800 cost
    assert.equal(byName['Sold long ago'].usedRetailFallback, false);
    assert.equal(byName['Sold long ago'].neverSold, false);
    assert.ok(byName['Sold long ago'].daysWithoutSale >= 99 && byName['Sold long ago'].daysWithoutSale <= 101,
      `last real sale was 100 days ago, got ${byName['Sold long ago'].daysWithoutSale}`);

    assert.equal(byName['Out of stock'].stockValueKES, 0);
    assert.equal(r.count, 3);
    assert.equal(r.totalValueTiedUpKES, 33000);
  });

  test('stays within one branch, and a wider window drops products that did sell inside it', async () => {
    const other = await createBranch({ name: 'Other', slug: 'other2', isDefault: false });
    const p = await createProduct(branch._id, admin._id, { name: 'Mine' });
    await createProduct(other._id, admin._id, { name: 'Theirs' });
    await makeOrder(branch, { orderItems: [line(p)], createdAt: new Date(Date.now() - 60 * DAY) });
    assert.deepEqual((await reportService.getSlowMovers(30, branch._id)).slowMovers.map(m => m.name), ['Mine']);
    assert.deepEqual((await reportService.getSlowMovers(90, branch._id)).slowMovers, [], 'it sold 60 days ago, inside 90');
  });
});

describe('customer report: narrowing to a segment', () => {
  let branch; let admin;
  const customer = (name) => createUser(null, { role: 'customer', name, phone: `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` });
  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
    admin = await createUser(branch._id, { role: 'admin' });
  });

  const seedCustomers = async () => {
    const lapsed = await customer('Lapsed Big');          // 1 big order 90 days ago
    const lapsed2 = await customer('Lapsed Small');       // 1 small order 40 days ago
    const regular = await customer('Regular');            // 3 recent orders
    const fresh = await customer('Fresh');                // 1 order yesterday
    await makeOrder(branch, { userId: lapsed._id, total: 50000, createdAt: new Date(Date.now() - 90 * DAY) });
    await makeOrder(branch, { userId: lapsed2._id, total: 800, createdAt: new Date(Date.now() - 40 * DAY) });
    for (const d of [1, 5, 9]) await makeOrder(branch, { userId: regular._id, total: 2000, createdAt: new Date(Date.now() - d * DAY) });
    await makeOrder(branch, { userId: fresh._id, total: 1500, createdAt: new Date(Date.now() - 1 * DAY) });
    return { lapsed, lapsed2, regular, fresh };
  };

  test('"inactive" lists only customers who stopped ordering, most valuable first, and the counts do not move', async () => {
    await seedCustomers();
    const all = await reportService.getCustomerReport(branch._id, {});
    const inactive = await reportService.getCustomerReport(branch._id, { segment: 'inactive' });
    assert.deepEqual(inactive.customers.map(c => c.name), ['Lapsed Big', 'Lapsed Small']);
    assert.equal(inactive.segment, 'inactive');
    assert.equal(inactive.pagination.total, 2, 'the pager counts the filtered list');
    assert.equal(inactive.total, all.total, 'while the headline total still counts everyone');
    assert.equal(inactive.inactive, all.inactive);
    assert.equal(inactive.repeat, all.repeat);
    assert.equal(all.customers.length, 4);
  });

  test('"repeat" and "highValue" narrow the same way', async () => {
    await seedCustomers();
    assert.deepEqual((await reportService.getCustomerReport(branch._id, { segment: 'repeat' })).customers.map(c => c.name), ['Regular']);
    const hv = await reportService.getCustomerReport(branch._id, { segment: 'highValue' });
    assert.ok(hv.customers.every(c => c.isHighValue));
    assert.equal(hv.customers[0].name, 'Lapsed Big');
  });

  test('pages within a segment, and an unknown segment means everyone rather than an error', async () => {
    await seedCustomers();
    const p1 = await reportService.getCustomerReport(branch._id, { segment: 'inactive', limit: 1, page: 1 });
    const p2 = await reportService.getCustomerReport(branch._id, { segment: 'inactive', limit: 1, page: 2 });
    assert.equal(p1.customers[0].name, 'Lapsed Big');
    assert.equal(p2.customers[0].name, 'Lapsed Small');
    assert.equal(p1.pagination.pages, 2);
    const bogus = await reportService.getCustomerReport(branch._id, { segment: '$where' });
    assert.equal(bogus.segment, 'all');
    assert.equal(bogus.customers.length, 4);
  });
});
