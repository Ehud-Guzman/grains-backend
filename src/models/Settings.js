const mongoose = require('mongoose');

// Single-document settings store — only one document ever exists (_id: 'app_settings')
// All fields are optional with sensible defaults
const settingsSchema = new mongoose.Schema({
  _id: { type: String, default: 'app_settings' },

  // ── SHOP INFO ─────────────────────────────────────────────────────────────
  shopName:     { type: String, default: 'Vittorios Grains & Cereals' },
  shopTagline:  { type: String, default: 'Quality grains, delivered fresh' },
  shopPhone:    { type: String, default: '+254 799 031 449' },
  shopEmail:    { type: String, default: 'vittoriostrades@gmail.com' },
  shopHours:    { type: String, default: 'Mon – Sat: 7:00 AM – 7:00 PM' },
  shopLocation: { type: String, default: 'Bungoma, Kenya' },
  shopWhatsapp: { type: String, default: '' },

  // ── ORDER SETTINGS ────────────────────────────────────────────────────────
  deliveryFee:          { type: Number, default: 0 },    // KES, 0 = free / calculated manually
  minimumOrderValue:    { type: Number, default: 0 },    // KES, 0 = no minimum
  autoCancelHours:      { type: Number, default: 0 },    // hours before pending orders auto-cancel, 0 = disabled
  allowGuestOrders:     { type: Boolean, default: true },
  allowCashOnDelivery:  { type: Boolean, default: true },
  allowPayOnPickup:     { type: Boolean, default: true },
  allowMpesa:           { type: Boolean, default: true },

  // ── STOCK SETTINGS ────────────────────────────────────────────────────────
  defaultLowStockThreshold: { type: Number, default: 10 }, // used when none set on packaging

  // ── NOTIFICATION SETTINGS ─────────────────────────────────────────────────
  notifyAdminNewOrder:      { type: Boolean, default: true },
  notifyAdminLowStock:      { type: Boolean, default: true },
  notifyCustomerOnApproval: { type: Boolean, default: true },
  notifyCustomerOnRejection:{ type: Boolean, default: true },
  notifyCustomerOnDelivery: { type: Boolean, default: true },
  smsEnabled:               { type: Boolean, default: false }, // Phase 2

  // ── SYSTEM SETTINGS (superadmin only) ────────────────────────────────────
  maintenanceMode:    { type: Boolean, default: false },
  maintenanceMessage: { type: String, default: 'We are currently undergoing maintenance. Please check back soon.' },

  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, {
  _id: false, // use string _id defined above
  timestamps: false,
});

module.exports = mongoose.model('Settings', settingsSchema);