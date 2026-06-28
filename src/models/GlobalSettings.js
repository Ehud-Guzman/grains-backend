// ── GLOBAL SETTINGS MODEL ─────────────────────────────────────────────────────
// Singleton document (always _id = 'global') for system-wide config that spans
// all branches — currently eTIMS credentials and per-feature role gating.

const mongoose = require('mongoose');

const ETIMS_ALLOWED_ROLES = ['staff', 'supervisor', 'admin', 'superadmin'];

const globalSettingsSchema = new mongoose.Schema({
  _id: { type: String, default: 'global' },

  etims: {
    enabled:      { type: Boolean, default: false },
    baseUrl:      { type: String,  default: '' },   // KRA endpoint, no trailing slash
    tin:          { type: String,  default: '' },   // KRA PIN e.g. P051234567X
    bhfId:        { type: String,  default: '00' }, // branch ID issued by KRA
    deviceId:     { type: String,  default: '' },   // eTIMS device serial number
    // Roles that can see eTIMS status on orders and trigger manual resubmission
    allowedRoles: {
      type:    [String],
      enum:    ETIMS_ALLOWED_ROLES,
      default: ['admin', 'superadmin']
    }
  }
}, {
  timestamps: true,
  _id: false   // suppress auto ObjectId — we use the string 'global'
});

module.exports = mongoose.model('GlobalSettings', globalSettingsSchema);
