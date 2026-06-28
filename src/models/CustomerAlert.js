const mongoose = require('mongoose');

// Tracks "Notify me" subscriptions from customers.
// Supported types:
//   back_in_stock — fire once when packaging.stock goes from 0 → >0
//   price_drop    — fire whenever price drops below the threshold stored at subscription time
const customerAlertSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  branchId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  type:        { type: String, enum: ['back_in_stock', 'price_drop'], required: true },
  productId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productName: { type: String, required: true }, // snapshot
  varietyName: { type: String, required: true },
  packaging:   { type: String, required: true }, // size string
  // For price_drop: the price at subscription time — only alert when newPrice < this
  priceAtSubscription: { type: Number, default: null },
  isActive:         { type: Boolean, default: true },
  lastTriggeredAt:  { type: Date, default: null },
  createdAt:        { type: Date, default: Date.now },
}, { timestamps: false });

customerAlertSchema.index({ userId: 1, isActive: 1 });
customerAlertSchema.index({ productId: 1, varietyName: 1, packaging: 1, type: 1, isActive: 1 });

module.exports = mongoose.model('CustomerAlert', customerAlertSchema);
