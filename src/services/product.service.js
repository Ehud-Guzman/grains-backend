const Product = require('../models/Product');
const Order = require('../models/Order');
const { AppError } = require('../middleware/errorHandler.middleware');
const activityLogService = require('./activityLog.service');
const { LOG_ACTIONS } = require('../utils/constants');
const { paginate, buildPaginationMeta } = require('../utils/paginate');

// ── CACHE ─────────────────────────────────────────────────────────────────────
// Simple in-memory cache for catalogue - invalidated on any product change
// Per SRS 6.1 and UX doc C3: frequently read data cached, invalidated on update
let _cache = null;
let _cacheTime = null;
const CACHE_TTL = 60 * 1000;

const invalidateCache = () => {
  _cache = null;
  _cacheTime = null;
};

// ── PUBLIC: GET ALL ACTIVE PRODUCTS ───────────────────────────────────────────
// SRS 5.1 customer capabilities + SRS 5.9 filtering
const getAll = async (filters = {}, query = {}) => {
  const { page, limit, skip } = paginate(query);
  const matchStage = { isActive: true };

  // Category filter - multiselect supported (UX A1)
  if (filters.category) {
    matchStage.category = Array.isArray(filters.category)
      ? { $in: filters.category }
      : filters.category;
  }

  // Full text search on name + description (SRS 5.9)
  if (filters.search) {
    matchStage.$text = { $search: filters.search };
  }

  // In-stock only toggle (UX A1)
  if (filters.inStock === 'true') {
    matchStage['varieties.packaging.stock'] = { $gt: 0 };
  }

  // Packaging size filter
  if (filters.packagingSize) {
    matchStage['varieties.packaging.size'] = Array.isArray(filters.packagingSize)
      ? { $in: filters.packagingSize }
      : filters.packagingSize;
  }

  // Price range filter - min/max KES (UX A1)
  if (filters.minPrice || filters.maxPrice) {
    const priceFilter = {};
    if (filters.minPrice) priceFilter.$gte = Number(filters.minPrice);
    if (filters.maxPrice) priceFilter.$lte = Number(filters.maxPrice);
    matchStage['varieties.packaging.priceKES'] = priceFilter;
  }

  const [total, products] = await Promise.all([
    Product.countDocuments(matchStage),
    Product.find(matchStage)
      .select('name category description imageURLs isActive varieties')
      .sort(filters.search ? { score: { $meta: 'textScore' } } : { createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean() // lean() for read performance - SRS 6.1
  ]);

  return { products, pagination: buildPaginationMeta(page, limit, total) };
};

// ── PUBLIC: GET SINGLE PRODUCT ────────────────────────────────────────────────
const getById = async (productId, includeInactive = false) => {
  const query = { _id: productId };
  if (!includeInactive) query.isActive = true;

  const product = await Product.findOne(query).lean();
  if (!product) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');

  return product;
};

// ── PUBLIC: GET CATEGORIES ────────────────────────────────────────────────────
// Cached - changes infrequently (UX C3)
const getCategories = async () => {
  const now = Date.now();
  if (_cache && _cacheTime && now - _cacheTime < CACHE_TTL) return _cache;

  const categories = await Product.distinct('category', { isActive: true });
  _cache = categories.sort();
  _cacheTime = now;
  return _cache;
};

// ── ADMIN: GET ALL PRODUCTS ───────────────────────────────────────────────────
// Includes inactive products, SRS 5.9 admin search
const getAllAdmin = async (filters = {}, query = {}) => {
  const { page, limit, skip } = paginate(query);
  const matchStage = {};

  if (filters.category) matchStage.category = filters.category;
  if (filters.isActive !== undefined) matchStage.isActive = filters.isActive === 'true';
  if (filters.search) matchStage.$text = { $search: filters.search };

  const [total, products] = await Promise.all([
    Product.countDocuments(matchStage),
    Product.find(matchStage)
      .populate('createdBy', 'name')
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
  ]);

  return { products, pagination: buildPaginationMeta(page, limit, total) };
};

// ── ADMIN: CREATE PRODUCT ─────────────────────────────────────────────────────
// SRS 5.1 - defaults to inactive draft unless explicitly activated
const create = async (data, adminId) => {
  const product = await Product.create({
    ...data,
    createdBy: adminId,
    isActive: data.isActive !== undefined ? data.isActive : false
  });

  await activityLogService.log({
    actorId: adminId,
    actorRole: 'admin',
    action: LOG_ACTIONS.PRODUCT_ADDED,
    targetId: product._id,
    targetType: 'Product',
    detail: { name: product.name, category: product.category }
  });

  invalidateCache();
  return product;
};

// ── ADMIN: UPDATE PRODUCT ─────────────────────────────────────────────────────
const update = async (productId, data, adminId) => {
  const product = await Product.findById(productId);
  if (!product) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');

  const before = { name: product.name, category: product.category, isActive: product.isActive };

  // Prevent overwriting createdBy
  delete data.createdBy;
  Object.assign(product, data);
  await product.save();

  await activityLogService.log({
    actorId: adminId,
    actorRole: 'admin',
    action: LOG_ACTIONS.PRODUCT_EDITED,
    targetId: product._id,
    targetType: 'Product',
    detail: { before, after: { name: product.name, category: product.category, isActive: product.isActive } }
  });

  invalidateCache();
  return product;
};

// ── ADMIN: TOGGLE ACTIVE ──────────────────────────────────────────────────────
// SRS 5.1 - inactive products hidden from catalogue, not deleted
const toggleActive = async (productId, adminId) => {
  const product = await Product.findById(productId);
  if (!product) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');

  product.isActive = !product.isActive;
  await product.save();

  await activityLogService.log({
    actorId: adminId,
    actorRole: 'admin',
    action: product.isActive ? LOG_ACTIONS.PRODUCT_ACTIVATED : LOG_ACTIONS.PRODUCT_DEACTIVATED,
    targetId: product._id,
    targetType: 'Product',
    detail: { name: product.name, isActive: product.isActive }
  });

  invalidateCache();
  return product;
};

// ── ADMIN: DELETE PRODUCT ─────────────────────────────────────────────────────
// SRS 5.1 - only allowed if no orders reference the product
const deleteProduct = async (productId, adminId) => {
  const product = await Product.findById(productId);
  if (!product) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');

  const orderCount = await Order.countDocuments({ 'orderItems.productId': productId });
  if (orderCount > 0) {
    throw new AppError(
      `Cannot delete — this product is referenced in ${orderCount} order(s). Deactivate it instead.`,
      409,
      'PRODUCT_HAS_ORDERS'
    );
  }

  await Product.findByIdAndDelete(productId);

  await activityLogService.log({
    actorId: adminId,
    actorRole: 'admin',
    action: LOG_ACTIONS.PRODUCT_DELETED,
    targetId: productId,
    targetType: 'Product',
    detail: { name: product.name, category: product.category }
  });

  invalidateCache();
  return { deleted: true };
};

// ── ADMIN: DUPLICATE PRODUCT ──────────────────────────────────────────────────
// SRS 5.1 - clones as inactive draft with all varieties + packaging
const duplicate = async (productId, adminId) => {
  const original = await Product.findById(productId).lean();
  if (!original) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');

  const { _id, createdAt, updatedAt, __v, ...productData } = original;

  const copy = await Product.create({
    ...productData,
    name: `${original.name} (Copy)`,
    isActive: false,
    createdBy: adminId
  });

  await activityLogService.log({
    actorId: adminId,
    actorRole: 'admin',
    action: LOG_ACTIONS.PRODUCT_ADDED,
    targetId: copy._id,
    targetType: 'Product',
    detail: { name: copy.name, duplicatedFrom: productId }
  });

  invalidateCache();
  return copy;
};

module.exports = {
  getAll,
  getById,
  getCategories,
  getAllAdmin,
  create,
  update,
  toggleActive,
  deleteProduct,
  duplicate,
  invalidateCache
};
