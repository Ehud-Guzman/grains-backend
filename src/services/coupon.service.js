const mongoose = require('mongoose');
const Coupon = require('../models/Coupon');
const Order = require('../models/Order');
const { AppError } = require('../middleware/errorHandler.middleware');
const { endOfDayEAT } = require('../utils/businessTime');

// ── VALIDATE & COMPUTE DISCOUNT ───────────────────────────────────────────────
// Returns { coupon, discountAmount } or throws AppError.
// subtotal is the pre-coupon, pre-delivery order subtotal.
const validate = async (code, branchId, userId, subtotal) => {
  const coupon = await Coupon.findOne({ code: code.toUpperCase().trim(), branchId }).lean();
  if (!coupon || !coupon.isActive) {
    throw new AppError('Coupon code is invalid or expired.', 400, 'COUPON_INVALID');
  }
  // The admin UI only collects a date (type="date", no time component), which
  // serializes to midnight UTC — comparing that instant directly against "now"
  // would expire the coupon 21 hours into what the admin intended as its last
  // valid day (00:00 UTC = 03:00 EAT). Treat expiresAt as valid through end of
  // that calendar day in Nairobi time instead.
  if (coupon.expiresAt && new Date() > endOfDayEAT(new Date(coupon.expiresAt))) {
    throw new AppError('This coupon has expired.', 400, 'COUPON_EXPIRED');
  }
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
    throw new AppError('This coupon has reached its usage limit.', 400, 'COUPON_EXHAUSTED');
  }
  if (coupon.assignedTo && coupon.assignedTo.toString() !== userId?.toString()) {
    throw new AppError('This coupon is not available for your account.', 403, 'COUPON_NOT_YOURS');
  }
  if (coupon.minOrderValue > 0 && subtotal < coupon.minOrderValue) {
    throw new AppError(
      `This coupon requires a minimum order of KES ${coupon.minOrderValue.toLocaleString()}.`,
      400, 'COUPON_MIN_NOT_MET'
    );
  }

  const discountAmount = coupon.discountType === 'percentage'
    ? Math.round(subtotal * Math.min(coupon.discountValue, 100) / 100)
    : Math.round(Math.min(coupon.discountValue, subtotal));

  return { coupon, discountAmount };
};

// ── INCREMENT USAGE ───────────────────────────────────────────────────────────
// Uses a conditional $inc so that if two concurrent orders both pass the usage
// check above, only the one that atomically finds usedCount still under the
// limit will succeed — the other will get a matched count of 0 and throw.
const incrementUsage = async (code, branchId, session) => {
  const opts = session ? { session } : {};
  const upper = code.toUpperCase().trim();

  const coupon = await Coupon.findOne({ code: upper, branchId }, 'usageLimit', opts).lean();
  if (!coupon) throw new AppError('Coupon not found during increment', 404, 'COUPON_NOT_FOUND');

  const filter = coupon.usageLimit !== null
    ? { code: upper, branchId, usedCount: { $lt: coupon.usageLimit } }
    : { code: upper, branchId };

  const result = await Coupon.updateOne(filter, { $inc: { usedCount: 1 } }, opts);

  if (result.matchedCount === 0) {
    throw new AppError('This coupon has reached its usage limit.', 400, 'COUPON_EXHAUSTED');
  }
};

// ── RELEASE USAGE ─────────────────────────────────────────────────────────────
// Called when an order that consumed a coupon is cancelled or rejected — gives
// the use back so a one-time coupon isn't burned by a sale that never happened.
// Safe by construction: cancelled/rejected are terminal statuses (validated by
// ORDER_STATUS_TRANSITIONS), so this runs at most once per order. The $gt: 0
// guard prevents a negative count, and a since-deleted coupon is a silent
// no-op — releasing must never block a cancellation.
const releaseUsage = async (code, branchId, session) => {
  const opts = session ? { session } : {};
  await Coupon.updateOne(
    { code: code.toUpperCase().trim(), branchId, usedCount: { $gt: 0 } },
    { $inc: { usedCount: -1 } },
    opts
  );
};

// ── ADMIN CRUD ────────────────────────────────────────────────────────────────
const getAll = async (branchId) => {
  return Coupon.find({ branchId })
    .populate('assignedTo', 'name phone')
    .populate('createdBy', 'name')
    .sort({ createdAt: -1 })
    .lean();
};

const getById = async (id, branchId) => {
  const coupon = await Coupon.findOne({ _id: id, branchId })
    .populate('assignedTo', 'name phone')
    .lean();
  if (!coupon) throw new AppError('Coupon not found', 404, 'COUPON_NOT_FOUND');
  return coupon;
};

// Whitelist client-settable fields — branchId/createdBy/usedCount must never
// come from the request body (mass-assignment guard)
const pickCouponFields = (data) => {
  const allowed = ['code', 'discountType', 'discountValue', 'minOrderValue', 'expiresAt', 'usageLimit', 'assignedTo', 'isActive'];
  return Object.fromEntries(
    Object.entries(data || {}).filter(([key]) => allowed.includes(key))
  );
};

const create = async (data, branchId, actorId) => {
  const fields = pickCouponFields(data);
  const existing = await Coupon.findOne({ code: fields.code.toUpperCase().trim(), branchId });
  if (existing) throw new AppError('A coupon with that code already exists.', 409, 'COUPON_DUPLICATE');
  return Coupon.create({ ...fields, code: fields.code.toUpperCase().trim(), branchId, createdBy: actorId });
};

const update = async (id, data, branchId) => {
  const fields = pickCouponFields(data);
  if (typeof fields.code === 'string') fields.code = fields.code.toUpperCase().trim();
  const coupon = await Coupon.findOneAndUpdate(
    { _id: id, branchId },
    fields,
    { new: true, runValidators: true }
  );
  if (!coupon) throw new AppError('Coupon not found', 404, 'COUPON_NOT_FOUND');
  return coupon;
};

const remove = async (id, branchId) => {
  const coupon = await Coupon.findOneAndDelete({ _id: id, branchId });
  if (!coupon) throw new AppError('Coupon not found', 404, 'COUPON_NOT_FOUND');
};

// ── PERFORMANCE ────────────────────────────────────────────────────────────────
// Redemption + revenue-impact stats per coupon, joined onto the coupon list.
// "Redemptions" only counts orders that actually generated revenue (excludes
// pending/rejected/cancelled) — usedCount on the Coupon doc is the raw counter
// used for enforcing usageLimit and can include since-cancelled orders.
const getPerformance = async (branchId) => {
  const REVENUE_STATUSES = ['approved', 'preparing', 'out_for_delivery', 'completed'];
  const branchFilter = branchId ? { branchId: new mongoose.Types.ObjectId(String(branchId)) } : {};

  const [coupons, stats] = await Promise.all([
    getAll(branchId),
    Order.aggregate([
      { $match: { ...branchFilter, status: { $in: REVENUE_STATUSES }, couponCode: { $ne: null } } },
      {
        $group: {
          _id: '$couponCode',
          redemptions: { $sum: 1 },
          totalDiscount: { $sum: { $ifNull: ['$couponDiscount', 0] } },
          totalRevenue: { $sum: '$total' },
        },
      },
    ]),
  ]);

  const statsMap = new Map(stats.map(s => [s._id, s]));

  return coupons.map(c => {
    const s = statsMap.get(c.code) || { redemptions: 0, totalDiscount: 0, totalRevenue: 0 };
    return {
      ...c,
      redemptions: s.redemptions,
      totalDiscount: s.totalDiscount,
      totalRevenue: s.totalRevenue,
      avgOrderValue: s.redemptions > 0 ? Math.round(s.totalRevenue / s.redemptions) : 0,
    };
  });
};

module.exports = { validate, incrementUsage, releaseUsage, getAll, getById, create, update, remove, getPerformance };
