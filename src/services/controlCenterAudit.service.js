// ── CONTROL CENTER: SECURITY & AUDIT ─────────────────────────────────────────
// The activity log has its own page for browsing. This is the superadmin's lens on it:
// the events that matter for security, a raw look at a single entry, and a full export.

const mongoose = require('mongoose');
const ActivityLog = require('../models/ActivityLog');
const { AppError } = require('../middleware/errorHandler.middleware');
const { LOG_ACTIONS } = require('../utils/constants');

const DAY_MS = 24 * 60 * 60 * 1000;

// Events a superadmin wants to read first. Order is roughly "most alarming first" for display.
const SECURITY_ACTIONS = [
  LOG_ACTIONS.FAILED_LOGIN,
  LOG_ACTIONS.ADMIN_ACCOUNT_LOCKED,
  LOG_ACTIONS.ADMIN_ACCOUNT_UNLOCKED,
  LOG_ACTIONS.ADMIN_PASSWORD_RESET,
  LOG_ACTIONS.ADMIN_ROLE_CHANGED,
  LOG_ACTIONS.ADMIN_CREATED,
  LOG_ACTIONS.USER_PERMISSIONS_UPDATED,
  LOG_ACTIONS.SYSTEM_BACKUP_RESTORED,
  LOG_ACTIONS.SYSTEM_BACKUP_DELETED,
  LOG_ACTIONS.PLATFORM_LOCKED,
  LOG_ACTIONS.PLATFORM_UNLOCKED,
  LOG_ACTIONS.CONTROL_SESSIONS_REVOKED,
  LOG_ACTIONS.CONTROL_SWITCH_CHANGED,
  LOG_ACTIONS.CONTROL_JOB_PAUSED,
  LOG_ACTIONS.CONTROL_JOB_RESUMED,
  LOG_ACTIONS.CONTROL_AUDIT_EXPORTED,
  LOG_ACTIONS.PAYMENT_MANUALLY_CONFIRMED,
  LOG_ACTIONS.PAYMENT_REFUNDED,
];

const clampDays = (days, fallback = 7) => {
  const n = Number(days);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 90) : fallback;
};

// Recent security events plus where failed sign-ins are coming from.
const getSecurityFeed = async ({ days, limit } = {}) => {
  const windowDays = clampDays(days);
  const since = new Date(Date.now() - windowDays * DAY_MS);
  const cap = Math.min(Math.max(Number(limit) || 40, 1), 200);

  const [events, byIp, byAccount, totals] = await Promise.all([
    ActivityLog.find({ action: { $in: SECURITY_ACTIONS }, timestamp: { $gte: since } })
      .sort({ timestamp: -1 }).limit(cap)
      .populate('actorId', 'name role')
      .populate('branchId', 'name')
      .lean(),
    ActivityLog.aggregate([
      { $match: { action: LOG_ACTIONS.FAILED_LOGIN, timestamp: { $gte: since }, ip: { $ne: null } } },
      { $group: { _id: '$ip', attempts: { $sum: 1 }, accounts: { $addToSet: '$actorId' }, lastAt: { $max: '$timestamp' } } },
      { $project: { ip: '$_id', attempts: 1, lastAt: 1, accounts: { $size: '$accounts' } } },
      { $sort: { attempts: -1 } },
      { $limit: 8 },
    ]),
    ActivityLog.aggregate([
      { $match: { action: LOG_ACTIONS.FAILED_LOGIN, timestamp: { $gte: since } } },
      { $group: { _id: '$actorId', attempts: { $sum: 1 }, lastAt: { $max: '$timestamp' } } },
      { $sort: { attempts: -1 } },
      { $limit: 8 },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
      { $project: { attempts: 1, lastAt: 1, name: { $arrayElemAt: ['$user.name', 0] }, role: { $arrayElemAt: ['$user.role', 0] } } },
    ]),
    ActivityLog.aggregate([
      { $match: { action: { $in: SECURITY_ACTIONS }, timestamp: { $gte: since } } },
      { $group: { _id: '$action', count: { $sum: 1 } } },
    ]),
  ]);

  return {
    days: windowDays,
    totals: Object.fromEntries(totals.map(t => [t._id, t.count])),
    events: events.map(e => ({
      id: e._id,
      action: e.action,
      timestamp: e.timestamp,
      actorName: e.actorId?.name || null,
      actorRole: e.actorRole,
      branchName: e.branchId?.name || null,
      ip: e.ip || null,
      targetType: e.targetType || null,
      detail: e.detail || {},
    })),
    failedLoginsByIp: byIp.map(r => ({ ip: r.ip, attempts: r.attempts, accounts: r.accounts, lastAt: r.lastAt })),
    failedLoginsByAccount: byAccount.map(r => ({ accountId: r._id, name: r.name || 'Unknown', role: r.role || null, attempts: r.attempts, lastAt: r.lastAt })),
  };
};

// One entry exactly as stored, with the actor resolved.
const getRawEntry = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new AppError('Invalid entry id', 400, 'INVALID_ID');
  const entry = await ActivityLog.findById(id)
    .populate('actorId', 'name role phone')
    .populate('branchId', 'name')
    .lean();
  if (!entry) throw new AppError('Entry not found', 404, 'ENTRY_NOT_FOUND');
  return entry;
};

// ── CSV EXPORT ────────────────────────────────────────────────────────────────
const EXPORT_COLUMNS = ['timestamp', 'action', 'actorName', 'actorRole', 'actorId', 'branch', 'targetType', 'targetId', 'ip', 'detail'];
const EXPORT_ROW_LIMIT = 100000;

// Cells that start with = + - @ (or a tab/CR) are read as formulas by Excel and Sheets.
// An attacker-controlled value in the log — a name, a phone field — must not become one.
const csvCell = (value) => {
  let text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

// Calls `write(chunk)` for the header and each row, so the controller can stream to the
// response instead of holding a large log in memory. Returns the row count.
const exportActivityCsv = async ({ from, to, action }, write) => {
  const query = {};
  if (from || to) {
    query.timestamp = {};
    if (from) {
      const d = new Date(from);
      if (Number.isNaN(d.getTime())) throw new AppError('"from" is not a valid date', 400, 'INVALID_DATE');
      query.timestamp.$gte = d;
    }
    if (to) {
      const d = new Date(to);
      if (Number.isNaN(d.getTime())) throw new AppError('"to" is not a valid date', 400, 'INVALID_DATE');
      query.timestamp.$lte = d;
    }
  }
  if (action) {
    if (!Object.values(LOG_ACTIONS).includes(action)) throw new AppError('Unknown action', 400, 'INVALID_ACTION');
    query.action = action;
  }

  write(`${EXPORT_COLUMNS.join(',')}\r\n`);
  let rows = 0;
  const cursor = ActivityLog.find(query)
    .sort({ timestamp: -1 }).limit(EXPORT_ROW_LIMIT)
    .populate('actorId', 'name').populate('branchId', 'name')
    .lean().cursor();

  for await (const e of cursor) {
    write(`${[
      e.timestamp ? new Date(e.timestamp).toISOString() : '',
      e.action,
      e.actorId?.name || '',
      e.actorRole,
      e.actorId?._id || '',
      e.branchId?.name || '',
      e.targetType || '',
      e.targetId || '',
      e.ip || '',
      e.detail || {},
    ].map(csvCell).join(',')}\r\n`);
    rows += 1;
  }
  return rows;
};

module.exports = { SECURITY_ACTIONS, getSecurityFeed, getRawEntry, exportActivityCsv, csvCell };
