const mongoose = require('mongoose');

// Per-branch settings — _id is 'settings_<branchId>'
// One document per branch, created on first access with sensible defaults.
const settingsSchema = new mongoose.Schema({
  _id: { type: String }, // 'settings_<branchId>'

  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },

  // ── SHOP INFO ─────────────────────────────────────────────────────────────
  shopName:     { type: String, default: 'Vittorios Grains & Cereals' },
  shopTagline:  { type: String, default: 'Quality grains, delivered fresh' },
  shopPhone:    { type: String, default: '+254 799 031 449' },
  shopEmail:    { type: String, default: 'vittoriostrades@gmail.com' },
  shopHours:    { type: String, default: 'Mon – Sat: 7:00 AM – 7:00 PM' },
  shopLocation: { type: String, default: 'Bungoma, Kenya' },
  shopWhatsapp: { type: String, default: '' },

  // ── ORDER SETTINGS ────────────────────────────────────────────────────────
  deliveryFee:          { type: Number, default: 0 },
  minimumOrderValue:    { type: Number, default: 0 },
  autoCancelHours:      { type: Number, default: 0 },
  allowGuestOrders:     { type: Boolean, default: true },
  allowCashOnDelivery:  { type: Boolean, default: true },
  allowPayOnPickup:     { type: Boolean, default: true },
  allowMpesa:           { type: Boolean, default: true },

  // ── ORDER WORKFLOW ────────────────────────────────────────────────────────
  requireOrderApproval:     { type: Boolean, default: false }, // manual approval before confirmed
  enableOrderHours:         { type: Boolean, default: false }, // restrict when orders can be placed
  orderAcceptanceStart:     { type: String,  default: '07:00' }, // HH:MM
  orderAcceptanceEnd:       { type: String,  default: '20:00' }, // HH:MM

  // ── DELIVERY ZONES ────────────────────────────────────────────────────────
  useDeliveryZones:  { type: Boolean, default: false },
  deliveryZones:     { type: [{ name: String, fee: { type: Number, default: 0 }, _id: false }], default: [] },

  // ── CATALOG SETTINGS ──────────────────────────────────────────────────────
  autoHideOutOfStock:  { type: Boolean, default: false },
  allowProductReviews: { type: Boolean, default: false },

  // ── CUSTOMER ACCOUNT SETTINGS ─────────────────────────────────────────────
  blockNewRegistrations:    { type: Boolean, default: false },
  requirePhoneVerification: { type: Boolean, default: false },
  requireEmailVerification: { type: Boolean, default: false },

  // ── RECEIPT ───────────────────────────────────────────────────────────────
  receiptFooterNote: { type: String, default: '' },

  // ── STOCK SETTINGS ────────────────────────────────────────────────────────
  defaultLowStockThreshold: { type: Number, default: 10 },

  // ── NOTIFICATION SETTINGS ─────────────────────────────────────────────────
  notifyAdminNewOrder:      { type: Boolean, default: true },
  notifyAdminLowStock:      { type: Boolean, default: true },
  notifyCustomerOnApproval: { type: Boolean, default: true },
  notifyCustomerOnRejection:{ type: Boolean, default: true },
  notifyCustomerOnDelivery: { type: Boolean, default: true },
  smsEnabled:               { type: Boolean, default: false },

  // ── SYSTEM SETTINGS (superadmin only) ────────────────────────────────────
  maintenanceMode:    { type: Boolean, default: false },
  maintenanceMessage: { type: String, default: 'We are currently undergoing maintenance. Please check back soon.' },
  // Platform-level controls
  platformLocked:        { type: Boolean, default: false },   // blocks all writes across the branch
  allowNewAdminAccounts: { type: Boolean, default: true  },   // gate on admin account creation
  maxProductsPerBranch:  { type: Number,  default: 0     },   // 0 = unlimited
  maxStaffPerBranch:     { type: Number,  default: 0     },   // 0 = unlimited
  logRetentionDays:      { type: Number,  default: 90    },   // 0 = keep forever

  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, {
  _id: false,
  timestamps: false,
});

module.exports = mongoose.model('Settings', settingsSchema);
