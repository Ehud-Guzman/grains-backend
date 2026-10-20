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
  reconciledAt: { type: Date, default: null }
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
// Late-success reconciliation only ever looks at the (few) payments that have it.
paymentSchema.index({ 'lateSuccessMeta.receivedAt': 1 }, { partialFilterExpression: { 'lateSuccessMeta.receivedAt': { $exists: true } } });

// Keep the denormalised branch in step with the order for every payment saved through the model.
paymentSchema.pre('validate', async function setBranchFromOrder() {
  if (this.branchId || !this.orderId) return;
  const order = await mongoose.model('Order').findById(this.orderId).select('branchId').lean();
  if (order?.branchId) this.branchId = order.branchId;
});

module.exports = mongoose.model('Payment', paymentSchema);
