const mongoose = require('mongoose');

const discountRuleSchema = new mongoose.Schema({
  minQuantityKg:   { type: Number, required: true, min: 1 },
  discountPercent: { type: Number, required: true, min: 0.1, max: 100 }
}, { _id: false });

const pricingTierSchema = new mongoose.Schema({
  minQty:   { type: Number, required: true, min: 1 },
  priceKES: { type: Number, required: true, min: 0 },
}, { _id: false });

const packagingSchema = new mongoose.Schema({
  size: { type: String, required: true }, // e.g. "50kg", "90kg", "Bulk"
  priceKES: { type: Number, default: null },
  costPriceKES: { type: Number, default: null }, // optional cost price for margin tracking
  pricingTiers: { type: [pricingTierSchema], default: [] }, // volume discount tiers
  stock: { type: Number, default: 0 },
  lowStockThreshold: { type: Number, default: 10 },
  quoteOnly: { type: Boolean, default: false } // true for Bulk — no fixed price
}, { _id: false });

const varietySchema = new mongoose.Schema({
  varietyName: { type: String, required: true, trim: true },
  description: { type: String, default: null },
  imageURLs: [{ type: String }],
  packaging: [packagingSchema]
}, { _id: false });

const productSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  category: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  imageURLs: [{ type: String }],
  isActive: { type: Boolean, default: true },
  varieties: [varietySchema],
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  discountRules: { type: [discountRuleSchema], default: [] },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, {
  timestamps: true
});

// Indexes
productSchema.index({ branchId: 1 });
productSchema.index({ branchId: 1, category: 1 });
productSchema.index({ branchId: 1, isActive: 1 });
productSchema.index({ branchId: 1, isActive: 1, createdAt: -1 });
productSchema.index({ branchId: 1, isActive: 1, category: 1, createdAt: -1 });
productSchema.index({ name: 'text', description: 'text' }); // text search

module.exports = mongoose.model('Product', productSchema);
