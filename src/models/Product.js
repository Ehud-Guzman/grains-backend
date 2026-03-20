const mongoose = require('mongoose');

const packagingSchema = new mongoose.Schema({
  size: { type: String, required: true }, // e.g. "50kg", "90kg", "Bulk"
  priceKES: { type: Number, default: null },
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
  // Future-proofing fields from UX doc Section D3
  branchId: { type: mongoose.Schema.Types.ObjectId, default: null },
  discountRules: { type: Array, default: [] },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, {
  timestamps: true
});

// Indexes
productSchema.index({ category: 1 });
productSchema.index({ isActive: 1 });
productSchema.index({ name: 'text', description: 'text' }); // text search

module.exports = mongoose.model('Product', productSchema);
