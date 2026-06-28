const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema({
  code:          { type: String, required: true, uppercase: true, trim: true },
  discountType:  { type: String, enum: ['percentage', 'fixed'], required: true },
  discountValue: { type: Number, required: true, min: 0 },
  minOrderValue: { type: Number, default: 0 },
  expiresAt:     { type: Date, default: null },
  usageLimit:    { type: Number, default: null }, // null = unlimited
  usedCount:     { type: Number, default: 0 },
  assignedTo:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // null = public
  isActive:      { type: Boolean, default: true },
  branchId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  createdBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

couponSchema.index({ branchId: 1, code: 1 }, { unique: true });
couponSchema.index({ branchId: 1, isActive: 1 });
couponSchema.index({ assignedTo: 1 });

module.exports = mongoose.model('Coupon', couponSchema);
