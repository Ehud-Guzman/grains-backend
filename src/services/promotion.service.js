const Promotion = require('../models/Promotion');
const { AppError } = require('../middleware/errorHandler.middleware');

const now = () => new Date();

// ── PUBLIC: get active promotions ─────────────────────────────────────────────
const getActive = async (branchId) => {
  const n = now();
  return Promotion.find({
    branchId,
    isActive: true,
    $or: [
      { startDate: null },
      { startDate: { $lte: n } }
    ],
    $and: [
      {
        $or: [
          { endDate: null },
          { endDate: { $gte: n } }
        ]
      }
    ]
  })
    .populate('linkedProductId', 'name imageURLs varieties')
    .sort({ sortOrder: 1, createdAt: -1 })
    .lean();
};

// ── ADMIN CRUD ────────────────────────────────────────────────────────────────
const getAll = async (branchId) => {
  return Promotion.find({ branchId })
    .populate('linkedProductId', 'name')
    .populate('createdBy', 'name')
    .sort({ sortOrder: 1, createdAt: -1 })
    .lean();
};

const getById = async (id, branchId) => {
  const promo = await Promotion.findOne({ _id: id, branchId }).populate('linkedProductId', 'name').lean();
  if (!promo) throw new AppError('Promotion not found', 404, 'PROMO_NOT_FOUND');
  return promo;
};

// Whitelist client-settable fields — branchId/createdBy must never come from
// the request body (mass-assignment guard)
const pickPromotionFields = (data) => {
  const allowed = ['title', 'description', 'imageUrl', 'type', 'linkedProductId', 'startDate', 'endDate', 'isActive', 'seasonTag', 'sortOrder'];
  return Object.fromEntries(
    Object.entries(data || {}).filter(([key]) => allowed.includes(key))
  );
};

const create = async (data, branchId, actorId) => {
  return Promotion.create({ ...pickPromotionFields(data), branchId, createdBy: actorId });
};

const update = async (id, data, branchId) => {
  const promo = await Promotion.findOneAndUpdate(
    { _id: id, branchId },
    pickPromotionFields(data),
    { new: true, runValidators: true }
  );
  if (!promo) throw new AppError('Promotion not found', 404, 'PROMO_NOT_FOUND');
  return promo;
};

const remove = async (id, branchId) => {
  const promo = await Promotion.findOneAndDelete({ _id: id, branchId });
  if (!promo) throw new AppError('Promotion not found', 404, 'PROMO_NOT_FOUND');
};

module.exports = { getActive, getAll, getById, create, update, remove };
