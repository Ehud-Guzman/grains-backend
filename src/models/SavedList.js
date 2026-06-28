const mongoose = require('mongoose');

const savedListItemSchema = new mongoose.Schema({
  productId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productName: { type: String, required: true },
  variety:     { type: String, required: true },
  packaging:   { type: String, required: true },
  quantity:    { type: Number, required: true, min: 1 },
}, { _id: false });

const savedListSchema = new mongoose.Schema({
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:    { type: String, required: true, trim: true, maxlength: 80 },
  items:   [savedListItemSchema],
}, { timestamps: true });

savedListSchema.index({ userId: 1 });

module.exports = mongoose.model('SavedList', savedListSchema);
