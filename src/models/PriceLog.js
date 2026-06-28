const mongoose = require('mongoose');

const priceLogSchema = new mongoose.Schema({
  productId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  branchId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Branch',  required: true },
  varietyName: { type: String, required: true },
  packaging:   { type: String, required: true }, // size string, e.g. "50 kg"
  oldPrice:    { type: Number, required: true },
  newPrice:    { type: Number, required: true },
  changedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  changedAt:   { type: Date, default: Date.now },
  note:        { type: String, default: null },
  seasonTag:   { type: String, enum: ['harvesting', 'drought', 'planting', 'import_hike', 'normal', null], default: null },
}, { timestamps: false });

priceLogSchema.index({ productId: 1, branchId: 1, varietyName: 1, packaging: 1, changedAt: -1 });
priceLogSchema.index({ productId: 1, changedAt: -1 });

module.exports = mongoose.model('PriceLog', priceLogSchema);
