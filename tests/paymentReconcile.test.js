// M-Pesa resilience: recovering payments whose callback never arrived, Daraja-safe request fields,
// the per-phone prompt cap, and the callback source-IP check.
//
// Nothing here talks to Safaricom: axios is stubbed, and the reconciliation job is driven with an
// injected `query` function.
const { test, describe, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'a'.repeat(64);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'b'.repeat(64);

const testDb = require('./helpers/testDb');
const { createBranch, createSettings, createUser, createProduct, cartItemFor, objectId } = require('./helpers/fixtures');

const orderService = require('../src/services/order.service');
const paymentService = require('../src/services/payment.service');
const { validateSafaricomIP, toAccountReference, STK_TRANSACTION_DESC, describeCallbackSource } = require('../src/utils/mpesaHelpers');
const { resetBranchCodeCache } = require('../src/utils/branchCode');
const Order = require('../src/models/Order');
const Payment = require('../src/models/Payment');
const ActivityLog = require('../src/models/ActivityLog');

const ENV_KEYS = ['MPESA_SHORTCODE', 'MPESA_PASSKEY', 'MPESA_CALLBACK_URL', 'MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_ENV', 'MPESA_CALLBACK_EXTRA_IPS'];
const savedEnv = {};

before(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  await testDb.connect();
});
after(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
  await testDb.disconnect();
});

const configureMpesa = () => {
  process.env.MPESA_SHORTCODE = '174379';
  process.env.MPESA_PASSKEY = 'test-passkey';
  process.env.MPESA_CALLBACK_URL = 'https://example.test/api/payments/mpesa/callback';
  process.env.MPESA_CONSUMER_KEY = 'key';
  process.env.MPESA_CONSUMER_SECRET = 'secret';
  process.env.MPESA_ENV = 'sandbox';
};

// ── pure helpers ───────────────────────────────────────────────────────────────
describe('Daraja request fields', () => {
  test('AccountReference is at most 12 alphanumeric characters, whatever the order reference', () => {
    assert.equal(toAccountReference('NAI-2026-0153'), 'NAI20260153');     // new format (13 chars with hyphens)
    assert.equal(toAccountReference('ORD-2026-0152'), 'ORD20260152');     // legacy format
    for (const ref of ['NAIROBI-2026-0153', 'A-B-C-D-E-F-G-H-I-J-K', 'x'.repeat(40)]) {
      const out = toAccountReference(ref);
      assert.match(out, /^[A-Z0-9]{1,12}$/, `bad AccountReference for ${ref}: ${out}`);
    }
  });

  test('keeps the distinguishing tail (year + sequence) when it has to shorten', () => {
    assert.ok(toAccountReference('NAIROBI-2026-0153').endsWith('20260153'));
  });

  test('never returns an empty reference', () => {
    assert.equal(toAccountReference(''), 'ORDER');
    assert.equal(toAccountReference(null), 'ORDER');
    assert.equal(toAccountReference('---'), 'ORDER');
  });

  test('TransactionDesc fits Daraja\'s 13-character limit', () => {
    assert.ok(STK_TRANSACTION_DESC.length <= 13, STK_TRANSACTION_DESC);
  });
});

describe('callback source-IP allow-list', () => {
  const req = (ip) => ({ ip, headers: {}, socket: {} });
  beforeEach(() => { process.env.MPESA_ENV = 'production'; delete process.env.MPESA_CALLBACK_EXTRA_IPS; });
  afterEach(() => { process.env.MPESA_ENV = savedEnv.MPESA_ENV; if (savedEnv.MPESA_CALLBACK_EXTRA_IPS === undefined) delete process.env.MPESA_CALLBACK_EXTRA_IPS; });

  test('accepts a published Safaricom address, including the IPv4-mapped IPv6 form', () => {
    assert.equal(validateSafaricomIP(req('196.201.214.200')), true);
    assert.equal(validateSafaricomIP(req('::ffff:196.201.214.200')), true);
  });

  test('rejects anything else, and near-miss strings', () => {
    assert.equal(validateSafaricomIP(req('10.0.0.1')), false);
    assert.equal(validateSafaricomIP(req('196.201.214.2001')), false);
    assert.equal(validateSafaricomIP(req('')), false);
  });

  test('extra addresses can be added from the environment without a code change', () => {
    assert.equal(validateSafaricomIP(req('203.0.113.9')), false);
    process.env.MPESA_CALLBACK_EXTRA_IPS = '203.0.113.9, 198.51.100.7';
    assert.equal(validateSafaricomIP(req('203.0.113.9')), true);
    assert.equal(validateSafaricomIP(req('198.51.100.7')), true);
    assert.equal(validateSafaricomIP(req('203.0.113.10')), false);
  });

  test('is not enforced outside production', () => {
    process.env.MPESA_ENV = 'sandbox';
    assert.equal(validateSafaricomIP(req('10.0.0.1')), true);
  });

  test('the rejection diagnostics show what the server saw', () => {
    const info = describeCallbackSource({
      ip: '10.1.2.3', headers: { 'x-forwarded-for': '196.201.214.200, 10.1.2.3' },
      socket: { remoteAddress: '10.9.9.9' }, app: { get: () => 1 },
    });
    assert.equal(info['Resolved IP (req.ip)'], '10.1.2.3');
    assert.equal(info['X-Forwarded-For'], '196.201.214.200, 10.1.2.3');
    assert.equal(info['Socket address'], '10.9.9.9');
    assert.equal(info['Trusted proxy hops'], '1');
  });
});

// ── Daraja status query ────────────────────────────────────────────────────────
describe('queryStkStatus', () => {
  beforeEach(() => {
    configureMpesa();
    mock.method(axios, 'get', async () => ({ data: { access_token: 'test-token' } })); // OAuth
  });
  afterEach(() => mock.restoreAll());

  const answer = (data) => mock.method(axios, 'post', async () => ({ data }));

  test('a successful result is "paid"', async () => {
    answer({ ResponseCode: '0', CheckoutRequestID: 'ws_1', ResultCode: '0', ResultDesc: 'The service request is processed successfully.' });
    assert.deepEqual(await paymentService.queryStkStatus('ws_1'), { state: 'paid', resultCode: 0, resultDesc: 'The service request is processed successfully.' });
  });

  test('a non-zero result (cancelled, timed out, wrong PIN, ...) is "failed"', async () => {
    answer({ ResponseCode: '0', CheckoutRequestID: 'ws_1', ResultCode: '1032', ResultDesc: 'Request cancelled by user' });
    const result = await paymentService.queryStkStatus('ws_1');
    assert.equal(result.state, 'failed');
    assert.equal(result.resultCode, 1032);
  });

  test('"still being processed" is not an outcome', async () => {
    mock.method(axios, 'post', async () => {
      throw Object.assign(new Error('Request failed with status code 500'), {
        response: { data: { errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' } },
      });
    });
    assert.deepEqual(await paymentService.queryStkStatus('ws_1'), { state: 'processing' });
  });

  test('an empty ResultCode is "unknown" - it must never be read as 0 / paid', async () => {
    for (const blank of ['', '   ', null, undefined]) {
      answer({ ResponseCode: '0', CheckoutRequestID: 'ws_1', ResultCode: blank });
      assert.equal((await paymentService.queryStkStatus('ws_1')).state, 'unknown', `ResultCode ${JSON.stringify(blank)}`);
      mock.restoreAll();
      mock.method(axios, 'get', async () => ({ data: { access_token: 'test-token' } }));
    }
  });

  test('a non-numeric ResultCode, a refused request, or an answer about another request is "unknown"', async () => {
    for (const body of [
      { ResponseCode: '0', CheckoutRequestID: 'ws_1', ResultCode: 'abc' },
      { ResponseCode: '1', CheckoutRequestID: 'ws_1', ResultCode: '0' },
      { ResponseCode: '0', CheckoutRequestID: 'ws_OTHER', ResultCode: '0' },
      {},
    ]) {
      mock.restoreAll();
      mock.method(axios, 'get', async () => ({ data: { access_token: 'test-token' } }));
      answer(body);
      assert.equal((await paymentService.queryStkStatus('ws_1')).state, 'unknown', JSON.stringify(body));
    }
  });

  test('network and auth failures throw, so the payment is simply tried again next run', async () => {
    mock.method(axios, 'post', async () => { throw new Error('socket hang up'); });
    await assert.rejects(paymentService.queryStkStatus('ws_1'), /STK query failed/);
  });

  test('sends the CheckoutRequestID to the query endpoint with a signed password', async () => {
    const post = answer({ ResponseCode: '0', CheckoutRequestID: 'ws_1', ResultCode: '0' });
    await paymentService.queryStkStatus('ws_1');
    const [url, payload, options] = post.mock.calls[0].arguments;
    assert.match(url, /\/mpesa\/stkpushquery\/v1\/query$/);
    assert.equal(payload.CheckoutRequestID, 'ws_1');
    assert.equal(payload.BusinessShortCode, '174379');
    assert.match(payload.Timestamp, /^\d{14}$/);
    assert.ok(payload.Password);
    assert.equal(options.headers.Authorization, 'Bearer test-token');
  });
});

// ── reconciliation ─────────────────────────────────────────────────────────────
describe('reconcilePendingPayments', () => {
  let branch, admin, counter = 0;

  beforeEach(async () => {
    await testDb.clearDatabase();
    resetBranchCodeCache();
    configureMpesa();
    branch = await createBranch();
    admin = await createUser(branch._id, { role: 'admin' });
  });

  // An unpaid M-Pesa order with a pending payment whose prompt was sent `ageMinutes` ago.
  const pendingPayment = async ({ ageMinutes = 10, status = 'pending', amount = 1000, orderStatus = 'pending', method = 'mpesa', withCheckoutId = true } = {}) => {
    counter += 1;
    const order = await Order.create({
      orderRef: `TST-2026-${String(counter).padStart(4, '0')}`, branchId: branch._id,
      orderItems: [{ productId: objectId(), productName: 'x', variety: 'Yellow', packaging: '50kg', quantity: 1, unitPrice: amount, lineTotal: amount }],
      subtotal: amount, total: amount, deliveryMethod: 'pickup', paymentMethod: 'mpesa',
      paymentStatus: 'pending', status: orderStatus,
      statusHistory: [{ status: orderStatus, changedAt: new Date(), changedBy: admin._id }],
    });
    const payment = await Payment.create({
      orderId: order._id, method, amount, status,
      ...(withCheckoutId && { checkoutRequestId: `ws_CO_${counter}_${Date.now()}` }),
    });
    await Payment.collection.updateOne({ _id: payment._id }, { $set: { createdAt: new Date(Date.now() - ageMinutes * 60 * 1000) } });
    await Order.updateOne({ _id: order._id }, { paymentId: payment._id });
    return { order, payment: await Payment.findById(payment._id).lean() };
  };

  const stub = (outcomes) => {
    const asked = [];
    const fn = async (checkoutRequestId) => {
      asked.push(checkoutRequestId);
      const outcome = outcomes[checkoutRequestId] ?? outcomes.default;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    };
    fn.asked = asked;
    return fn;
  };

  test('a payment Safaricom confirmed is marked paid together with its order, without a receipt', async () => {
    const { order, payment } = await pendingPayment();
    const query = stub({ default: { state: 'paid', resultCode: 0 } });

    const summary = await paymentService.reconcilePendingPayments({ query });

    assert.deepEqual(summary, { checked: 1, recovered: 1, failed: 0, stillProcessing: 0, errors: 0 });
    const paid = await Payment.findById(payment._id).lean();
    assert.equal(paid.status, 'paid');
    assert.equal(paid.reconciledViaQuery, true);
    assert.ok(paid.reconciledAt);
    assert.equal(paid.mpesaTransactionId, null, 'the query returns no receipt - none is invented');
    assert.equal((await Order.findById(order._id).lean()).paymentStatus, 'paid');

    const trail = await ActivityLog.find({ action: 'PAYMENT_RECONCILED' }).lean();
    assert.equal(trail.length, 1);
    assert.equal(trail[0].detail.orderRef, order.orderRef);
  });

  test('a payment Safaricom says failed is failed on both the payment and the order', async () => {
    const { order, payment } = await pendingPayment();
    const query = stub({ default: { state: 'failed', resultCode: 1032, resultDesc: 'Request cancelled by user' } });

    const summary = await paymentService.reconcilePendingPayments({ query });

    assert.equal(summary.failed, 1);
    assert.equal(summary.recovered, 0);
    const failed = await Payment.findById(payment._id).lean();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.reconciledViaQuery, false);
    assert.equal((await Order.findById(order._id).lean()).paymentStatus, 'failed');
  });

  test('a prompt that is still processing, or an unclear answer, changes nothing', async () => {
    const processing = await pendingPayment();
    const unclear = await pendingPayment();
    const query = stub({
      [processing.payment.checkoutRequestId]: { state: 'processing' },
      [unclear.payment.checkoutRequestId]: { state: 'unknown' },
    });

    const summary = await paymentService.reconcilePendingPayments({ query });

    assert.equal(summary.stillProcessing, 2);
    for (const { payment, order } of [processing, unclear]) {
      assert.equal((await Payment.findById(payment._id).lean()).status, 'pending');
      assert.equal((await Order.findById(order._id).lean()).paymentStatus, 'pending');
    }
  });

  test('only asks about payments old enough for the callback to have had its chance, and not ancient ones', async () => {
    const young = await pendingPayment({ ageMinutes: 1 });
    const ready = await pendingPayment({ ageMinutes: 5 });
    const ancient = await pendingPayment({ ageMinutes: 60 * 7 });
    const query = stub({ default: { state: 'processing' } });

    await paymentService.reconcilePendingPayments({ query });

    assert.deepEqual(query.asked, [ready.payment.checkoutRequestId]);
    assert.ok(!query.asked.includes(young.payment.checkoutRequestId));
    assert.ok(!query.asked.includes(ancient.payment.checkoutRequestId));
  });

  test('ignores payments that are not pending M-Pesa prompts with a CheckoutRequestID', async () => {
    await pendingPayment({ status: 'paid' });
    await pendingPayment({ status: 'failed' });
    await pendingPayment({ method: 'pickup' });
    await pendingPayment({ withCheckoutId: false });
    const query = stub({ default: { state: 'paid', resultCode: 0 } });

    const summary = await paymentService.reconcilePendingPayments({ query });

    assert.equal(summary.checked, 0);
    assert.deepEqual(query.asked, []);
  });

  test('one failing lookup does not stop the rest of the batch', async () => {
    const broken = await pendingPayment({ ageMinutes: 20 });
    const fine = await pendingPayment({ ageMinutes: 10 });
    const query = stub({
      [broken.payment.checkoutRequestId]: new Error('Daraja timeout'),
      [fine.payment.checkoutRequestId]: { state: 'paid', resultCode: 0 },
    });

    const summary = await paymentService.reconcilePendingPayments({ query });

    assert.equal(summary.errors, 1);
    assert.equal(summary.recovered, 1);
    assert.equal((await Payment.findById(broken.payment._id).lean()).status, 'pending', 'left for the next run');
    assert.equal((await Payment.findById(fine.payment._id).lean()).status, 'paid');
  });

  test('money that arrived for an order cancelled in the meantime is recorded as owed back, not as a paid order', async () => {
    const { order, payment } = await pendingPayment({ orderStatus: 'cancelled' });
    const query = stub({ default: { state: 'paid', resultCode: 0 } });

    const summary = await paymentService.reconcilePendingPayments({ query });

    assert.equal(summary.recovered, 1);
    assert.equal((await Payment.findById(payment._id).lean()).status, 'refunded');
    assert.equal((await Order.findById(order._id).lean()).paymentStatus, 'refunded');
  });

  test('a real callback that wins the race is not double-applied or flagged as recovered', async () => {
    const { payment } = await pendingPayment();
    const query = async (checkoutRequestId) => {
      // The callback lands while the status query is in flight.
      await paymentService.handleCallback({
        Body: { stkCallback: {
          CheckoutRequestID: checkoutRequestId, ResultCode: 0, ResultDesc: 'ok',
          CallbackMetadata: { Item: [{ Name: 'Amount', Value: 1000 }, { Name: 'MpesaReceiptNumber', Value: 'REAL123' }] },
        } },
      });
      return { state: 'paid', resultCode: 0 };
    };

    const summary = await paymentService.reconcilePendingPayments({ query });

    assert.equal(summary.recovered, 0);
    const paid = await Payment.findById(payment._id).lean();
    assert.equal(paid.status, 'paid');
    assert.equal(paid.mpesaTransactionId, 'REAL123');
    assert.equal(paid.reconciledViaQuery, false);
  });

  test('a late callback fills in the missing receipt but changes nothing else', async () => {
    const { payment } = await pendingPayment();
    await paymentService.reconcilePendingPayments({ query: stub({ default: { state: 'paid', resultCode: 0 } }) });

    const lateCallback = (receipt) => ({
      Body: { stkCallback: {
        CheckoutRequestID: payment.checkoutRequestId, ResultCode: 0, ResultDesc: 'ok',
        CallbackMetadata: { Item: [{ Name: 'Amount', Value: 1000 }, { Name: 'MpesaReceiptNumber', Value: receipt }, { Name: 'TransactionDate', Value: 20261017103000 }] },
      } },
    });

    const result = await paymentService.handleCallback(lateCallback('QJH7LATE01'));
    assert.equal(result.success, true);
    const filled = await Payment.findById(payment._id).lean();
    assert.equal(filled.status, 'paid');
    assert.equal(filled.mpesaTransactionId, 'QJH7LATE01');
    assert.ok(filled.safaricomTimestamp);

    // A replayed or different callback can never overwrite it.
    await paymentService.handleCallback(lateCallback('SOMETHING-ELSE'));
    assert.equal((await Payment.findById(payment._id).lean()).mpesaTransactionId, 'QJH7LATE01');
  });

  test('running twice does not double-apply anything', async () => {
    const { payment } = await pendingPayment();
    const query = stub({ default: { state: 'paid', resultCode: 0 } });
    await paymentService.reconcilePendingPayments({ query });
    const second = await paymentService.reconcilePendingPayments({ query });
    assert.equal(second.checked, 0, 'a paid payment is no longer pending');
    assert.equal(await ActivityLog.countDocuments({ action: 'PAYMENT_RECONCILED', targetId: payment._id }), 1);
  });
});

// ── initiating a prompt ────────────────────────────────────────────────────────
describe('initiateStkPush', () => {
  let branch, product;

  beforeEach(async () => {
    await testDb.clearDatabase();
    resetBranchCodeCache();
    configureMpesa();
    mock.method(axios, 'get', async () => ({ data: { access_token: 'test-token' } }));
    branch = await createBranch({ slug: 'nairobi-branch', name: 'Nairobi' });
    await createSettings(branch._id);
    const admin = await createUser(branch._id, { role: 'admin' });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 200 } });
  });
  afterEach(() => mock.restoreAll());

  const placeOrder = (phone = '0712345678') => orderService.createGuestOrder({
    name: 'Jane', phone,
    orderItems: [cartItemFor(product, { quantity: 1 + Math.floor(Math.random() * 40) })],
    deliveryMethod: 'pickup', paymentMethod: 'mpesa',
  }, branch._id);

  test('sends Daraja fields within its length limits', async () => {
    const post = mock.method(axios, 'post', async () => ({ data: { ResponseCode: '0', CheckoutRequestID: 'ws_CO_1', MerchantRequestID: 'm1' } }));
    const order = await placeOrder();

    await paymentService.initiateStkPush(order._id, '0712345678');

    const payload = post.mock.calls[0].arguments[1];
    assert.equal(payload.AccountReference, toAccountReference(order.orderRef));
    assert.match(payload.AccountReference, /^[A-Z0-9]{1,12}$/);
    assert.ok(payload.TransactionDesc.length <= 13);
    assert.equal(payload.PartyA, '254712345678');
  });

  const seedPrompts = async (phone, count, ageMinutes = 1) => {
    const other = await placeOrder('0799000111');
    for (let i = 0; i < count; i++) {
      const p = await Payment.create({ orderId: other._id, method: 'mpesa', amount: 100, status: 'failed', mpesaPhone: phone });
      await Payment.collection.updateOne({ _id: p._id }, { $set: { createdAt: new Date(Date.now() - ageMinutes * 60 * 1000) } });
    }
  };

  test('refuses to keep prompting one phone number, and leaves the order untouched', async () => {
    const post = mock.method(axios, 'post', async () => ({ data: { ResponseCode: '0', CheckoutRequestID: 'ws_CO_2' } }));
    await seedPrompts('254712345678', 5);
    const order = await placeOrder();

    await assert.rejects(
      paymentService.initiateStkPush(order._id, '0712345678'),
      (err) => err.statusCode === 429 && err.errorCode === 'TOO_MANY_PROMPTS'
    );

    assert.equal(post.mock.callCount(), 0, 'no prompt may be sent');
    const fresh = await Order.findById(order._id).lean();
    assert.equal(fresh.paymentStatus, 'unpaid');
    assert.equal(fresh.paymentId, null);
  });

  test('a normal number of retries is fine', async () => {
    mock.method(axios, 'post', async () => ({ data: { ResponseCode: '0', CheckoutRequestID: 'ws_CO_3' } }));
    await seedPrompts('254712345678', 4);
    const order = await placeOrder();
    const result = await paymentService.initiateStkPush(order._id, '0712345678');
    assert.equal(result.checkoutRequestId, 'ws_CO_3');
  });

  test('prompts older than the window do not count, and other numbers are unaffected', async () => {
    mock.method(axios, 'post', async () => ({ data: { ResponseCode: '0', CheckoutRequestID: 'ws_CO_4' } }));
    await seedPrompts('254712345678', 8, 30);   // old
    await seedPrompts('254722000000', 8, 1);    // someone else's phone
    const order = await placeOrder();
    const result = await paymentService.initiateStkPush(order._id, '0712345678');
    assert.equal(result.checkoutRequestId, 'ws_CO_4');
  });

  test('a phone number that cannot be formatted is a 400, not a crash', async () => {
    const order = await placeOrder();
    await assert.rejects(
      paymentService.initiateStkPush(order._id, '12'),
      (err) => err.statusCode === 400 && err.errorCode === 'INVALID_PHONE'
    );
    await assert.rejects(
      paymentService.initiateStkPush(order._id, ['0712345678']),
      (err) => err.statusCode === 400
    );
    assert.equal((await Order.findById(order._id).lean()).paymentStatus, 'unpaid');
  });
});

// ── the callback route end to end ──────────────────────────────────────────────
describe('POST /api/payments/mpesa/callback source check', () => {
  let server, base, order, payment;

  before(async () => {
    const app = require('../src/app');
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  beforeEach(async () => {
    await testDb.clearDatabase();
    resetBranchCodeCache();
    configureMpesa();
    const branch = await createBranch();
    const admin = await createUser(branch._id, { role: 'admin' });
    order = await Order.create({
      orderRef: 'CB-2026-0001', branchId: branch._id,
      orderItems: [{ productId: objectId(), productName: 'x', variety: 'Yellow', packaging: '50kg', quantity: 1, unitPrice: 500, lineTotal: 500 }],
      subtotal: 500, total: 500, deliveryMethod: 'pickup', paymentMethod: 'mpesa', paymentStatus: 'pending', status: 'pending',
      statusHistory: [{ status: 'pending', changedAt: new Date(), changedBy: admin._id }],
    });
    payment = await Payment.create({ orderId: order._id, method: 'mpesa', amount: 500, status: 'pending', checkoutRequestId: 'ws_CO_route_1' });
    await Order.updateOne({ _id: order._id }, { paymentId: payment._id });
  });

  const sendCallback = async (headers = {}) => {
    const res = await fetch(`${base}/api/payments/mpesa/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ Body: { stkCallback: {
        CheckoutRequestID: 'ws_CO_route_1', ResultCode: 0, ResultDesc: 'ok',
        CallbackMetadata: { Item: [{ Name: 'Amount', Value: 500 }, { Name: 'MpesaReceiptNumber', Value: 'ROUTE0001' }] },
      } } }),
    });
    return res.status;
  };

  test('production: a callback from Safaricom\'s address (as the proxy reports it) is processed', async () => {
    process.env.MPESA_ENV = 'production';
    // The test connects directly, so it plays the part of Render's load balancer by adding the client address.
    assert.equal(await sendCallback({ 'X-Forwarded-For': '196.201.214.200' }), 200);
    assert.equal((await Payment.findById(payment._id).lean()).status, 'paid');
  });

  test('production: a callback from anywhere else is answered 200 but ignored', async () => {
    process.env.MPESA_ENV = 'production';
    assert.equal(await sendCallback({ 'X-Forwarded-For': '203.0.113.50' }), 200);
    assert.equal((await Payment.findById(payment._id).lean()).status, 'pending');
    assert.equal((await Order.findById(order._id).lean()).paymentStatus, 'pending');
  });

  test('production: a client cannot smuggle an allowed address in front of its real one', async () => {
    process.env.MPESA_ENV = 'production';
    // Real client 203.0.113.50 prepends a forged Safaricom address; the proxy appends the real one.
    assert.equal(await sendCallback({ 'X-Forwarded-For': '196.201.214.200, 203.0.113.50' }), 200);
    assert.equal((await Payment.findById(payment._id).lean()).status, 'pending');
  });

  test('production: an address added via MPESA_CALLBACK_EXTRA_IPS is accepted', async () => {
    process.env.MPESA_ENV = 'production';
    process.env.MPESA_CALLBACK_EXTRA_IPS = '203.0.113.50';
    assert.equal(await sendCallback({ 'X-Forwarded-For': '203.0.113.50' }), 200);
    assert.equal((await Payment.findById(payment._id).lean()).status, 'paid');
  });
});
