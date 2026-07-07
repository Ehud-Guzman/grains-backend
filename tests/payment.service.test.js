const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const testDb = require('./helpers/testDb');
const { createBranch, createUser, createProduct, objectId } = require('./helpers/fixtures');

const paymentService = require('../src/services/payment.service');
const Order = require('../src/models/Order');
const Payment = require('../src/models/Payment');

before(async () => { await testDb.connect(); });
after(async () => { await testDb.disconnect(); });

// Builds a synthetic Safaricom STK callback body matching the real Daraja shape.
const buildCallback = (checkoutRequestId, { resultCode = 0, amount = 1000, receipt = 'QDK14KSHD7' } = {}) => ({
  Body: {
    stkCallback: {
      CheckoutRequestID: checkoutRequestId,
      ResultCode: resultCode,
      ResultDesc: resultCode === 0 ? 'The service request is processed successfully.' : 'Request cancelled by user',
      ...(resultCode === 0 ? {
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: amount },
            { Name: 'MpesaReceiptNumber', Value: receipt },
            { Name: 'TransactionDate', Value: 20260707103000 },
            { Name: 'PhoneNumber', Value: 254712345678 },
          ],
        },
      } : {}),
    },
  },
});

const makeOrderAndPendingPayment = async (branch, amount = 1000) => {
  const admin = await createUser(branch._id, { role: 'admin' });
  const order = await Order.create({
    orderRef: `ORD-TEST-${Date.now()}`,
    branchId: branch._id,
    orderItems: [{ productId: objectId(), productName: 'x', variety: 'Yellow', packaging: '50kg', quantity: 1, unitPrice: amount, lineTotal: amount }],
    subtotal: amount,
    total: amount,
    deliveryMethod: 'pickup',
    paymentMethod: 'mpesa',
    paymentStatus: 'pending',
    status: 'pending',
    statusHistory: [{ status: 'pending', changedAt: new Date(), changedBy: admin._id }],
  });
  const checkoutRequestId = `ws_CO_${Date.now()}`;
  const payment = await Payment.create({
    orderId: order._id, method: 'mpesa', amount, currency: 'KES',
    status: 'pending', checkoutRequestId,
  });
  await Order.findByIdAndUpdate(order._id, { paymentId: payment._id });
  return { order, payment, checkoutRequestId };
};

describe('payment.service — handleCallback (success)', () => {
  let branch;

  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
  });

  test('flips payment and order to paid on a successful callback', async () => {
    const { order, checkoutRequestId } = await makeOrderAndPendingPayment(branch, 1000);

    const result = await paymentService.handleCallback(buildCallback(checkoutRequestId, { amount: 1000 }));
    assert.equal(result.success, true);
    assert.equal(result.status, 'paid');

    const refreshedOrder = await Order.findById(order._id).lean();
    assert.equal(refreshedOrder.paymentStatus, 'paid');

    const refreshedPayment = await Payment.findOne({ checkoutRequestId }).lean();
    assert.equal(refreshedPayment.status, 'paid');
    assert.equal(refreshedPayment.mpesaTransactionId, 'QDK14KSHD7');
  });

  test('a duplicate callback for an already-paid payment is a no-op (idempotent)', async () => {
    const { checkoutRequestId } = await makeOrderAndPendingPayment(branch, 1000);
    await paymentService.handleCallback(buildCallback(checkoutRequestId, { amount: 1000 }));

    const secondResult = await paymentService.handleCallback(buildCallback(checkoutRequestId, { amount: 1000 }));
    assert.equal(secondResult.success, true);
    assert.equal(secondResult.message, 'Already processed');
  });

  test('rejects an underpayment (amount mismatch) and marks payment failed', async () => {
    const { order, checkoutRequestId } = await makeOrderAndPendingPayment(branch, 1000);

    const result = await paymentService.handleCallback(buildCallback(checkoutRequestId, { amount: 500 }));
    assert.equal(result.success, false);
    assert.equal(result.resultCode, 'AMOUNT_MISMATCH');

    const refreshedPayment = await Payment.findOne({ checkoutRequestId }).lean();
    assert.equal(refreshedPayment.status, 'failed');

    const refreshedOrder = await Order.findById(order._id).lean();
    assert.equal(refreshedOrder.paymentStatus, 'failed');
  });

  test('marks payment refunded (not paid) if the order was cancelled before the callback arrived', async () => {
    const { order, checkoutRequestId } = await makeOrderAndPendingPayment(branch, 1000);
    await Order.findByIdAndUpdate(order._id, { status: 'cancelled' });

    const result = await paymentService.handleCallback(buildCallback(checkoutRequestId, { amount: 1000 }));
    assert.equal(result.success, false);
    assert.equal(result.status, 'order_terminal');

    const refreshedPayment = await Payment.findOne({ checkoutRequestId }).lean();
    assert.equal(refreshedPayment.status, 'refunded');

    const refreshedOrder = await Order.findById(order._id).lean();
    assert.equal(refreshedOrder.paymentStatus, 'pending', 'order paymentStatus must not be flipped to paid once terminal');
  });

  test('unknown CheckoutRequestID is ignored safely', async () => {
    const result = await paymentService.handleCallback(buildCallback('does-not-exist', { amount: 1000 }));
    assert.equal(result.success, false);
    assert.equal(result.message, 'Payment record not found');
  });
});

describe('payment.service — handleCallback (failure result codes)', () => {
  let branch;

  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
  });

  test('a non-zero ResultCode marks payment and order failed', async () => {
    const { order, checkoutRequestId } = await makeOrderAndPendingPayment(branch, 1000);

    const result = await paymentService.handleCallback(buildCallback(checkoutRequestId, { resultCode: 1032 }));
    assert.equal(result.success, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.resultCode, 1032);

    const refreshedOrder = await Order.findById(order._id).lean();
    assert.equal(refreshedOrder.paymentStatus, 'failed');
  });
});
