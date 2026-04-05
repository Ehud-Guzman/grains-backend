const mongoose = require('mongoose');
const { ROLES } = require('../utils/constants');

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
  addresses: [addressSchema],
  notes: { type: String, default: null }, // internal admin notes
  isLocked: { type: Boolean, default: false },
  failedLoginCount: { type: Number, default: 0 },
  lastLoginAt: { type: Date, default: null },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null }, // null = superadmin (no branch)
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
userSchema.index({ email: 1 }, { unique: true, sparse: true });
userSchema.index({ role: 1 });
userSchema.index({ branchId: 1 });

module.exports = mongoose.model('User', userSchema);
