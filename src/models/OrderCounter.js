const mongoose = require('mongoose');

// Per-branch order counter — _id is 'counter_<branchId>_<year>'
const orderCounterSchema = new mongoose.Schema({
  _id: { type: String }, // 'counter_<branchId>_<year>'
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  year: { type: Number, required: true },
  seq: { type: Number, default: 0 }
}, {
  versionKey: false
});

module.exports = mongoose.model('OrderCounter', orderCounterSchema);
