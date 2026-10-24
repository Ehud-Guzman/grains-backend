// Whole-shilling order totals (F-21) and automatic eTIMS credit notes.
//  - An order's total is rounded UP to a whole shilling at checkout; the difference is stored as roundingAdjustment and
//    appears as its own line on the invoice so everything still adds up.
//  - A credit note for an already-invoiced, then cancelled, order goes to KRA by itself (eTIMS is stubbed here: it is not
//    yet exercised against KRA's sandbox), is retried on failure, claimed so it is never filed twice, and can be sent by hand.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const testDb = require('./helpers/testDb');
const { createBranch, createSettings, createUser, createProduct, cartItemFor } = require('./helpers/fixtures');
const Order = require('../src/models/Order');
const ActivityLog = require('../src/models/ActivityLog');
const orderService = require('../src/services/order.service');
const etimsService = require('../src/services/etims.service');
const globalSettingsService = require('../src/services/globalSettings.service');
const reportService = require('../src/services/report.service');
const { collectRoutes } = require('../src/utils/permissionMatrix');
const app = require('../src/app');

before(async () => { await testDb.connect(); });
after(async () => { await testDb.disconnect(); });

let branch; let admin; let product;
const place = (overrides = {}, quantity = 1) => orderService.createGuestOrder({
  name: 'Jane', phone: '0712000001', orderItems: [cartItemFor(product, { quantity })],
  deliveryMethod: 'pickup', paymentMethod: 'pickup', ...overrides,
}, branch._id);

beforeEach(async () => {
  await testDb.clearDatabase();
  branch = await createBranch({ isDefault: true });
  admin = await createUser(branch._id, { role: 'admin' });
});

describe('order totals are whole shillings', () => {
  test('a total with cents is rounded up, and the difference is kept as its own line', async () => {
    await createSettings(branch._id, { vatEnabled: true, vatRate: 16 });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 500, priceKES: 1234.55 } });
    const { _id: orderId } = await place();
    const o = await Order.findById(orderId).lean();
    assert.equal(o.subtotal, 1234.55);
    assert.equal(o.vatAmount, 197.53);
    assert.equal(o.total, 1433, '1234.55 + 197.53 = 1432.08, rounded up');
    assert.equal(o.roundingAdjustment, 0.92);
    assert.equal(o.subtotal + o.vatAmount + o.roundingAdjustment, o.total, 'the lines add up to the total');
  });

  test('a total that is already whole is left alone', async () => {
    await createSettings(branch._id, {});
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 500, priceKES: 1000 } });
    const { _id: orderId } = await place();
    const o = await Order.findById(orderId).lean();
    assert.equal(o.total, 1000);
    assert.equal(o.roundingAdjustment, 0);
  });

  test('the total the checkout showed (a whole number) is accepted, and a stale price is still refused', async () => {
    await createSettings(branch._id, { vatEnabled: true, vatRate: 16 });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 500, priceKES: 1234.55 } });
    await place({ expectedTotal: 1433 });
    await assert.rejects(place({ phone: '0712000002', expectedTotal: 1200 }), { errorCode: 'PRICE_CHANGED' });
  });

  test('the sales report shows how much rounding added, so revenue still reconciles', async () => {
    await createSettings(branch._id, { vatEnabled: true, vatRate: 16 });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 500, priceKES: 1234.55 } });
    const { _id: orderId } = await place();
    await Order.updateOne({ _id: orderId }, { status: 'approved' });
    const { summary } = await reportService.getSalesReport('today', null, null, branch._id);
    const b = summary.breakdown;
    assert.equal(b.rounding, 0.92);
    assert.equal(Math.round((b.netGoods + b.deliveryFees + b.vatCollected + b.rounding) * 100) / 100, summary.totalRevenue);
  });
});

describe('the eTIMS invoice carries the rounding', () => {
  test('items add up to the total, with rounding as an exempt line', async () => {
    await createSettings(branch._id, { vatEnabled: true, vatRate: 16 });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 500, priceKES: 1234.55 } });
    const { _id: orderId } = await place();
    const order = await Order.findById(orderId).lean();
    const p = etimsService.buildPayload(order, 'P000', '00');
    const rounding = p.itemList.find(i => i.itemCd === 'ROUNDING');
    assert.ok(rounding);
    assert.equal(rounding.totAmt, 0.92);
    assert.equal(rounding.taxTyCd, 'E');
    const sum = p.itemList.reduce((s, i) => s + i.totAmt, 0);
    assert.equal(Math.round(sum * 100) / 100, p.totAmt, 'sum(itemList.totAmt) === totAmt');
    assert.equal(p.totAmt, 1433);
    assert.equal(Math.round((p.totTaxblAmt + p.totTaxAmt) * 100) / 100, p.totAmt);
  });

  test('an order with no rounding has no rounding line', async () => {
    await createSettings(branch._id, {});
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 500, priceKES: 1000 } });
    const { _id: orderId } = await place();
    const p = etimsService.buildPayload(await Order.findById(orderId).lean(), 'P000', '00');
    assert.equal(p.itemList.some(i => i.itemCd === 'ROUNDING'), false);
  });
});

describe('the VAT report says what eTIMS has not been told about', () => {
  test('a delivered, unpaid cash order is counted but flagged as not filed', async () => {
    await createSettings(branch._id, { vatEnabled: true, vatRate: 16 });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 500, priceKES: 1000 } });
    const filed = await place({ phone: '0712000011' });
    const unpaid = await place({ phone: '0712000012' });
    await Order.updateOne({ _id: filed._id }, { status: 'completed', paymentStatus: 'paid', etimsStatus: 'submitted', etimsInvoiceNumber: '1' });
    await Order.updateOne({ _id: unpaid._id }, { status: 'completed', paymentStatus: 'unpaid' });
    const { summary } = await reportService.getVatReport('month', null, null, branch._id);
    assert.equal(summary.totalOrders, 2);
    assert.equal(summary.unfiledOrders, 1);
    assert.equal(summary.unfiledVat, 160);
  });
});

describe('credit notes are filed with KRA automatically', () => {
  const realSettings = globalSettingsService.getSettings;
  const realPost = axios.post;
  let posts;
  let reply;
  const etimsOn = (on = true) => {
    globalSettingsService.getSettings = async () => ({ etims: on ? { enabled: true, baseUrl: 'https://kra.test', tin: 'P000', bhfId: '00', deviceId: 'DEV1' } : { enabled: false } });
  };
  before(() => {
    axios.post = async (url, body) => { posts.push({ url, body }); if (reply instanceof Error) throw reply; return reply; };
  });
  after(() => { globalSettingsService.getSettings = realSettings; axios.post = realPost; });
  beforeEach(() => { posts = []; reply = { data: { resultCd: '000', data: { rcptNo: 'CN-KRA-0001', tradeIvtNo: 555 } } }; etimsOn(true); });

  const invoicedAndDispatched = async () => {
    await createSettings(branch._id, { vatEnabled: true, vatRate: 16 });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 500, priceKES: 1234.55 } });
    const { _id: orderId } = await place();
    await Order.updateOne({ _id: orderId }, { status: 'out_for_delivery', paymentStatus: 'paid', etimsStatus: 'submitted', etimsInvoiceNumber: '1042' });
    return orderId;
  };
  const settle = () => new Promise(r => setTimeout(r, 150)); // the filing is fire-and-forget after the commit

  test('cancelling the order sends a refund-type receipt that points at the original invoice', async () => {
    const id = await invoicedAndDispatched();
    await orderService.updateStatus(id, 'cancelled', admin._id, 'customer refused delivery', branch._id, 'admin');
    await settle();
    assert.equal(posts.length, 1);
    const body = posts[0].body;
    assert.equal(posts[0].url, 'https://kra.test/saveTrnsSaleOsdc');
    assert.equal(body.rcptTyCd, 'R');
    assert.equal(body.orgInvcNo, 1042);
    assert.ok(body.rfdRsnCd);
    assert.equal(body.totAmt, 1433);
    const o = await Order.findById(id).lean();
    assert.equal(o.etimsCreditNoteStatus, 'issued');
    assert.equal(o.etimsCreditNoteRef, '555');
    assert.equal(o.etimsCreditNoteClaimedAt, null);
    assert.equal(await ActivityLog.countDocuments({ action: 'ETIMS_CREDIT_NOTE_ISSUED', 'detail.mode': 'automatic' }), 1);
  });

  test('with eTIMS off nothing is sent and the credit note waits to be filed by hand', async () => {
    etimsOn(false);
    const id = await invoicedAndDispatched();
    await orderService.updateStatus(id, 'cancelled', admin._id, 'refused', branch._id, 'admin');
    await settle();
    assert.equal(posts.length, 0);
    assert.equal((await Order.findById(id).lean()).etimsCreditNoteStatus, 'required');
    await assert.rejects(orderService.submitCreditNoteToKra(id, branch._id), { errorCode: 'ETIMS_DISABLED' });
  });

  test('a rejection by KRA leaves it waiting with the reason, and a retry then files it', async () => {
    const id = await invoicedAndDispatched();
    reply = { data: { resultCd: '901', resultMsg: 'Invalid invoice number' } };
    await orderService.updateStatus(id, 'cancelled', admin._id, 'refused', branch._id, 'admin');
    await settle();
    let o = await Order.findById(id).lean();
    assert.equal(o.etimsCreditNoteStatus, 'required');
    assert.match(o.etimsCreditNoteError, /Invalid invoice number/);
    assert.equal(o.etimsCreditNoteClaimedAt, null, 'the claim is released so it can be retried');

    reply = { data: { resultCd: '000', data: { rcptNo: 'CN-OK' } } };
    const out = await etimsService.submitCreditNote(id);
    assert.equal(out.filed, true);
    o = await Order.findById(id).lean();
    assert.equal(o.etimsCreditNoteStatus, 'issued');
    assert.equal(o.etimsCreditNoteError, null);
  });

  test('a network failure behaves the same way', async () => {
    const id = await invoicedAndDispatched();
    reply = new Error('ECONNRESET');
    await orderService.updateStatus(id, 'cancelled', admin._id, 'refused', branch._id, 'admin');
    await settle();
    const o = await Order.findById(id).lean();
    assert.equal(o.etimsCreditNoteStatus, 'required');
    assert.match(o.etimsCreditNoteError, /ECONNRESET/);
  });

  test('two senders at once file it once; once filed, nothing more is sent', async () => {
    const id = await invoicedAndDispatched();
    etimsOn(false);
    await orderService.updateStatus(id, 'cancelled', admin._id, 'refused', branch._id, 'admin');
    await settle();
    etimsOn(true);
    const results = await Promise.all([etimsService.submitCreditNote(id), etimsService.submitCreditNote(id)]);
    assert.equal(posts.length, 1, 'only one request reached KRA');
    assert.deepEqual(results.map(r => r.filed).sort(), [false, true]);
    assert.equal((await etimsService.submitCreditNote(id)).reason, 'not_required');
    assert.equal(posts.length, 1);
  });

  test('an admin can send it by hand, only for the right branch and only when one is waiting', async () => {
    etimsOn(false);
    const id = await invoicedAndDispatched();
    await orderService.updateStatus(id, 'cancelled', admin._id, 'refused', branch._id, 'admin');
    await settle();
    etimsOn(true);
    const other = await createBranch({ name: 'Other', slug: 'other-cn2', isDefault: false });
    await assert.rejects(orderService.submitCreditNoteToKra(id, other._id), { errorCode: 'ORDER_NOT_FOUND' });
    reply = { data: { resultCd: '500', resultMsg: 'down' } };
    await assert.rejects(orderService.submitCreditNoteToKra(id, branch._id), { errorCode: 'ETIMS_CREDIT_NOTE_FAILED' });
    reply = { data: { resultCd: '000', data: { rcptNo: 'CN-HAND' } } };
    const done = await orderService.submitCreditNoteToKra(id, branch._id);
    assert.equal(done.etimsCreditNoteStatus, 'issued');
    await assert.rejects(orderService.submitCreditNoteToKra(id, branch._id), { errorCode: 'NO_CREDIT_NOTE_REQUIRED' });
  });

  test('the route is still admin-only', () => {
    const route = collectRoutes(app).find(r => r.method === 'POST' && r.path === '/api/admin/orders/:id/etims/credit-note');
    assert.deepEqual(route.roles, ['admin']);
  });
});
