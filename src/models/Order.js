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
  lineTotal: { type: Number, required: true },
  taxable: { type: Boolean, default: true } // snapshot of product.taxable at order time
}, { _id: false });

const statusHistorySchema = new mongoose.Schema({
  status: { type: String, required: true },
  changedAt: { type: Date, default: Date.now },
  changedBy: { type: mongoose.Schema.Types.ObjectId, required: true },
  // INTERNAL: staff remarks ("no location shared - check distance", cancel/reject reasons). Never sent to customers.
  note: { type: String, default: null },
  // Customer-visible text for this step, if any. Customer and tracking payloads show only this.
  publicNote: { type: String, default: null }
}, { _id: false });

const orderSchema = new mongoose.Schema({
  // NAI-2026-0153 (branch code - year - per-branch sequence); orders from before branch codes look like
  // ORD-2026-0152. Unique across ALL branches - utils/branchCode.js is what keeps that true.
  orderRef: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  guestId: { type: mongoose.Schema.Types.ObjectId, ref: 'Guest', default: null },
  // Snapshot of the guest's name/phone at order placement — Guest documents can be
  // purged by cleanup.job.js's retention sweep, but the order itself (a financial/
  // KRA-relevant record) must remain identifiable even after that happens.
  guestName:  { type: String, default: null },
  guestPhone: { type: String, default: null },
  orderItems: [orderItemSchema],
  subtotal: { type: Number, required: true },
  deliveryFee: { type: Number, default: 0 },
  // VAT snapshot — captured at creation so receipt is always accurate, even if settings change later
  vatEnabled: { type: Boolean, default: false },
  vatRate:    { type: Number,  default: 0 },   // e.g. 16 (percent)
  vatAmount:  { type: Number,  default: 0 },   // calculated amount in KES
  total: { type: Number, required: true },
  deliveryMethod: { type: String, enum: Object.values(DELIVERY_METHODS), required: true },
  deliveryAddress: { type: String, default: null },
  paymentMethod: { type: String, enum: Object.values(PAYMENT_METHODS), required: true },
  paymentStatus: { type: String, enum: Object.values(PAYMENT_STATUSES), default: PAYMENT_STATUSES.UNPAID },
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
  // Customer's requested delivery/pickup date from checkout — a planning hint
  // for logistics, not a hard commitment; admin sees it on the order detail.
  preferredDeliveryDate: { type: Date, default: null },
  couponCode:     { type: String, default: null },
  couponDiscount: { type: Number, default: 0 },
  buyerKraPin: { type: String, default: null },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Proof of delivery captured by the driver when completing a delivery —
  // optional (drivers may have no camera/data at handover), but once present
  // it's the wholesale dispute trail: who received the goods and when.
  deliveryProof: {
    photoURL: { type: String, default: null },      // Cloudinary URL
    recipientName: { type: String, default: null }, // who physically received the goods
    note: { type: String, default: null },
    capturedAt: { type: Date, default: null }
  },
  preferredDriverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // customer's requested rider at checkout — admin still confirms actual assignment
  // Customer's GPS coordinates at checkout — stored for driver reference & analytics
  deliveryCoordinates: {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null }
  },
  // Haversine distance from branch to customer (km), null for pickup or unknown location
  deliveryDistanceKm: { type: Number, default: null },
  deliveredAt: { type: Date, default: null },

  // KRA eTIMS fiscal invoice — 'not_required' is the default for orders that
  // haven't reached an invoiceable state yet (or never will: pending/rejected/
  // cancelled); submitInvoice() moves it not_required -> pending -> submitted|failed.
  // Existing orders created before this default was added stay `undefined` in the
  // DB rather than being retroactively backfilled — code that checks this field
  // must treat undefined and 'not_required' as equivalent ("nothing to show").
  etimsStatus:        { type: String, enum: ['not_required', 'pending', 'submitted', 'failed'], default: 'not_required' },
  etimsInvoiceNumber: { type: String },
  etimsControlNumber: { type: String }
}, {
  timestamps: true
});

// Indexes
orderSchema.index({ branchId: 1, status: 1, createdAt: -1 }); // admin lists filtered by status, newest first (prefix-covers branch and branch+status)
orderSchema.index({ branchId: 1, status: 1, stockReservationStatus: 1, createdAt: -1 });
orderSchema.index({ branchId: 1, createdAt: -1 });
orderSchema.index({ userId: 1 });
orderSchema.index({ guestId: 1 });
orderSchema.index({ status: 1 });
orderSchema.index({ couponCode: 1 }, { partialFilterExpression: { couponCode: { $type: 'string' } } }); // coupon usage checks only look at orders that used one
orderSchema.index({ status: 1, deliveredAt: 1 }); // cash-up / rider reports over a delivery window
// eTIMS retry + the 'stuck pending' integrity check only look at the few invoices not yet accepted.
orderSchema.index({ etimsStatus: 1, updatedAt: 1 }, { partialFilterExpression: { etimsStatus: { $in: ['pending', 'failed'] } } });
orderSchema.index({ createdAt: -1 });
// (orderRef's unique index is declared on the field above - declaring it twice only produced a warning)
orderSchema.index({ branchId: 1, paymentStatus: 1 }); // payment reconciliation queries
orderSchema.index({ driverId: 1, status: 1 }); // driver "my orders"/"my stats" + admin rider report

module.exports = mongoose.model('Order', orderSchema);
