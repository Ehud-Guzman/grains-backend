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
  timestamp: { type: Date, default: Date.now },
  // Idempotency key for the delivery duplicate guard — see stock.service.js.
  // Encodes branch|product|variety|packaging|changeType|quantity|performedBy and
  // a 15-second time bucket, so the guard is enforced by the database instead of
  // by a read-then-write check that two concurrent submissions can both pass.
  // Deliberately has NO default: a field present-as-null would itself be indexed
  // and collide with every other log, so it must be absent for non-delivery rows.
  dedupeKey: { type: String }
}, {
  // No timestamps - using explicit timestamp field; logs are immutable
  versionKey: false
});

// Indexes
stockLogSchema.index({ branchId: 1, timestamp: -1 });
stockLogSchema.index({ productId: 1, varietyName: 1, packagingSize: 1, timestamp: -1 }); // getLogs() always sorts by timestamp after this filter
stockLogSchema.index({ timestamp: -1 });
stockLogSchema.index({ performedBy: 1 });

// Unique + partial (not sparse) so the guard applies only to rows that actually
// carry a dedupeKey. Existing delivery logs predate this field, so they are not
// indexed and cannot block index creation. Run `npm run sync:indexes` after
// deploying — if the index is missing, the guard degrades to the previous
// best-effort behaviour rather than erroring.
stockLogSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } }
);

module.exports = mongoose.model('StockLog', stockLogSchema);
