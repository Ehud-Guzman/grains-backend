const mongoose = require('mongoose');
const { STOCK_CHANGE_TYPES } = require('../utils/constants');

const stockLogSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  varietyName: { type: String, required: true },
  packagingSize: { type: String, required: true },
  changeType: { type: String, enum: Object.values(STOCK_CHANGE_TYPES), required: true },
  quantityChange: { type: Number, required: true }, // positive = added, negative = removed
  balanceAfter: { type: Number, required: true },
  reason: { type: String, required: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  supplierId: { type: mongoose.Schema.Types.ObjectId, default: null },
  warehouseId: { type: mongoose.Schema.Types.ObjectId, default: null },
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  timestamp: { type: Date, default: Date.now }
}, {
  // No timestamps - using explicit timestamp field; logs are immutable
  versionKey: false
});

// Indexes
stockLogSchema.index({ branchId: 1, timestamp: -1 });
stockLogSchema.index({ productId: 1, varietyName: 1, packagingSize: 1 });
stockLogSchema.index({ timestamp: -1 });
stockLogSchema.index({ performedBy: 1 });

module.exports = mongoose.model('StockLog', stockLogSchema);
