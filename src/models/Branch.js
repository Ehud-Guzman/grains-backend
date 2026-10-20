const mongoose = require('mongoose');

const branchSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true },     // e.g. "Nairobi Branch"
  slug:     { type: String, required: true, trim: true, lowercase: true, unique: true }, // e.g. "nairobi"
  location: { type: String, default: null },
  phone:    { type: String, default: null },
  email:    { type: String, default: null },
  isActive: { type: Boolean, default: true },
  isDefault: { type: Boolean, default: false }, // the branch shown on the public shop
  // Short order-reference prefix ("NAI" -> NAI-2026-0153). Assigned automatically from the slug the
  // first time the branch needs one (see utils/branchCode.js) and unique across branches, because
  // Order.orderRef is unique across ALL branches while each branch counts its own orders from 1:
  // without a distinct prefix the second branch collided with the first on ORD-<year>-0001 and
  // could never place an order.
  code:     { type: String, uppercase: true, trim: true, match: /^[A-Z0-9]{2,8}$/ },
}, {
  timestamps: true
});

branchSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string' } } });
branchSchema.index({ isActive: 1 });
branchSchema.index({ isDefault: 1 });

module.exports = mongoose.model('Branch', branchSchema);
