const mongoose = require('mongoose');

const guestSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true, trim: true },
  location: { type: String, trim: true },
  orders: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Order' }]
}, {
  timestamps: true
});

// Index
// unique: true is load-bearing for order.service.js#createGuestOrder's
// create-then-catch-E11000 race guard — without it, two concurrent upserts/
// inserts for a brand-new phone can both succeed (Mongo only rejects a second
// insert here because the index enforces it; nothing else does).
guestSchema.index({ phone: 1 }, { unique: true });
guestSchema.index({ createdAt: 1 }); // cleanup.job.js's daily stale-guest sweep

module.exports = mongoose.model('Guest', guestSchema);
