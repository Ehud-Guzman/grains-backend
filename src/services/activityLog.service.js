const ActivityLog = require('../models/ActivityLog');

// Write an audit log entry - called at end of every mutating operation
const log = async ({ actorId, actorRole, action, targetId = null, targetType = null, detail = {}, ip = null }) => {
  try {
    await ActivityLog.create({
      actorId,
      actorRole,
      action,
      targetId,
      targetType,
      detail,
      ip,
      timestamp: new Date()
    });
  } catch (err) {
    // Never let logging failures crash the main operation
    console.error(`[ActivityLog] Failed to write log: ${err.message}`);
  }
};

// Get paginated activity logs - read-only for superadmin
const getLogs = async (filters = {}, { page = 1, limit = 20 } = {}) => {
  const query = {};

  if (filters.actorId) query.actorId = filters.actorId;
  if (filters.action) query.action = filters.action;
  if (filters.targetType) query.targetType = filters.targetType;
  if (filters.from || filters.to) {
    query.timestamp = {};
    if (filters.from) query.timestamp.$gte = new Date(filters.from);
    if (filters.to) query.timestamp.$lte = new Date(filters.to);
  }

  const skip = (page - 1) * limit;
  const total = await ActivityLog.countDocuments(query);
  const logs = await ActivityLog.find(query)
    .sort({ timestamp: -1 })
    .skip(skip)
    .limit(limit)
    .populate('actorId', 'name role');

  return { logs, total, page, limit, pages: Math.ceil(total / limit) };
};

module.exports = { log, getLogs };
