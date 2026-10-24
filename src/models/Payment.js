const mongoose = require('mongoose');
const { PAYMENT_METHODS, PAYMENT_STATUSES } = require('../utils/constants');

const paymentSchema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  // Denormalised from the order so payment reports can filter by branch without joining every payment to its
  // order (2026-10 audit, F-10). Filled automatically on save (see the hook below) and backfilled for older
  // payments by utils/migrations.js.
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  method: { type: String, enum: Object.values(PAYMENT_METHODS), required: true },
  mpesaTransactionId: { type: String, default: null },
  mpesaPhone: { type: String, default: null },
  checkoutRequestId: { type: String, default: null }, // for idempotency checks
  amount: { type: Number, required: true },
  currency: { type: String, default: 'KES' },
  status: { type: String, enum: Object.values(PAYMENT_STATUSES), default: PAYMENT_STATUSES.PENDING },
  paidAt: { type: Date, default: null },
  safaricomTimestamp: { type: Date, default: null },
  refundedAt: { type: Date, default: null },
  refundReason: { type: String, default: null },
  confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Set when a success callback arrives for a payment already marked FAILED
  // (e.g. Safaricom's callback for the original STK push landing after the
  // 90s stale-retry window in initiateStkPush already failed it and let the
  // customer retry). The money was received but this record's own status/amount
  // fields are deliberately left untouched — a second payment attempt may
  // already be in flight — so this is purely a reconciliation trail for an
  // admin, not a live payment state.
  lateSuccessMeta: { type: mongoose.Schema.Types.Mixed, default: null },
  // Set when the payment was confirmed by asking Daraja (STK Query) because Safaricom's callback
  // never arrived. Such a payment has no receipt number (the query does not return one) unless
  // the late callback eventually turns up and fills it in; otherwise match it on the M-Pesa statement.
  reconciledViaQuery: { type: Boolean, default: false },
  reconciledAt: { type: Date, default: null },

  // ── Money actually received ──────────────────────────────────────────────────────────────────────────────────────
  // `amount` is what was ASKED for (the order total rounded up to a whole shilling: the same rule for M-Pesa, cash and
  // pickup). `receivedAmount` is what actually arrived: Safaricom's Amount on a callback, or the figure staff typed when
  // confirming by hand. They differ by an over-payment. Reports add up `receivedAmount` (falling back to `amount` for
  // payments recorded before this field existed), so "money in" is money in, not money asked for.
  receivedAmount: { type: Number, default: null },

  // ── Refund payout (2026-10 money-trail audit) ──────────────────────────────────────────────────────────────────
  // `status: refunded` + `refundedAt` mean a refund is OWED (money was taken, then the order closed). They never said
  // whether it had been sent. These record the other half: how much went back, how, with what reference, who sent it.
  refundSentAt: { type: Date, default: null },
  refundSentAmount: { type: Number, default: null },
  refundMethod: { type: String, enum: ['mpesa', 'cash', 'bank', 'other', null], default: null },
  refundReference: { type: String, default: null },   // the M-Pesa reversal/transfer receipt (unique when present)
  refundSentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  refundNote: { type: String, default: null },

  // A success callback whose receipt number differs from the one a person typed in when confirming by hand. Never
  // overwrites anything: it is a flag for someone to compare the two against the M-Pesa statement.
  receiptMismatch: { type: mongoose.Schema.Types.Mixed, default: null }
}, {
  timestamps: true
});

// Indexes
paymentSchema.index({ orderId: 1 });
// partialFilterExpression (not sparse) because MongoDB's sparse still indexes
// explicit null values — partial filter skips them cleanly.
paymentSchema.index({ checkoutRequestId: 1 },   { unique: true, partialFilterExpression: { checkoutRequestId:   { $type: 'string' } } });
paymentSchema.index({ mpesaTransactionId: 1 },  { unique: true, partialFilterExpression: { mpesaTransactionId:  { $type: 'string' } } });
paymentSchema.index({ status: 1, createdAt: -1 }); // date-ranged payment reports and reconciliation (also serves status-only queries)
paymentSchema.index({ status: 1, paidAt: -1 }); // cash-up: money in over a period
paymentSchema.index({ branchId: 1, status: 1, paidAt: -1 }); // ...for one branch
paymentSchema.index({ mpesaPhone: 1, createdAt: -1 }); // per-phone STK prompt cap
// The refunds-owed queue: only the (few) refunded payments are ever indexed here.
paymentSchema.index({ refundedAt: 1 }, { partialFilterExpression: { status: 'refunded' } });
// A reversal receipt can settle exactly one refund.
paymentSchema.index({ refundReference: 1 }, { unique: true, partialFilterExpression: { refundReference: { $type: 'string' } } });
// Late-success reconciliation only ever looks at the (few) payments that have it.
paymentSchema.index({ 'lateSuccessMeta.receivedAt': 1 }, { partialFilterExpression: { 'lateSuccessMeta.receivedAt': { $exists: true } } });

// Keep the denormalised branch in step with the order for every payment saved through the model.
paymentSchema.pre('validate', async function setBranchFromOrder() {
  if (this.branchId || !this.orderId) return;
  const order = await mongoose.model('Order').findById(this.orderId).select('branchId').lean();
  if (order?.branchId) this.branchId = order.branchId;
});

module.exports = mongoose.model('Payment', paymentSchema);
