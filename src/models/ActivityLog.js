const mongoose = require('mongoose');
const { ROLES, LOG_ACTIONS } = require('../utils/constants');

const activityLogSchema = new mongoose.Schema({
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  actorRole: { type: String, required: true, enum: [...Object.values(ROLES), 'system'] },
  action: { type: String, required: true, enum: Object.values(LOG_ACTIONS) }, // e.g. ORDER_APPROVED, PRODUCT_EDITED
  targetId: { type: mongoose.Schema.Types.ObjectId, default: null },
  targetType: { type: String, default: null }, // 'Order', 'Product', 'User', 'Stock'
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null }, // null = global/system action
  detail: { type: mongoose.Schema.Types.Mixed, default: {} }, // before/after values
  ip: { type: String, default: null },
  userAgent: { type: String, default: null },
  timestamp: { type: Date, default: Date.now }
}, {
  versionKey: false // immutable — no version tracking needed
});

// Indexes
activityLogSchema.index({ branchId: 1, timestamp: -1 });
activityLogSchema.index({ actorId: 1 });
activityLogSchema.index({ action: 1 });
activityLogSchema.index({ timestamp: -1 });
activityLogSchema.index({ action: 1, timestamp: -1 }); // action-filtered queries with date range (e.g. recent LOGIN_FAILED events)
activityLogSchema.index({ targetType: 1 }); // getLogs() filters directly on this
activityLogSchema.index({ branchId: 1, action: 1, timestamp: -1 }); // admin log viewer's common combined filter

module.exports = mongoose.model('ActivityLog', activityLogSchema);
