// 2026-10 audit F-10 / F-15 / F-16 / F-22 / F-43: report speed fixes must not change the numbers, the revenue
// breakdown must reconcile, VAT gets a taxable/exempt split, eTIMS dates follow the Nairobi clock, and the
// payment branch denormalisation + migrations work.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const testDb = require('./helpers/testDb');
const { createBranch, createUser, createProduct, objectId } = require('./helpers/fixtures');
const Order = require('../src/models/Order');
const Payment = require('../src/models/Payment');
const User = require('../src/models/User');
require('../src/models/Guest'); // getDashboardKPIs populates guestId, so the model must be registered
const reportService = require('../src/services/report.service');
const { buildPayload } = require('../src/services/etims.service');
const { MIGRATIONS } = require('../src/utils/migrations');
const { createTtlCache } = require('../src/utils/ttlCache');

before(async () => { await testDb.connect(); });
after(async () => { await testDb.disconnect(); });

let seq = 0;
const makeOrder = (branch, overrides = {}) => Order.create({
  orderRef: `ORD-RP-${++seq}`, orderItems: [], subtotal: 1000, total: 1000, deliveryMethod: 'pickup',
  paymentMethod: 'pickup', branchId: branch._id, status: 'completed', paymentStatus: 'paid', deliveredAt: new Date(), ...overrides,
});
const line = (product, over = {}) => ({
  productId: product._id, productName: product.name, variety: 'Yellow', packaging: '50kg', quantity: 2, unitPrice: 500, lineTotal: 1000, ...over,
});

describe('sales report', () => {
  let branch; let admin; let maize; let beans;
  beforeEach(async () => {
    await testDb.clearDatabase();
    reportService._clearReportCache();
    branch = await createBranch();
    admin = await createUser(branch._id, { role: 'admin' });
    maize = await createProduct(branch._id, admin._id, { name: 'Maize', category: 'Cereals' });
    beans = await createProduct(branch._id, admin._id, { name: 'Beans', category: 'Legumes' });
  });

  test('category totals are unchanged by the product-first grouping, and net of the coupon share', async () => {
    await makeOrder(branch, { orderItems: [line(maize), line(beans, { lineTotal: 3000, quantity: 6 })], subtotal: 4000, total: 3900, couponDiscount: 100 });
    await makeOrder(branch, { orderItems: [line(maize, { lineTotal: 1000 })], subtotal: 1000, total: 1000 });
    const r = await reportService.getSalesReport('month', null, null, branch._id);
    const by = Object.fromEntries(r.byCategory.map((c) => [c._id, c]));
    // order 1: coupon 100 shared 1000:3000 -> maize 975, beans 2925; order 2: maize 1000
    assert.equal(Math.round(by.Cereals.revenue), 1975);
    assert.equal(Math.round(by.Legumes.revenue), 2925);
    assert.equal(by.Cereals.unitsSold, 4);
    assert.equal(by.Cereals.orderCount, 2);
  });

  test('the revenue breakdown reconciles: total = goods - discounts + delivery + VAT (F-15)', async () => {
    await makeOrder(branch, { orderItems: [line(maize)], subtotal: 1000, couponDiscount: 100, deliveryFee: 200, vatAmount: 144, total: 1244 });
    await makeOrder(branch, { orderItems: [line(maize)], subtotal: 2000, deliveryFee: 0, vatAmount: 320, total: 2320 });
    const { summary } = await reportService.getSalesReport('month', null, null, branch._id);
    const b = summary.breakdown;
    assert.equal(b.goodsSubtotal, 3000);
    assert.equal(b.couponDiscounts, 100);
    assert.equal(b.netGoods, 2900);
    assert.equal(b.deliveryFees, 200);
    assert.equal(b.vatCollected, 464);
    assert.equal(Math.round((b.netGoods + b.deliveryFees + b.vatCollected) * 100) / 100, summary.totalRevenue);
  });

  test('identical requests within a minute share one result; today is never cached', async () => {
    await makeOrder(branch, { orderItems: [line(maize)] });
    const first = await reportService.getSalesReport('month', null, null, branch._id);
    await makeOrder(branch, { orderItems: [line(maize)] });
    const second = await reportService.getSalesReport('month', null, null, branch._id);
    assert.equal(second.summary.totalOrders, first.summary.totalOrders, 'served from the cache');
    const today1 = await reportService.getSalesReport('today', null, null, branch._id);
    await makeOrder(branch, { orderItems: [line(maize)] });
    const today2 = await reportService.getSalesReport('today', null, null, branch._id);
    assert.equal(today2.summary.totalOrders, today1.summary.totalOrders + 1, 'today is live');
  });
});

describe('ttl cache', () => {
  test('expires, shares an in-flight computation, and is bounded', async () => {
    const cache = createTtlCache({ ttlMs: 30, maxEntries: 3 });
    let computed = 0;
    const slow = () => new Promise((r) => setTimeout(() => { computed += 1; r('v'); }, 15));
    await Promise.all([cache.wrap('k', slow), cache.wrap('k', slow), cache.wrap('k', slow)]);
    assert.equal(computed, 1, 'concurrent callers share one computation');
    await cache.wrap('k', slow);
    assert.equal(computed, 1, 'second call is a hit');
    await new Promise((r) => setTimeout(r, 40));
    await cache.wrap('k', slow);
    assert.equal(computed, 2, 'expired');
    for (let i = 0; i < 10; i++) cache.set(`x${i}`, i);
    assert.ok(cache.size() <= 3);
  });
});

describe('payments carry their branch (F-10)', () => {
  let a; let b;
  beforeEach(async () => {
    await testDb.clearDatabase();
    a = await createBranch({ name: 'A', slug: 'a' });
    b = await createBranch({ name: 'B', slug: 'b', isDefault: false });
  });

  test('saved payments pick up the order\'s branch, and cash-up separates branches without a join', async () => {
    const oa = await makeOrder(a, { paymentMethod: 'mpesa', deliveryMethod: 'pickup' });
    const ob = await makeOrder(b, { paymentMethod: 'mpesa', deliveryMethod: 'pickup', total: 400, subtotal: 400 });
    const pa = await Payment.create({ orderId: oa._id, method: 'mpesa', amount: 1000, status: 'paid', paidAt: new Date() });
    await Payment.create({ orderId: ob._id, method: 'mpesa', amount: 400, status: 'paid', paidAt: new Date() });
    assert.equal(String(pa.branchId), String(a._id));

    const ra = await reportService.getCashUpReport('today', null, null, a._id);
    const rb = await reportService.getCashUpReport('today', null, null, b._id);
    assert.equal(ra.totalIn, 1000);
    assert.equal(rb.totalIn, 400);
    assert.equal((await reportService.getCashUpReport('today', null, null, null)).totalIn, 1400, 'no branch = all');
  });

  test('the migration backfills older payments and is safe to repeat', async () => {
    const o = await makeOrder(a, { paymentMethod: 'mpesa' });
    await Payment.collection.insertOne({ orderId: o._id, method: 'mpesa', amount: 1000, status: 'paid', paidAt: new Date(), createdAt: new Date(), updatedAt: new Date() });
    const orphan = await Payment.collection.insertOne({ orderId: objectId(), method: 'mpesa', amount: 5, status: 'failed', createdAt: new Date(), updatedAt: new Date() });
    const mig = MIGRATIONS.find((m) => m.name === 'payment-branch-id-v1');
    assert.equal(await mig.run(), 2);
    assert.equal(String((await Payment.findOne({ orderId: o._id }).lean()).branchId), String(a._id));
    assert.equal((await Payment.collection.findOne({ _id: orphan.insertedId })).branchId, null);
    assert.equal(await mig.run(), 0 + 1, 'the order-less payment is the only one left to look at');
  });

  test('the index-cleanup migration never throws, even when the indexes are not there', async () => {
    const mig = MIGRATIONS.find((m) => m.name === 'drop-redundant-indexes-v1');
    await mig.run();
    await mig.run();
  });
});

describe('customer report paging (F-10)', () => {
  test('counts cover everyone, the page is bounded, and "all" returns every customer', async () => {
    await testDb.clearDatabase();
    reportService._clearReportCache();
    const branch = await createBranch();
    for (let i = 0; i < 7; i++) {
      const u = await createUser(null, { role: 'customer', branchId: null, name: `Cust ${i}`, phone: `07${60000000 + i}` });
      for (let k = 0; k <= i % 4; k++) await makeOrder(branch, { userId: u._id, total: 100 * (i + 1), subtotal: 100 * (i + 1) });
    }
    const page1 = await reportService.getCustomerReport(branch._id, { page: 1, limit: 3 });
    assert.equal(page1.total, 7);
    assert.equal(page1.customers.length, 3);
    assert.equal(page1.pagination.pages, 3);
    assert.ok(page1.customers[0].totalSpend >= page1.customers[1].totalSpend, 'best spenders first');
    assert.ok(page1.customers.every((c) => c.name && c.phone));
    const page3 = await reportService.getCustomerReport(branch._id, { page: 3, limit: 3 });
    assert.equal(page3.customers.length, 1);
    const all = await reportService.getCustomerReport(branch._id, { all: true });
    assert.equal(all.customers.length, 7);
    assert.equal(all.repeat, page1.repeat, 'segment counts do not depend on the page');
    assert.ok(await User.countDocuments() >= 7);
  });
});

describe('VAT report split and eTIMS dates (F-16)', () => {
  test('taxable vs exempt sales and delivery fees are reported separately', async () => {
    await testDb.clearDatabase();
    reportService._clearReportCache();
    const branch = await createBranch();
    const admin = await createUser(branch._id, { role: 'admin' });
    const p = await createProduct(branch._id, admin._id);
    await makeOrder(branch, {
      vatEnabled: true, vatRate: 16, vatAmount: 80, deliveryFee: 150,
      orderItems: [line(p, { lineTotal: 500, taxable: true }), line(p, { lineTotal: 300, taxable: false })],
      subtotal: 800, total: 1030,
    });
    const r = await reportService.getVatReport('month', null, null, branch._id);
    assert.equal(r.summary.taxableSales, 500);
    assert.equal(r.summary.exemptSales, 300);
    assert.equal(r.summary.deliveryFees, 150);
    assert.equal(r.summary.totalVat, 80);
  });

  test('eTIMS sale date is the Nairobi calendar day, not the UTC one', () => {
    const order = {
      createdAt: new Date('2026-10-18T22:30:00Z'),     // 01:30 on the 19th in Nairobi
      orderItems: [{ productName: 'Maize', quantity: 1, unitPrice: 100, lineTotal: 100, taxable: true, variety: 'Y', packaging: '50kg', productId: objectId() }],
      subtotal: 100, total: 100, vatEnabled: false, paymentMethod: 'pickup', orderRef: 'NAI-2026-0001',
    };
    const payload = buildPayload(order, 'P051234567X', '00');
    assert.equal(payload.salesDt, '20261019');
  });
});

describe('rider report (F-43)', () => {
  test('delivery time runs from dispatch, not from when the order was placed', async () => {
    await testDb.clearDatabase();
    const branch = await createBranch();
    const driver = await createUser(branch._id, { role: 'driver', name: 'Dan' });
    const created = new Date(Date.now() - 4 * 3600 * 1000);
    const dispatched = new Date(Date.now() - 40 * 60 * 1000);
    await makeOrder(branch, {
      driverId: driver._id, deliveryMethod: 'delivery', paymentMethod: 'delivery', createdAt: created, deliveredAt: new Date(),
      statusHistory: [
        { status: 'pending', changedAt: created, changedBy: driver._id },
        { status: 'out_for_delivery', changedAt: dispatched, changedBy: driver._id },
      ],
    });
    const r = await reportService.getRiderReport('week', null, null, branch._id);
    assert.equal(r.riders.length, 1);
    assert.ok(Math.abs(r.riders[0].avgDeliveryMinutes - 40) <= 1, `got ${r.riders[0].avgDeliveryMinutes}`);
  });
});

describe('dashboard low-stock count (F-44)', () => {
  test('is counted in the database: at/below threshold, not quote-only, other branches excluded', async () => {
    await testDb.clearDatabase();
    const a = await createBranch({ name: 'A', slug: 'a' });
    const b = await createBranch({ name: 'B', slug: 'b', isDefault: false });
    const admin = await createUser(a._id, { role: 'admin' });
    await createProduct(a._id, admin._id, { packaging: { stock: 5, lowStockThreshold: 10 } });       // low
    await createProduct(a._id, admin._id, { packaging: { stock: 10, lowStockThreshold: 10 } });      // exactly at threshold: low
    await createProduct(a._id, admin._id, { packaging: { stock: 50, lowStockThreshold: 10 } });      // fine
    await createProduct(a._id, admin._id, { packaging: { stock: 0, lowStockThreshold: 10, quoteOnly: true } });  // quote-only: ignored
    await createProduct(b._id, admin._id, { packaging: { stock: 1, lowStockThreshold: 10 } });       // other branch
    assert.equal((await reportService.getDashboardKPIs(a._id)).lowStockCount, 2);
    assert.equal((await reportService.getDashboardKPIs(b._id)).lowStockCount, 1);
    assert.equal((await reportService.getDashboardKPIs(null)).lowStockCount, 3, 'no branch = all branches');
  });
});

describe('dashboard day-over-day comparison', () => {
  test('counts yesterday up to this time of day, in revenue statuses only, per branch', async () => {
    await testDb.clearDatabase();
    const a = await createBranch({ name: 'A', slug: 'a' });
    const b = await createBranch({ name: 'B', slug: 'b', isDefault: false });
    const DAY = 24 * 3600 * 1000;
    // Pinned to "now - 24h - 1h": always inside yesterday's window whatever time the suite runs.
    const earlierYesterday = new Date(Date.now() - DAY - 3600 * 1000);
    const laterYesterday = new Date(Date.now() - DAY + 3600 * 1000);   // after this time of day: excluded
    await makeOrder(a, { total: 1000, createdAt: earlierYesterday });
    await makeOrder(a, { total: 500, createdAt: earlierYesterday, status: 'pending' });        // counts as an order, not revenue
    await makeOrder(a, { total: 700, createdAt: earlierYesterday, status: 'cancelled' });      // an order, never revenue
    await makeOrder(a, { total: 9999, createdAt: laterYesterday });                           // later than now-24h: excluded
    await makeOrder(b, { total: 4000, createdAt: earlierYesterday });                         // other branch
    const kpis = await reportService.getDashboardKPIs(a._id);
    assert.equal(kpis.comparison.ordersYesterday, 3);
    assert.equal(kpis.comparison.revenueYesterday, 1000);
    assert.equal((await reportService.getDashboardKPIs(null)).comparison.ordersYesterday, 4, 'no branch = all branches');
  });
});
