const mongoose = require('mongoose');
const User = require('../models/User');
const Guest = require('../models/Guest');
const Order = require('../models/Order');
const { AppError } = require('../middleware/errorHandler.middleware');
const activityLogService = require('./activityLog.service');
const { paginate, buildPaginationMeta } = require('../utils/paginate');
const { escapeRegex } = require('../utils/escapeRegex');

// ── GET ALL CUSTOMERS ─────────────────────────────────────────────────────────
// SRS 5.5 - unified view of registered accounts + guest records.
// Customers are shared across branches, but their ORDER data is branch-scoped:
// when branchId is present, stats/history only reflect the viewing admin's
// branch (superadmin without a branch keeps the global view).
const getAll = async (filters = {}, query = {}, branchId = null) => {
  const { page, limit, skip } = paginate(query);

  const matchStage = { role: 'customer' };

  if (filters.search) {
    const regex = { $regex: escapeRegex(filters.search), $options: 'i' };
    matchStage.$or = [
      { name: regex },
      { phone: regex },
      { email: regex }
    ];
  }

  const [total, users] = await Promise.all([
    User.countDocuments(matchStage),
    User.find(matchStage)
      .select('name phone email createdAt lastLoginAt orderHistory isLocked')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
  ]);

  // Enrich with order stats via one grouped aggregation across this page's users,
  // instead of one aggregate query per user (was 1+N round trips per page load).
  const userIds = users.map(u => u._id);
  const orderMatch = { userId: { $in: userIds }, status: 'completed' };
  if (branchId) orderMatch.branchId = new mongoose.Types.ObjectId(branchId);

  const statsRows = userIds.length > 0 ? await Order.aggregate([
    { $match: orderMatch },
    {
      $group: {
        _id: '$userId',
        totalOrders: { $sum: 1 },
        totalSpend: { $sum: '$total' },
        totalVat: { $sum: { $ifNull: ['$vatAmount', 0] } },
        avgOrderValue: { $avg: '$total' },
        firstOrderDate: { $min: '$createdAt' },
        lastOrderDate: { $max: '$createdAt' }
      }
    }
  ]) : [];

  const statsByUserId = new Map(statsRows.map(row => [String(row._id), row]));
  const enriched = users.map((user) => ({
    ...user,
    ...formatOrderStats(statsByUserId.get(String(user._id)))
  }));

  return { customers: enriched, pagination: buildPaginationMeta(page, limit, total) };
};

// ── FORMAT AGGREGATE STATS ROW ────────────────────────────────────────────────
// Shared shape between the single-user path (getOrderStats) and the batched
// per-page path (getAll) — same fields, same segment badges, same zero-defaults.
const formatOrderStats = (s = {}) => {
  const lastOrder = s.lastOrderDate;
  const daysSinceLastOrder = lastOrder
    ? Math.floor((Date.now() - new Date(lastOrder)) / (1000 * 60 * 60 * 24))
    : null;

  return {
    totalOrders: s.totalOrders || 0,
    totalSpend: s.totalSpend || 0,
    totalVat: s.totalVat || 0,
    avgOrderValue: s.avgOrderValue ? Math.round(s.avgOrderValue) : 0,
    firstOrderDate: s.firstOrderDate || null,
    lastOrderDate: s.lastOrderDate || null,
    daysSinceLastOrder,
    // Segment badges - SRS 5.5 + UX B4
    isRepeat: (s.totalOrders || 0) >= 3,
    isInactive: daysSinceLastOrder !== null && daysSinceLastOrder >= 30
  };
};

// ── GET ORDER STATS FOR A USER ────────────────────────────────────────────────
const getOrderStats = async (userId, branchId = null) => {
  const match = { userId: new mongoose.Types.ObjectId(userId), status: 'completed' };
  if (branchId) match.branchId = new mongoose.Types.ObjectId(branchId);

  const stats = await Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalOrders: { $sum: 1 },
        totalSpend: { $sum: '$total' },
        totalVat: { $sum: { $ifNull: ['$vatAmount', 0] } },
        avgOrderValue: { $avg: '$total' },
        firstOrderDate: { $min: '$createdAt' },
        lastOrderDate: { $max: '$createdAt' }
      }
    }
  ]);

  return formatOrderStats(stats[0]);
};

// ── GET CUSTOMER PROFILE ──────────────────────────────────────────────────────
// SRS 5.5 - full profile with order history + lifetime stats
const getProfile = async (userId, branchId = null) => {
  const user = await User.findOne({ _id: userId, role: 'customer' })
    .select('-passwordHash -failedLoginCount')
    .lean();

  if (!user) throw new AppError('Customer not found', 404, 'USER_NOT_FOUND');

  const stats = await getOrderStats(userId, branchId);

  // Recent orders — branch-scoped so one branch's admin never sees another
  // branch's order history through the shared customer record
  const orderQuery = { userId };
  if (branchId) orderQuery.branchId = branchId;
  const recentOrders = await Order.find(orderQuery)
    .sort({ createdAt: -1 })
    .limit(20)
    .select('orderRef status total createdAt paymentMethod deliveryMethod')
    .lean();

  return { ...user, ...stats, recentOrders };
};

// ── ADD INTERNAL NOTE ─────────────────────────────────────────────────────────
// SRS 5.5 - admin-only notes on customer profile, append-only
const addNote = async (userId, note, adminId, adminRole) => {
  const user = await User.findOne({ _id: userId, role: 'customer' });
  if (!user) throw new AppError('Customer not found', 404, 'USER_NOT_FOUND');

  // Append to existing notes with timestamp and author
  const timestamp = new Date().toISOString();
  const noteEntry = `[${timestamp}] ${note}`;
  user.notes = user.notes ? `${user.notes}\n${noteEntry}` : noteEntry;

  await user.save();

  await activityLogService.log({
    actorId: adminId,
    actorRole: adminRole,
    action: 'CUSTOMER_NOTE_ADDED',
    targetId: userId,
    targetType: 'User',
    detail: { note }
  });

  return { notes: user.notes };
};

// ── GET CUSTOMER SEGMENTS ─────────────────────────────────────────────────────
// SRS 5.5 + UX B4 - repeat (3+ orders), high value (top 10%), inactive (30+ days)
const getSegments = async (branchId = null) => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const match = { status: 'completed', userId: { $ne: null } };
  if (branchId) match.branchId = new mongoose.Types.ObjectId(branchId);

  const stats = await Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$userId',
        totalOrders: { $sum: 1 },
        totalSpend: { $sum: '$total' },
        lastOrderDate: { $max: '$createdAt' }
      }
    }
  ]);

  if (stats.length === 0) return { repeat: [], highValue: [], inactive: [] };

  // High value = top 10% by spend
  const sorted = [...stats].sort((a, b) => b.totalSpend - a.totalSpend);
  const top10Percent = Math.max(1, Math.ceil(sorted.length * 0.1));
  const highValueIds = sorted.slice(0, top10Percent).map(s => s._id);

  const repeat = stats.filter(s => s.totalOrders >= 3).map(s => s._id);
  const inactive = stats.filter(s => new Date(s.lastOrderDate) < thirtyDaysAgo).map(s => s._id);

  return {
    repeat: repeat.length,
    highValue: highValueIds.length,
    inactive: inactive.length,
    repeatIds: repeat,
    highValueIds,
    inactiveIds: inactive
  };
};

// ── LOCK / UNLOCK CUSTOMER ────────────────────────────────────────────────────
const lockCustomer = async (userId, adminId, adminRole) => {
  const user = await User.findOne({ _id: userId, role: 'customer' });
  if (!user) throw new AppError('Customer not found', 404, 'USER_NOT_FOUND');
  if (user.isLocked) throw new AppError('Account is already locked', 400, 'ALREADY_LOCKED');

  user.isLocked = true;
  await user.save();

  await activityLogService.log({
    actorId: adminId,
    actorRole: adminRole,
    action: 'CUSTOMER_ACCOUNT_LOCKED',
    targetId: userId,
    targetType: 'User',
    detail: { name: user.name, phone: user.phone, reason: 'Manual lock by admin' }
  });

  return { id: user._id, name: user.name, isLocked: true };
};

const unlockCustomer = async (userId, adminId, adminRole) => {
  const user = await User.findOneAndUpdate(
    { _id: userId, role: 'customer' },
    { isLocked: false, failedLoginCount: 0 },
    { new: true }
  );
  if (!user) throw new AppError('Customer not found', 404, 'USER_NOT_FOUND');

  await activityLogService.log({
    actorId: adminId,
    actorRole: adminRole,
    action: 'CUSTOMER_ACCOUNT_UNLOCKED',
    targetId: userId,
    targetType: 'User',
    detail: { name: user.name, phone: user.phone }
  });

  return { id: user._id, name: user.name, isLocked: false };
};

module.exports = { getAll, getProfile, addNote, getSegments, getOrderStats, lockCustomer, unlockCustomer };
