const mongoose = require('mongoose');

// One short-lived row per recently placed order, keyed by a fingerprint of the checkout (who, which basket,
// what total). It exists to refuse an exact double-submission, and it replaces "use the branch order counter
// as a mutex" (2026-10 audit, F-05/F-36): inserting the same _id twice is a unique-key clash that MongoDB
// resolves for us, with no shared hot document between unrelated orders.
// Rows are inserted inside the order's own transaction, so a failed order leaves nothing behind.
const orderDedupeSchema = new mongoose.Schema({
  _id: { type: String },
  createdAt: { type: Date, required: true }
}, { versionKey: false });

// Cleanup only - the 20s window itself is enforced by comparing createdAt (the TTL monitor runs about once a minute).
orderDedupeSchema.index({ createdAt: 1 }, { expireAfterSeconds: 120 });

module.exports = mongoose.model('OrderDedupe', orderDedupeSchema);
