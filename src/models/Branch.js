const mongoose = require('mongoose');

const branchSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true },     // e.g. "Nairobi Branch"
  slug:     { type: String, required: true, trim: true, lowercase: true, unique: true }, // e.g. "nairobi"
  location: { type: String, default: null },
  phone:    { type: String, default: null },
  email:    { type: String, default: null },
  isActive: { type: Boolean, default: true },
  isDefault: { type: Boolean, default: false }, // the branch shown on the public shop
}, {
  timestamps: true
});

branchSchema.index({ slug: 1 }, { unique: true });
branchSchema.index({ isActive: 1 });
branchSchema.index({ isDefault: 1 });

module.exports = mongoose.model('Branch', branchSchema);
