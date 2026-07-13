const mongoose = require('mongoose');
const { ROLES, PERMISSIONS } = require('../utils/constants');

const addressSchema = new mongoose.Schema({
  label: { type: String, required: true },
  value: { type: String, required: true },
  isDefault: { type: Boolean, default: false }
}, { _id: false });

const onboardingSchema = new mongoose.Schema({
  version: { type: Number, default: 1 },
  checklistProgress: {
    type: Map,
    of: Boolean,
    default: () => ({})
  },
  dismissedTips: {
    type: [String],
    default: []
  },
  toursCompleted: {
    type: [String],
    default: []
  },
  milestones: {
    type: [String],
    default: []
  },
  helpCenterOpenedCount: {
    type: Number,
    default: 0
  },
  lastMilestoneAt: {
    type: Date,
    default: null
  },
  updatedAt: {
    type: Date,
    default: null
  }
}, { _id: false });

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email:     { type: String, trim: true, lowercase: true, default: null },
  avatarURL: { type: String, default: null },
  phone: { type: String, required: true, trim: true },
  passwordHash: { type: String, required: true },
  role: {
    type: String,
    enum: Object.values(ROLES).filter(r => r !== 'guest'),
    default: ROLES.CUSTOMER
  },
  // Driver-specific fields (only populated for role === 'driver')
  vehicleInfo: {
    type: { type: String, default: null },   // e.g. 'Motorcycle', 'Pickup', 'Van'
    plate: { type: String, default: null }   // e.g. 'KCA 123A'
  },
  isAvailableForDelivery: { type: Boolean, default: true },
  addresses: [addressSchema],
  notes: { type: String, default: null }, // internal admin notes
  smsOptOut: { type: Boolean, default: false }, // customer opt-out of broadcast.service.js marketing SMS (transactional/order SMS are unaffected)
  isLocked: { type: Boolean, default: false },
  // Bumped whenever a role change must invalidate already-issued access tokens —
  // isLocked alone stops a locked account immediately, but a role DOWNGRADE
  // leaves the old (higher-privilege) role baked into any JWT issued before the
  // change, which auth.middleware.js can't otherwise revoke (access tokens are
  // stateless — only explicitly logged-out/refreshed tokens are in TokenBlacklist).
  tokenValidAfter: { type: Date, default: null },
  failedLoginCount: { type: Number, default: 0 },
  lastLoginAt: { type: Date, default: null },
  passwordResetOtpHash: { type: String, default: null },
  passwordResetExpires: { type: Date, default: null },
  passwordResetAttempts: { type: Number, default: 0 },
  // Admin/superadmin login 2FA (see auth.service.js TWO_FACTOR_ROLES)
  twoFactorOtpHash: { type: String, default: null },
  twoFactorExpires: { type: Date, default: null },
  twoFactorAttempts: { type: Number, default: 0 },
  // Used to detect new-device/location admin logins (alert.service.js NEW_DEVICE_ADMIN_LOGIN)
  lastLoginIp: { type: String, default: null },
  lastLoginUserAgent: { type: String, default: null },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null }, // null = superadmin (no branch)
  // Extra capabilities granted by superadmin (additive — never restricts role permissions)
  customPermissions: {
    type: [{ type: String, enum: Object.values(PERMISSIONS) }],
    default: []
  },
  // If non-empty, user can switch between these branches at login (overrides single branchId check)
  allowedBranchIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch'
  }],
  isB2B: { type: Boolean, default: false }, // true = business customer with KRA PIN
  kraPin: { type: String, trim: true, uppercase: true, default: null }, // buyer KRA PIN, reused to prefill checkout
  orderHistory: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Order' }],
  onboarding: {
    type: onboardingSchema,
    default: () => ({})
  }
}, {
  timestamps: true
});

// Indexes
userSchema.index({ phone: 1 }, { unique: true });
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
userSchema.index({ role: 1, createdAt: -1 }); // covers role-only queries too (prefix), plus role+sort admin/customer lists
userSchema.index({ branchId: 1 });
userSchema.index({ branchId: 1, createdAt: -1 }); // branch-scoped new-user reports

module.exports = mongoose.model('User', userSchema);
