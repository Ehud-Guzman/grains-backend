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
  refundedAt: { type: Date, default: null },
  refundReason: { type: String, default: null },
  confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, {
  timestamps: true
});

// Indexes
paymentSchema.index({ orderId: 1 });
paymentSchema.index({ checkoutRequestId: 1 }, { unique: true, sparse: true });
paymentSchema.index({ status: 1 });
paymentSchema.index({ status: 1, createdAt: -1 }); // date-ranged payment reports and reconciliation

module.exports = mongoose.model('Payment', paymentSchema);
