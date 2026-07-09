const mongoose = require('mongoose');

const promotionSchema = new mongoose.Schema({
  branchId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  title:           { type: String, required: true, trim: true },
  description:     { type: String, default: null, trim: true },
  imageUrl:        { type: String, default: null },
  // Only banner/seasonal types render media on the storefront (PromoBannerCarousel) —
  // mediaType picks which of imageUrl/videoUrl is shown; the other is ignored.
  mediaType:       { type: String, enum: ['image', 'video'], default: 'image' },
  videoUrl:        { type: String, default: null },
  type:            { type: String, enum: ['banner', 'featured_product', 'seasonal', 'tip'], required: true },
  linkedProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  startDate:       { type: Date, default: null },
  endDate:         { type: Date, default: null },
  isActive:        { type: Boolean, default: true },
  seasonTag:       { type: String, default: null },
  sortOrder:       { type: Number, default: 0 },
  createdBy:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

promotionSchema.index({ branchId: 1, isActive: 1, sortOrder: 1 });
promotionSchema.index({ branchId: 1, type: 1 });
promotionSchema.index({ branchId: 1, startDate: 1, endDate: 1 });

module.exports = mongoose.model('Promotion', promotionSchema);
