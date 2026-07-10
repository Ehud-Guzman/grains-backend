const mongoose = require('mongoose');
const { PAYMENT_METHODS, PAYMENT_STATUSES } = require('../utils/constants');

const paymentSchema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
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
  lateSuccessMeta: { type: mongoose.Schema.Types.Mixed, default: null }
}, {
  timestamps: true
});

// Indexes
paymentSchema.index({ orderId: 1 });
// partialFilterExpression (not sparse) because MongoDB's sparse still indexes
// explicit null values — partial filter skips them cleanly.
paymentSchema.index({ checkoutRequestId: 1 },   { unique: true, partialFilterExpression: { checkoutRequestId:   { $type: 'string' } } });
paymentSchema.index({ mpesaTransactionId: 1 },  { unique: true, partialFilterExpression: { mpesaTransactionId:  { $type: 'string' } } });
paymentSchema.index({ status: 1 });
paymentSchema.index({ status: 1, createdAt: -1 }); // date-ranged payment reports and reconciliation

module.exports = mongoose.model('Payment', paymentSchema);
