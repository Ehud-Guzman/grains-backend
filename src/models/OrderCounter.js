const mongoose = require('mongoose');

const orderCounterSchema = new mongoose.Schema({
  _id: { type: String }, // 'order_counter'
  year: { type: Number, required: true },
  seq: { type: Number, default: 0 }
}, {
  versionKey: false
});

module.exports = mongoose.model('OrderCounter', orderCounterSchema);
