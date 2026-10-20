// 2026-10 audit F-04: an M-Pesa callback that lands while the order is being cancelled/rejected must never
// leave a closed order marked paid. Run the two against each other many times with random timing and assert
// the final state is always consistent, whichever one wins.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const testDb = require('./helpers/testDb');
const { createBranch, createSettings, createUser, createProduct, cartItemFor } = require('./helpers/fixtures');

const orderService = require('../src/services/order.service');
const paymentService = require('../src/services/payment.service');
const Order = require('../src/models/Order');
const Payment = require('../src/models/Payment');

before(async () => { await testDb.connect(); });
after(async () => { await testDb.disconnect(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;

const callbackFor = (checkoutRequestId, amount) => ({
  Body: {
    stkCallback: {
      CheckoutRequestID: checkoutRequestId,
      ResultCode: 0,
      ResultDesc: 'ok',
      CallbackMetadata: {
        Item: [
          { Name: 'Amount', Value: amount },
          { Name: 'MpesaReceiptNumber', Value: `RCP${String(++seq).padStart(7, '0')}X` },
          { Name: 'TransactionDate', Value: 20261018120000 },
          { Name: 'PhoneNumber', Value: 254712345678 },
        ],
      },
    },
  },
});

describe('M-Pesa callback vs cancel/reject', () => {
  let branch; let admin; let product;
  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
    await createSettings(branch._id);
    admin = await createUser(branch._id, { role: 'admin' });
    product = await createProduct(branch._id, admin._id);
  });

  const pendingMpesaOrder = async () => {
    const order = await orderService.createGuestOrder({
      name: 'Jane', phone: `07${10000000 + (++seq)}`,
      orderItems: [cartItemFor(product, { quantity: 1 })],
      deliveryMethod: 'pickup', paymentMethod: 'mpesa',
    }, branch._id);
    const checkoutRequestId = `ws_CO_${Date.now()}_${++seq}`;
    const payment = await Payment.create({ orderId: order._id, method: 'mpesa', amount: order.total, status: 'pending', checkoutRequestId });
    await Order.findByIdAndUpdate(order._id, { paymentMethod: 'mpesa', paymentStatus: 'pending', paymentId: payment._id });
    return { order, payment, checkoutRequestId };
  };

  test('order already rejected when the callback arrives: payment recorded as refunded', async () => {
    const { order, payment, checkoutRequestId } = await pendingMpesaOrder();
    await orderService.reject(order._id, admin._id, 'Out of stock', branch._id);
    const result = await paymentService.handleCallback(callbackFor(checkoutRequestId, order.total));
    assert.equal(result.status, 'order_terminal');
    const [o, p] = await Promise.all([Order.findById(order._id).lean(), Payment.findById(payment._id).lean()]);
    assert.equal(o.paymentStatus, 'refunded');
    assert.equal(p.status, 'refunded');
  });

  test('callback first, then reject: the refund flag is raised by the reject', async () => {
    const { order, payment, checkoutRequestId } = await pendingMpesaOrder();
    await paymentService.handleCallback(callbackFor(checkoutRequestId, order.total));
    await orderService.reject(order._id, admin._id, 'Changed our mind', branch._id);
    const [o, p] = await Promise.all([Order.findById(order._id).lean(), Payment.findById(payment._id).lean()]);
    assert.equal(o.status, 'rejected');
    assert.equal(o.paymentStatus, 'refunded');
    assert.equal(p.status, 'refunded');
  });

  test('30 randomised interleavings: a closed order is never left paid', async () => {
    const bad = [];
    for (let i = 0; i < 30; i++) {
      const { order, payment, checkoutRequestId } = await pendingMpesaOrder();
      const a = (async () => { await sleep(Math.random() * 12); return paymentService.handleCallback(callbackFor(checkoutRequestId, order.total)); })();
      const b = (async () => { await sleep(Math.random() * 12); return orderService.reject(order._id, admin._id, 'race', branch._id); })();
      await Promise.all([a, b]);
      const [o, p] = await Promise.all([Order.findById(order._id).lean(), Payment.findById(payment._id).lean()]);
      const consistent = o.status === 'rejected' && o.paymentStatus === 'refunded' && p.status === 'refunded';
      if (!consistent) bad.push({ i, order: [o.status, o.paymentStatus], payment: p.status });
    }
    assert.deepEqual(bad, [], `inconsistent final states: ${JSON.stringify(bad)}`);
  });
});
