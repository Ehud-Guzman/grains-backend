// Money-trail audit (2026-10): what a payment actually brought in is recorded; every method is stored on one rounding rule;
// over-payments, short payments and receipts that contradict each other leave a trace and an alert; a refund can be
// recorded as SENT (so "owed" ends); flagged payments can be closed; the cash-up reconciles received vs invoiced and shows
// refunds owed; an already-invoiced order that is cancelled is queued for a KRA credit note.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const testDb = require('./helpers/testDb');
const { createBranch, createUser } = require('./helpers/fixtures');
const Order = require('../src/models/Order');
const Payment = require('../src/models/Payment');
const ActivityLog = require('../src/models/ActivityLog');
require('../src/models/Guest');
const alertService = require('../src/services/alert.service');
const paymentService = require('../src/services/payment.service');
const orderService = require('../src/services/order.service');
const reportService = require('../src/services/report.service');
const integrity = require('../src/services/integrity.service');
const { collectRoutes } = require('../src/utils/permissionMatrix');
const app = require('../src/app');

before(async () => { await testDb.connect(); });
after(async () => { await testDb.disconnect(); });

const alerts = [];
const realSend = alertService.sendAlert;
before(() => { alertService.sendAlert = async (type, data) => { alerts.push({ type, data }); return true; }; });
after(() => { alertService.sendAlert = realSend; });

let seq = 0;
let branch; let admin; let supervisor;
const makeOrder = (overrides = {}) => Order.create({
  orderRef: `NAI-MT-${++seq}`, orderItems: [], subtotal: 1000, total: 1000, deliveryMethod: 'pickup', paymentMethod: 'mpesa',
  branchId: branch._id, status: 'pending', paymentStatus: 'unpaid', ...overrides,
});
// What initiateStkPush leaves behind (an M-Pesa prompt for the next whole shilling), without calling Daraja.
const prompt = async (order, overrides = {}) => {
  const pay = await Payment.create({
    orderId: order._id, branchId: order.branchId, method: 'mpesa', mpesaPhone: '254700000001', status: 'pending',
    amount: Math.ceil(order.total), checkoutRequestId: `ws_CO_${order._id}_${Math.random().toString(36).slice(2, 8)}`, ...overrides,
  });
  await Order.updateOne({ _id: order._id }, { paymentStatus: 'pending', paymentId: pay._id });
  return pay;
};
let receiptSeq = 0;
const receipt = () => `QMT${String(1000000 + receiptSeq++).slice(-7)}`;
const callback = (pay, { amount, code = 0, receipt: rc } = {}) => paymentService.handleCallback({ Body: { stkCallback: {
  MerchantRequestID: 'm', CheckoutRequestID: pay.checkoutRequestId, ResultCode: code, ResultDesc: 'x',
  CallbackMetadata: code === 0 ? { Item: [
    { Name: 'Amount', Value: amount ?? pay.amount }, { Name: 'MpesaReceiptNumber', Value: rc || receipt() },
    { Name: 'TransactionDate', Value: 20261023120000 }, { Name: 'PhoneNumber', Value: 254700000001 }] } : undefined,
} } });
const alertTypes = () => alerts.map(a => a.type);
const logCount = (action, filter = {}) => ActivityLog.countDocuments({ action, ...filter });

beforeEach(async () => {
  await testDb.clearDatabase();
  alerts.length = 0;
  branch = await createBranch();
  admin = await createUser(branch._id, { role: 'admin' });
  supervisor = await createUser(branch._id, { role: 'supervisor' });
});

describe('what a payment actually brought in', () => {
  test('an M-Pesa callback records the amount that arrived, not just the amount asked for', async () => {
    const o = await makeOrder({ total: 1500.4 });
    const pay = await prompt(o);
    assert.equal(pay.amount, 1501, 'the prompt asks for the next whole shilling');
    await callback(pay, { amount: 1501 });
    const p = await Payment.findById(pay._id).lean();
    assert.equal(p.status, 'paid');
    assert.equal(p.receivedAmount, 1501);
  });

  test('an over-payment on the callback is received in full and flagged', async () => {
    const o = await makeOrder({ total: 1000 });
    const pay = await prompt(o);
    await callback(pay, { amount: 1300 });
    assert.equal((await Payment.findById(pay._id).lean()).receivedAmount, 1300);
    assert.ok(await logCount('PAYMENT_OVERPAID') >= 1);
  });

  test('cash confirmed by hand is stored on the same whole-shilling rule as M-Pesa, with what was handed over', async () => {
    const o = await makeOrder({ total: 1541.97, paymentMethod: 'delivery', status: 'completed' });
    await paymentService.manualConfirmPayment(o._id, supervisor._id, null, 'supervisor', branch._id, 1542);
    const p = await Payment.findOne({ orderId: o._id }).lean();
    assert.equal(p.amount, 1542, 'asked for: the total rounded up, as an M-Pesa prompt would');
    assert.equal(p.receivedAmount, 1542);
    assert.equal(p.status, 'paid');
  });

  test('an over-payment at manual confirmation is recorded, logged and alerted (it used to vanish)', async () => {
    const o = await makeOrder({ total: 309.33, paymentMethod: 'pickup' });
    await paymentService.manualConfirmPayment(o._id, supervisor._id, null, 'supervisor', branch._id, 5000);
    const p = await Payment.findOne({ orderId: o._id }).lean();
    assert.equal(p.receivedAmount, 5000);
    assert.equal(p.amount, 310);
    assert.equal(await logCount('PAYMENT_OVERPAID', { 'detail.mode': 'manual' }), 1);
    const sent = alerts.find(a => a.type === 'PAYMENT_OVERPAID_MANUAL');
    assert.ok(sent, 'an alert is raised');
    assert.equal(sent.data.Surplus, 4690);
  });

  test('paying exactly what was asked raises nothing', async () => {
    const o = await makeOrder({ total: 1000, paymentMethod: 'pickup' });
    await paymentService.manualConfirmPayment(o._id, supervisor._id, null, 'supervisor', branch._id, 1000);
    assert.equal(await logCount('PAYMENT_OVERPAID'), 0);
    assert.deepEqual(alertTypes(), []);
  });

  test('an under-payment is still refused', async () => {
    const o = await makeOrder({ total: 1000, paymentMethod: 'pickup' });
    await assert.rejects(paymentService.manualConfirmPayment(o._id, supervisor._id, null, 'supervisor', branch._id, 999), { errorCode: 'CASH_UNDERPAYMENT' });
  });
});

describe('a payment that came in short', () => {
  test('keeps the receipt and the amount, is not credited, and raises an alert', async () => {
    const o = await makeOrder({ total: 2000 });
    const pay = await prompt(o);
    const r = await callback(pay, { amount: 1950, receipt: 'QSHORT0001' });
    assert.equal(r.resultCode, 'AMOUNT_MISMATCH');
    const p = await Payment.findById(pay._id).lean();
    assert.equal(p.status, 'failed');
    assert.equal(p.receivedAmount, 1950);
    assert.equal(p.lateSuccessMeta.mpesaTransactionId, 'QSHORT0001');
    assert.equal(p.lateSuccessMeta.reason, 'short_payment');
    assert.equal(p.lateSuccessMeta.expected, 2000);
    assert.equal((await Order.findById(o._id).lean()).paymentStatus, 'failed', 'the order is not marked paid');
    const alert = alerts.find(a => a.type === 'MPESA_SHORT_PAYMENT');
    assert.ok(alert);
    assert.equal(alert.data['M-Pesa receipt'], 'QSHORT0001');
  });

  test('shows in the cash-up and the integrity scan until someone closes it, in any period', async () => {
    const o = await makeOrder({ total: 2000 });
    const pay = await prompt(o);
    await callback(pay, { amount: 1950 });
    // Look at a window that does not contain "now": an open exception is standing, not a figure for a period.
    const lastYear = await reportService.getCashUpReport(null, '2025-01-01', '2025-01-31', branch._id);
    assert.equal(lastYear.exceptions.lateSuccess.length, 1);
    assert.equal(lastYear.totals.needsAttention, 1);
    const scan = await integrity.runScan();
    assert.equal(scan.checks.find(c => c.id === 'late-mpesa-success').count, 1);

    const closed = await paymentService.resolvePaymentException(pay._id, supervisor._id, 'supervisor', branch._id, 'Customer topped up KES 50 by phone');
    assert.ok(closed.lateSuccessMeta.resolvedAt);
    const after = await reportService.getCashUpReport(null, '2025-01-01', '2025-01-31', branch._id);
    assert.equal(after.exceptions.lateSuccess.length, 0);
    assert.equal((await integrity.runScan()).checks.find(c => c.id === 'late-mpesa-success').count, 0);
    assert.equal(await logCount('PAYMENT_EXCEPTION_RESOLVED'), 1);
  });

  test('closing needs a note, only works on a flagged payment, and only once', async () => {
    const o = await makeOrder({ total: 2000 });
    const pay = await prompt(o);
    await assert.rejects(paymentService.resolvePaymentException(pay._id, supervisor._id, 'supervisor', branch._id, 'ok'), { errorCode: 'RESOLUTION_NOTE_REQUIRED' });
    await assert.rejects(paymentService.resolvePaymentException(pay._id, supervisor._id, 'supervisor', branch._id, 'cleared it'), { errorCode: 'NO_OPEN_EXCEPTION' });
    await callback(pay, { amount: 1000 });
    await paymentService.resolvePaymentException(pay._id, supervisor._id, 'supervisor', branch._id, 'refunded the difference');
    await assert.rejects(paymentService.resolvePaymentException(pay._id, supervisor._id, 'supervisor', branch._id, 'again please'), { errorCode: 'EXCEPTION_ALREADY_RESOLVED' });
  });

  test('another branch cannot close it', async () => {
    const other = await createBranch({ name: 'Other', slug: 'other-mt', isDefault: false });
    const o = await makeOrder({ total: 2000 });
    const pay = await prompt(o);
    await callback(pay, { amount: 1000 });
    await assert.rejects(paymentService.resolvePaymentException(pay._id, supervisor._id, 'supervisor', other._id, 'not mine'), { errorCode: 'PAYMENT_NOT_FOUND' });
  });
});

describe('a typed receipt that Safaricom contradicts', () => {
  test('is flagged once, alerted, and the typed receipt is kept', async () => {
    const o = await makeOrder({ total: 1200 });
    const pay = await prompt(o);
    await paymentService.manualConfirmPayment(o._id, supervisor._id, 'QTYPED0001', 'supervisor', branch._id, 1200);
    const first = await callback(pay, { receipt: 'QREAL00002' });
    assert.equal(first.receiptMismatch, true);
    const p = await Payment.findById(pay._id).lean();
    assert.equal(p.mpesaTransactionId, 'QTYPED0001', 'what is on the order is not overwritten');
    assert.equal(p.receiptMismatch.safaricomReceipt, 'QREAL00002');
    assert.equal(alerts.filter(a => a.type === 'MPESA_RECEIPT_MISMATCH').length, 1);
    await callback(pay, { receipt: 'QREAL00002' });                                  // Safaricom redelivers the callback
    assert.equal(alerts.filter(a => a.type === 'MPESA_RECEIPT_MISMATCH').length, 1, 'only once');
    assert.equal(await logCount('PAYMENT_RECEIPT_MISMATCH'), 1);
    assert.equal((await integrity.runScan()).checks.find(c => c.id === 'receipt-mismatch').count, 1);
    const cash = await reportService.getCashUpReport(null, '2025-01-01', '2025-01-31', branch._id);
    assert.equal(cash.exceptions.receiptMismatch.length, 1);
    await paymentService.resolvePaymentException(pay._id, supervisor._id, 'supervisor', branch._id, 'Typo; the statement shows QREAL00002');
    assert.equal((await integrity.runScan()).checks.find(c => c.id === 'receipt-mismatch').count, 0);
  });

  test('a callback carrying the SAME receipt that was typed raises nothing', async () => {
    const o = await makeOrder({ total: 1200 });
    const pay = await prompt(o);
    await paymentService.manualConfirmPayment(o._id, supervisor._id, 'QSAME00001', 'supervisor', branch._id, 1200);
    const r = await callback(pay, { receipt: 'QSAME00001' });
    assert.equal(r.message, 'Already processed');
    assert.equal(r.receiptMismatch, undefined);
    assert.equal(alerts.filter(a => a.type === 'MPESA_RECEIPT_MISMATCH').length, 0);
  });
});

describe('refunds: owed, then sent', () => {
  // A paid M-Pesa order that is then cancelled: the money is owed back.
  const owedRefund = async (total = 4200) => {
    const o = await makeOrder({ total });
    const pay = await prompt(o);
    await callback(pay, { amount: Math.ceil(total) });
    await orderService.updateStatus(o._id, 'cancelled', admin._id, 'customer changed their mind', branch._id, 'admin');
    return { order: await Order.findById(o._id).lean(), pay: await Payment.findById(pay._id).lean() };
  };

  test('cancelling a paid order leaves a refund OWED, with the amount that was received', async () => {
    const { order, pay } = await owedRefund(4200.5);
    assert.equal(order.paymentStatus, 'refunded');
    assert.equal(pay.status, 'refunded');
    assert.equal(pay.receivedAmount, 4201);
    assert.equal(order.refundSettledAt, null);
    assert.equal(pay.refundSentAt, null);
  });

  test('recording it as sent closes the loop on the payment and the order, and is logged', async () => {
    const { order } = await owedRefund(4200);
    const sent = await paymentService.recordRefundSent(order._id, admin._id, 'admin', branch._id, { method: 'mpesa', reference: 'qrf0000001' });
    assert.equal(sent.refundSentAmount, 4200);
    assert.equal(sent.refundMethod, 'mpesa');
    assert.equal(sent.refundReference, 'QRF0000001', 'receipts are stored upper-case');
    assert.equal(String(sent.refundSentBy), String(admin._id));
    assert.ok((await Order.findById(order._id).lean()).refundSettledAt);
    assert.equal(await logCount('PAYMENT_REFUND_SENT'), 1);
  });

  test('refuses what makes no sense: no refund owed, a bad method, a bad receipt, too much, too little without a reason', async () => {
    const plain = await makeOrder({ total: 500, paymentMethod: 'pickup' });
    await assert.rejects(paymentService.recordRefundSent(plain._id, admin._id, 'admin', branch._id, { method: 'cash' }), { errorCode: 'NO_REFUND_OWED' });

    const { order } = await owedRefund(4200);
    const ask = (body) => paymentService.recordRefundSent(order._id, admin._id, 'admin', branch._id, body);
    await assert.rejects(ask({ method: 'paypal' }), { errorCode: 'INVALID_REFUND_METHOD' });
    await assert.rejects(ask({ method: 'mpesa' }), { errorCode: 'INVALID_TRANSACTION_REF' });
    await assert.rejects(ask({ method: 'mpesa', reference: 'short' }), { errorCode: 'INVALID_TRANSACTION_REF' });
    await assert.rejects(ask({ method: 'cash', amount: 9000 }), { errorCode: 'INVALID_REFUND_AMOUNT' });
    await assert.rejects(ask({ method: 'cash', amount: 0.4 }), { errorCode: 'INVALID_REFUND_AMOUNT' });
    await assert.rejects(ask({ method: 'cash', amount: 4000 }), { errorCode: 'REFUND_NOTE_REQUIRED' });
    assert.equal((await Payment.findOne({ orderId: order._id }).lean()).refundSentAt, null, 'nothing was recorded by the refusals');
  });

  test('a part refund with a reason is accepted; cash needs no receipt; a free-text reference is kept in the note', async () => {
    const { order } = await owedRefund(4200);
    const sent = await paymentService.recordRefundSent(order._id, admin._id, 'admin', branch._id,
      { method: 'cash', amount: 4000, reference: 'slip 77', note: 'KES 200 delivery already driven' });
    assert.equal(sent.refundSentAmount, 4000);
    assert.equal(sent.refundReference, null);
    assert.match(sent.refundNote, /slip 77/);
    assert.match(sent.refundNote, /delivery already driven/);
  });

  test('can be recorded only once, and one M-Pesa receipt cannot settle two refunds', async () => {
    const a = await owedRefund(1000);
    const b = await owedRefund(2000);
    await paymentService.recordRefundSent(a.order._id, admin._id, 'admin', branch._id, { method: 'mpesa', reference: 'QONCE00001' });
    await assert.rejects(paymentService.recordRefundSent(a.order._id, admin._id, 'admin', branch._id, { method: 'cash' }), { errorCode: 'REFUND_ALREADY_SENT' });
    await assert.rejects(paymentService.recordRefundSent(b.order._id, admin._id, 'admin', branch._id, { method: 'mpesa', reference: 'QONCE00001' }), { errorCode: 'DUPLICATE_REFUND_REF' });
    assert.equal((await Payment.findOne({ orderId: b.order._id }).lean()).refundSentAt, null);
  });

  test('two people recording at once: exactly one wins', async () => {
    const { order } = await owedRefund(1500);
    const results = await Promise.allSettled([
      paymentService.recordRefundSent(order._id, admin._id, 'admin', branch._id, { method: 'cash' }),
      paymentService.recordRefundSent(order._id, admin._id, 'admin', branch._id, { method: 'cash' }),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(await logCount('PAYMENT_REFUND_SENT'), 1);
  });

  test('another branch cannot record it', async () => {
    const other = await createBranch({ name: 'Other', slug: 'other-rf', isDefault: false });
    const { order } = await owedRefund(1000);
    await assert.rejects(paymentService.recordRefundSent(order._id, admin._id, 'admin', other._id, { method: 'cash' }), { errorCode: 'ORDER_NOT_FOUND' });
  });

  test('money that arrived for an already-closed order is owed too, and can be sent back', async () => {
    const o = await makeOrder({ total: 800 });
    const pay = await prompt(o);
    await orderService.updateStatus(o._id, 'cancelled', admin._id, 'oops', branch._id, 'admin');
    await callback(pay, { amount: 800 });                                           // the prompt was answered AFTER the cancel
    const p = await Payment.findById(pay._id).lean();
    assert.equal(p.status, 'refunded');
    assert.equal(p.receivedAmount, 800);
    const sent = await paymentService.recordRefundSent(o._id, admin._id, 'admin', branch._id, { method: 'mpesa', reference: 'QLATE00001' });
    assert.equal(sent.refundSentAmount, 800);
  });
});

describe('the cash-up: reconcile, and show what is owed back', () => {
  test('received = invoiced + rounded up + overpaid, and money-in counts what actually arrived', async () => {
    const a = await makeOrder({ total: 1000.4 });                                    // M-Pesa, asked 1001, paid 1001
    await callback(await prompt(a), { amount: 1001 });
    const b = await makeOrder({ total: 2000, paymentMethod: 'pickup' });             // cash, asked 2000, handed 2500
    await paymentService.manualConfirmPayment(b._id, supervisor._id, null, 'supervisor', branch._id, 2500);
    const c = await makeOrder({ total: 300.75, paymentMethod: 'delivery', status: 'completed' });   // cash, asked 301, handed 301
    await paymentService.manualConfirmPayment(c._id, supervisor._id, null, 'supervisor', branch._id, 301);

    const r = await reportService.getCashUpReport('month', null, null, branch._id);
    assert.equal(r.totalIn, 1001 + 2500 + 301, 'money in is what arrived');
    const rec = r.reconciliation;
    assert.equal(rec.payments, 3);
    assert.equal(rec.invoiced, 3301.15);
    assert.equal(rec.roundedUp, 0.85);
    assert.equal(rec.overpaid, 500);
    assert.equal(rec.received, 3802);
    assert.equal(Math.round((rec.invoiced + rec.roundedUp + rec.overpaid) * 100) / 100, rec.received, 'the three parts add up to the whole');
  });

  test('refunds owed is a standing balance (any period, oldest first); refunds sent count in the period they went out', async () => {
    const make = async (total) => {
      const o = await makeOrder({ total });
      await callback(await prompt(o), { amount: total });
      await orderService.updateStatus(o._id, 'cancelled', admin._id, 'cancelled', branch._id, 'admin');
      return o;
    };
    const o1 = await make(1000); const o2 = await make(2500); const o3 = await make(400);
    await Payment.updateOne({ orderId: o1._id }, { refundedAt: new Date(Date.now() - 10 * 86400000) });
    await paymentService.recordRefundSent(o3._id, admin._id, 'admin', branch._id, { method: 'cash' });

    const thisMonth = await reportService.getCashUpReport('today', null, null, branch._id);
    assert.equal(thisMonth.refunds.owed.count, 2);
    assert.equal(thisMonth.refunds.owed.amount, 3500);
    assert.deepEqual(thisMonth.refunds.owed.orders.map(r => r.amount), [1000, 2500], 'the oldest owed first');
    assert.ok(thisMonth.refunds.owed.oldestAt);
    assert.deepEqual(thisMonth.refunds.sent, { count: 1, amount: 400 });
    assert.equal(thisMonth.totals.needsAttention, 2, 'owed refunds need attention');

    const lastYear = await reportService.getCashUpReport(null, '2025-01-01', '2025-01-31', branch._id);
    assert.equal(lastYear.refunds.owed.count, 2, 'still owed, whatever the period');
    assert.deepEqual(lastYear.refunds.sent, { count: 0, amount: 0 });
    assert.equal(o2.paymentMethod, 'mpesa');
  });

  test('refunds are branch-scoped', async () => {
    const other = await createBranch({ name: 'Other', slug: 'other-cu', isDefault: false });
    const o = await makeOrder({ total: 900, branchId: other._id });
    await callback(await prompt(o), { amount: 900 });
    await orderService.updateStatus(o._id, 'cancelled', admin._id, 'x', other._id, 'admin');
    assert.equal((await reportService.getCashUpReport('month', null, null, branch._id)).refunds.owed.count, 0);
    assert.equal((await reportService.getCashUpReport('month', null, null, other._id)).refunds.owed.count, 1);
  });

  test('the integrity scan flags a refund that has been owed for more than three days', async () => {
    const o = await makeOrder({ total: 600 });
    await callback(await prompt(o), { amount: 600 });
    await orderService.updateStatus(o._id, 'cancelled', admin._id, 'x', branch._id, 'admin');
    assert.equal((await integrity.runScan()).checks.find(c => c.id === 'refund-owed-stale').count, 0, 'a fresh one is not stale');
    await Payment.updateOne({ orderId: o._id }, { refundedAt: new Date(Date.now() - 4 * 86400000) });
    assert.equal((await integrity.runScan()).checks.find(c => c.id === 'refund-owed-stale').count, 1);
    await paymentService.recordRefundSent(o._id, admin._id, 'admin', branch._id, { method: 'cash' });
    assert.equal((await integrity.runScan()).checks.find(c => c.id === 'refund-owed-stale').count, 0, 'sending it clears it');
  });
});

describe('an invoiced order that is cancelled needs a KRA credit note', () => {
  const dispatched = (overrides = {}) => makeOrder({ status: 'out_for_delivery', paymentStatus: 'paid', etimsStatus: 'submitted', etimsInvoiceNumber: 'INV-1001', paymentMethod: 'pickup', ...overrides });

  test('cancelling it while out for delivery queues the credit note; rejecting works the same', async () => {
    const o = await dispatched();
    await orderService.updateStatus(o._id, 'cancelled', admin._id, 'customer refused delivery', branch._id, 'admin');
    assert.equal((await Order.findById(o._id).lean()).etimsCreditNoteStatus, 'required');
    assert.equal((await integrity.runScan()).checks.find(c => c.id === 'etims-credit-note-needed').count, 1);

    const pending = await makeOrder({ etimsStatus: 'submitted', etimsInvoiceNumber: 'INV-1002', paymentMethod: 'pickup' });
    await orderService.reject(pending._id, admin._id, 'cannot supply', branch._id, 'admin');
    assert.equal((await Order.findById(pending._id).lean()).etimsCreditNoteStatus, 'required');
  });

  test('an order KRA never saw needs nothing', async () => {
    const o = await makeOrder({ status: 'out_for_delivery', paymentStatus: 'paid', paymentMethod: 'pickup' });
    await orderService.updateStatus(o._id, 'cancelled', admin._id, 'x', branch._id, 'admin');
    assert.equal((await Order.findById(o._id).lean()).etimsCreditNoteStatus, 'not_required');
    const failed = await makeOrder({ etimsStatus: 'failed', paymentMethod: 'pickup' });
    await orderService.reject(failed._id, admin._id, 'out of stock', branch._id, 'admin');
    assert.equal((await Order.findById(failed._id).lean()).etimsCreditNoteStatus, 'not_required');
  });

  test('recording the filed credit note clears it, once, with a reference, in the right branch', async () => {
    const other = await createBranch({ name: 'Other', slug: 'other-cn', isDefault: false });
    const o = await dispatched();
    await orderService.updateStatus(o._id, 'cancelled', admin._id, 'refused', branch._id, 'admin');
    await assert.rejects(orderService.markCreditNoteIssued(o._id, admin._id, 'admin', branch._id, ''), { errorCode: 'CREDIT_NOTE_REF_REQUIRED' });
    await assert.rejects(orderService.markCreditNoteIssued(o._id, admin._id, 'admin', other._id, 'CN-77'), { errorCode: 'ORDER_NOT_FOUND' });
    const done = await orderService.markCreditNoteIssued(o._id, admin._id, 'admin', branch._id, 'cn-2026-0077');
    assert.equal(done.etimsCreditNoteStatus, 'issued');
    assert.equal(done.etimsCreditNoteRef, 'CN-2026-0077');
    assert.ok(done.etimsCreditNoteAt);
    await assert.rejects(orderService.markCreditNoteIssued(o._id, admin._id, 'admin', branch._id, 'CN-2'), { errorCode: 'NO_CREDIT_NOTE_REQUIRED' });
    assert.equal(await logCount('ETIMS_CREDIT_NOTE_ISSUED'), 1);
    assert.equal((await integrity.runScan()).checks.find(c => c.id === 'etims-credit-note-needed').count, 0);
  });

  test('an order with no credit note waiting cannot be marked', async () => {
    const o = await makeOrder({ paymentMethod: 'pickup' });
    await assert.rejects(orderService.markCreditNoteIssued(o._id, admin._id, 'admin', branch._id, 'CN-1'), { errorCode: 'NO_CREDIT_NOTE_REQUIRED' });
  });
});

describe('who may do what (read from the real route guards)', () => {
  const rolesFor = (method, path) => {
    const route = collectRoutes(app).find(r => r.method === method && r.path === path);
    assert.ok(route, `${method} ${path} is mounted`);
    return [...route.roles].sort();
  };

  test('recording a refund sent is admin-only; closing a flagged payment is supervisor and above; credit notes are admin-only', () => {
    assert.deepEqual(rolesFor('POST', '/api/admin/payments/:orderId/refund-sent'), ['admin']);
    assert.deepEqual(rolesFor('POST', '/api/admin/payments/:paymentId/resolve-exception'), ['admin', 'supervisor']);
    assert.deepEqual(rolesFor('POST', '/api/admin/orders/:id/etims/credit-note'), ['admin']);
  });
});
