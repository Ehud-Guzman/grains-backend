const mongoose = require('mongoose');
const User = require('../models/User');
const Guest = require('../models/Guest');
const Order = require('../models/Order');
const { AppError } = require('../middleware/errorHandler.middleware');
const activityLogService = require('./activityLog.service');
const { paginate, buildPaginationMeta } = require('../utils/paginate');

// ── GET ALL CUSTOMERS ─────────────────────────────────────────────────────────
// SRS 5.5 - unified view of registered accounts + guest records
const getAll = async (filters = {}, query = {}) => {
  const { page, limit, skip } = paginate(query);

  const matchStage = { role: 'customer' };

  if (filters.search) {
    const regex = { $regex: filters.search, $options: 'i' };
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

  // Enrich with order stats
  const enriched = await Promise.all(users.map(async (user) => {
    const stats = await getOrderStats(user._id);
    return { ...user, ...stats };
  }));

  return { customers: enriched, pagination: buildPaginationMeta(page, limit, total) };
};

// ── GET ORDER STATS FOR A USER ────────────────────────────────────────────────
const getOrderStats = async (userId) => {
  const stats = await Order.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(userId), status: 'completed' } },
    {
      $group: {
        _id: null,
        totalOrders: { $sum: 1 },
        totalSpend: { $sum: '$total' },
        avgOrderValue: { $avg: '$total' },
        firstOrderDate: { $min: '$createdAt' },
        lastOrderDate: { $max: '$createdAt' }
      }
    }
  ]);

  const s = stats[0] || {};
  const lastOrder = s.lastOrderDate;
  const daysSinceLastOrder = lastOrder
    ? Math.floor((Date.now() - new Date(lastOrder)) / (1000 * 60 * 60 * 24))
    : null;

  return {
    totalOrders: s.totalOrders || 0,
    totalSpend: s.totalSpend || 0,
    avgOrderValue: s.avgOrderValue ? Math.round(s.avgOrderValue) : 0,
    firstOrderDate: s.firstOrderDate || null,
    lastOrderDate: s.lastOrderDate || null,
    daysSinceLastOrder,
    // Segment badges - SRS 5.5 + UX B4
    isRepeat: (s.totalOrders || 0) >= 3,
    isInactive: daysSinceLastOrder !== null && daysSinceLastOrder >= 30
  };
};

// ── GET CUSTOMER PROFILE ──────────────────────────────────────────────────────
// SRS 5.5 - full profile with order history + lifetime stats
const getProfile = async (userId) => {
  const user = await User.findById(userId)
    .select('-passwordHash -failedLoginCount')
    .lean();

  if (!user) throw new AppError('Customer not found', 404, 'USER_NOT_FOUND');

  const stats = await getOrderStats(userId);

  // Recent orders
  const recentOrders = await Order.find({ userId })
    .sort({ createdAt: -1 })
    .limit(20)
    .select('orderRef status total createdAt paymentMethod deliveryMethod')
    .lean();

  return { ...user, ...stats, recentOrders };
};

// ── ADD INTERNAL NOTE ─────────────────────────────────────────────────────────
// SRS 5.5 - admin-only notes on customer profile, append-only
const addNote = async (userId, note, adminId) => {
  const user = await User.findById(userId);
  if (!user) throw new AppError('Customer not found', 404, 'USER_NOT_FOUND');

  // Append to existing notes with timestamp and author
  const timestamp = new Date().toISOString();
  const noteEntry = `[${timestamp}] ${note}`;
  user.notes = user.notes ? `${user.notes}\n${noteEntry}` : noteEntry;

  await user.save();

  await activityLogService.log({
    actorId: adminId,
    actorRole: 'supervisor',
    action: 'CUSTOMER_NOTE_ADDED',
    targetId: userId,
    targetType: 'User',
    detail: { note }
  });

  return { notes: user.notes };
};

// ── GET CUSTOMER SEGMENTS ─────────────────────────────────────────────────────
// SRS 5.5 + UX B4 - repeat (3+ orders), high value (top 10%), inactive (30+ days)
const getSegments = async () => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const stats = await Order.aggregate([
    { $match: { status: 'completed', userId: { $ne: null } } },
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

module.exports = { getAll, getProfile, addNote, getSegments, getOrderStats };
