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

// Credential and auth-state fields are `select: false`: a query only returns them when it asks with
// `.select('+field')`. They used to be hidden by per-query deny-lists, and every endpoint that forgot one
// (customer profile, drivers, /auth/me, the staff list) returned OTP hashes - a 6-digit code hashed with
// bcrypt is crackable offline in minutes (2026-10 audit, F-08).
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email:     { type: String, trim: true, lowercase: true, default: null },
  avatarURL: { type: String, default: null },
  phone: { type: String, required: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
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
  // Kenya DPA 2019 s.37 requires EXPRESS opt-in consent before using personal data
  // for commercial messaging — default false means nobody receives marketing SMS
  // (broadcast.service.js) until they actively consent. Transactional/order SMS in
  // notification.service.js are unaffected. marketingConsentAt is the audit trail
  // of when consent was given (null when consent is absent or withdrawn).
  marketingConsent: { type: Boolean, default: false },
  marketingConsentAt: { type: Date, default: null },
  isLocked: { type: Boolean, default: false },
  // Bumped whenever a role change must invalidate already-issued access tokens —
  // isLocked alone stops a locked account immediately, but a role DOWNGRADE
  // leaves the old (higher-privilege) role baked into any JWT issued before the
  // change, which auth.middleware.js can't otherwise revoke (access tokens are
  // stateless — only explicitly logged-out/refreshed tokens are in TokenBlacklist).
  tokenValidAfter: { type: Date, default: null },
  failedLoginCount: { type: Number, default: 0 },
  // Timed lockout after repeated wrong passwords (auth.service.js) — distinct from
  // isLocked, which is a deliberate admin lock and never expires on its own.
  loginLockedUntil: { type: Date, default: null },
  lastLoginAt: { type: Date, default: null },
  passwordResetOtpHash: { type: String, default: null, select: false },
  passwordResetExpires: { type: Date, default: null, select: false },
  passwordResetAttempts: { type: Number, default: 0, select: false },
  // Admin/superadmin login 2FA (see auth.service.js TWO_FACTOR_ROLES)
  twoFactorOtpHash: { type: String, default: null, select: false },
  twoFactorExpires: { type: Date, default: null, select: false },
  twoFactorAttempts: { type: Number, default: 0, select: false },
  // Used to detect new-device/location admin logins (alert.service.js NEW_DEVICE_ADMIN_LOGIN)
  lastLoginIp: { type: String, default: null, select: false },
  lastLoginUserAgent: { type: String, default: null, select: false },
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
  // Branches this customer has placed an order at. Customer ACCOUNTS are shared across branches, but branch
  // staff may only see and act on customers who have actually dealt with their branch (2026-10 audit, F-13).
  // Maintained by order placement; backfilled for older orders by utils/migrations.js.
  orderedBranchIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }],
  onboarding: {
    type: onboardingSchema,
    default: () => ({})
  }
}, {
  timestamps: true
});

// Belt and braces: even a document that was loaded WITH these fields never serialises them.
const SECRET_FIELDS = [
  'passwordHash', 'passwordResetOtpHash', 'passwordResetExpires', 'passwordResetAttempts',
  'twoFactorOtpHash', 'twoFactorExpires', 'twoFactorAttempts'
];
userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    for (const f of SECRET_FIELDS) delete ret[f];
    return ret;
  }
});

// Indexes
userSchema.index({ phone: 1 }, { unique: true });
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
userSchema.index({ role: 1, createdAt: -1 }); // covers role-only queries too (prefix), plus role+sort admin/customer lists
userSchema.index({ branchId: 1 });
userSchema.index({ branchId: 1, createdAt: -1 }); // branch-scoped new-user reports
userSchema.index({ role: 1, orderedBranchIds: 1, createdAt: -1 }); // a branch's customer list

module.exports = mongoose.model('User', userSchema);
