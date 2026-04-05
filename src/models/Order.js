const mongoose = require('mongoose');
const {
  ORDER_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  DELIVERY_METHODS,
  STOCK_RESERVATION_STATUSES
} = require('../utils/constants');

const orderItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productName: { type: String, required: true }, // snapshot at time of order
  variety: { type: String, required: true },
  packaging: { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, required: true },
  lineTotal: { type: Number, required: true }
}, { _id: false });

const statusHistorySchema = new mongoose.Schema({
  status: { type: String, required: true },
  changedAt: { type: Date, default: Date.now },
  changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  note: { type: String, default: null }
}, { _id: false });

const orderSchema = new mongoose.Schema({
  orderRef: { type: String, required: true, unique: true }, // ORD-2025-0001
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  guestId: { type: mongoose.Schema.Types.ObjectId, ref: 'Guest', default: null },
  orderItems: [orderItemSchema],
  subtotal: { type: Number, required: true },
  deliveryFee: { type: Number, default: 0 },
  total: { type: Number, required: true },
  deliveryMethod: { type: String, enum: Object.values(DELIVERY_METHODS), required: true },
  deliveryAddress: { type: String, default: null },
  paymentMethod: { type: String, enum: Object.values(PAYMENT_METHODS), required: true },
  paymentStatus: { type: String, enum: Object.values(PAYMENT_STATUSES), default: PAYMENT_STATUSES.PENDING },
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
  status: {
    type: String,
    enum: Object.values(ORDER_STATUSES),
    default: ORDER_STATUSES.PENDING
  },
  rejectionReason: { type: String, default: null },
  stockReservationStatus: {
    type: String,
    enum: Object.values(STOCK_RESERVATION_STATUSES),
    default: STOCK_RESERVATION_STATUSES.NONE
  },
  stockReservedAt: { type: Date, default: null },
  stockReleasedAt: { type: Date, default: null },
  stockConsumedAt: { type: Date, default: null },
  statusHistory: [statusHistorySchema],
  specialInstructions: { type: String, default: null },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  driverId: { type: mongoose.Schema.Types.ObjectId, default: null },
  deliveryTrackingUrl: { type: String, default: null },
  // SHA-256 hash of the one-time tracking token issued to the guest at order creation.
  // Only guest orders have this set. Never stored or returned in plaintext.
  trackingTokenHash: { type: String, default: null, select: false }
}, {
  timestamps: true
});

// Indexes
orderSchema.index({ branchId: 1 });
orderSchema.index({ branchId: 1, status: 1 });
orderSchema.index({ branchId: 1, status: 1, stockReservationStatus: 1, createdAt: -1 });
orderSchema.index({ branchId: 1, createdAt: -1 });
orderSchema.index({ userId: 1 });
orderSchema.index({ guestId: 1 });
orderSchema.index({ status: 1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ orderRef: 1 }, { unique: true });
orderSchema.index({ branchId: 1, paymentStatus: 1 }); // payment reconciliation queries

module.exports = mongoose.model('Order', orderSchema);
