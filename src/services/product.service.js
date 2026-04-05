const Product = require('../models/Product');
const Order = require('../models/Order');
const { AppError } = require('../middleware/errorHandler.middleware');
const activityLogService = require('./activityLog.service');
const { LOG_ACTIONS } = require('../utils/constants');
const { paginate, buildPaginationMeta } = require('../utils/paginate');
const { normalizeImageUrls } = require('../utils/imageUrl');
const { deleteImages } = require('./upload.service');

// ── CACHE ─────────────────────────────────────────────────────────────────────
// Per-branch cache: branchId => { data, time }
const _cache = new Map();
const CACHE_TTL = 60 * 1000;

const invalidateCache = (branchId) => {
  if (branchId) {
    _cache.delete(String(branchId));
  } else {
    _cache.clear();
  }
};

// ── PUBLIC: GET ALL ACTIVE PRODUCTS ───────────────────────────────────────────
const getAll = async (filters = {}, query = {}, branchId) => {
  const { page, limit, skip } = paginate(query);
  const matchStage = { isActive: true };

  if (branchId) matchStage.branchId = branchId;

  if (filters.category) {
    matchStage.category = Array.isArray(filters.category)
      ? { $in: filters.category }
      : filters.category;
  }

  if (filters.search) {
    matchStage.$text = { $search: filters.search };
  }

  if (filters.inStock === 'true') {
    matchStage['varieties.packaging.stock'] = { $gt: 0 };
  }

  if (filters.packagingSize) {
    matchStage['varieties.packaging.size'] = Array.isArray(filters.packagingSize)
      ? { $in: filters.packagingSize }
      : filters.packagingSize;
  }

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
      .lean()
  ]);

  return {
    products,
    pagination: buildPaginationMeta(page, limit, total)
  };
};

// ── PUBLIC: GET SINGLE PRODUCT ────────────────────────────────────────────────
const getById = async (productId, branchId, includeInactive = false) => {
  const query = { _id: productId };
  if (branchId) query.branchId = branchId;
  if (!includeInactive) query.isActive = true;

  const product = await Product.findOne(query).lean();
  if (!product) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');

  return product;
};

// ── PUBLIC: GET CATEGORIES ────────────────────────────────────────────────────
const getCategories = async (branchId) => {
  const key = String(branchId);
  const now = Date.now();
  const cached = _cache.get(key);
  if (cached && now - cached.time < CACHE_TTL) return cached.data;

  const filter = { isActive: true };
  if (branchId) filter.branchId = branchId;

  const categories = await Product.distinct('category', filter);
  const sorted = categories.sort();
  _cache.set(key, { data: sorted, time: now });
  return sorted;
};

// ── PUBLIC: AUTOCOMPLETE SUGGESTIONS ─────────────────────────────────────────
const getSuggestions = async (query, branchId) => {
  if (!query || query.trim().length < 2) return [];
  const filter = {
    isActive: true,
    name: { $regex: query.trim(), $options: 'i' }
  };
  if (branchId) filter.branchId = branchId;
  return Product.find(filter).select('name category').limit(8).lean();
};

// ── ADMIN: GET ALL PRODUCTS ───────────────────────────────────────────────────
const getAllAdmin = async (filters = {}, query = {}, branchId) => {
  const { page, limit, skip } = paginate(query);
  const matchStage = {};

  if (branchId) matchStage.branchId = branchId;
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

  return {
    products,
    pagination: buildPaginationMeta(page, limit, total)
  };
};

// ── ADMIN: CREATE PRODUCT ─────────────────────────────────────────────────────
const create = async (data, adminId, branchId) => {
  const product = await Product.create({
    ...data,
    imageURLs: normalizeImageUrls(data.imageURLs),
    varieties: (data.varieties || []).map(variety => ({
      ...variety,
      imageURLs: normalizeImageUrls(variety.imageURLs),
    })),
    branchId,
    createdBy: adminId,
    isActive: data.isActive !== undefined ? data.isActive : false
  });

  await activityLogService.log({
    actorId: adminId,
    actorRole: 'admin',
    action: LOG_ACTIONS.PRODUCT_ADDED,
    branchId,
    targetId: product._id,
    targetType: 'Product',
    detail: { name: product.name, category: product.category }
  });

  invalidateCache(branchId);
  return product;
};

// ── ADMIN: UPDATE PRODUCT ─────────────────────────────────────────────────────
const update = async (productId, data, adminId, branchId) => {
  const query = { _id: productId };
  if (branchId) query.branchId = branchId;

  const product = await Product.findOne(query);
  if (!product) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');

  const before = { name: product.name, category: product.category, isActive: product.isActive };

  // Collect all existing Cloudinary URLs before the update
  const oldProductImages = product.imageURLs || [];
  const oldVarietyImages = (product.varieties || []).flatMap(v => v.imageURLs || []);
  const allOldImages = [...oldProductImages, ...oldVarietyImages];

  delete data.createdBy;
  delete data.branchId; // cannot change branch of an existing product
  if (Array.isArray(data.imageURLs)) data.imageURLs = normalizeImageUrls(data.imageURLs);
  if (Array.isArray(data.varieties)) {
    data.varieties = data.varieties.map(variety => ({
      ...variety,
      imageURLs: normalizeImageUrls(variety.imageURLs),
    }));
  }
  Object.assign(product, data);
  product.markModified('imageURLs');
  product.markModified('varieties');
  await product.save();

  // Delete any Cloudinary images that were removed during this update
  const newProductImages = product.imageURLs || [];
  const newVarietyImages = (product.varieties || []).flatMap(v => v.imageURLs || []);
  const allNewImages = new Set([...newProductImages, ...newVarietyImages]);
  const removedImages = allOldImages.filter(url => url && !allNewImages.has(url));
  if (removedImages.length > 0) deleteImages(removedImages).catch(() => {});

  await activityLogService.log({
    actorId: adminId,
    actorRole: 'admin',
    action: LOG_ACTIONS.PRODUCT_EDITED,
    branchId,
    targetId: product._id,
    targetType: 'Product',
    detail: { before, after: { name: product.name, category: product.category, isActive: product.isActive } }
  });

  invalidateCache(branchId);
  return product;
};

// ── ADMIN: TOGGLE ACTIVE ──────────────────────────────────────────────────────
const toggleActive = async (productId, adminId, branchId) => {
  const query = { _id: productId };
  if (branchId) query.branchId = branchId;

  const product = await Product.findOne(query);
  if (!product) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');

  product.isActive = !product.isActive;
  await product.save();

  await activityLogService.log({
    actorId: adminId,
    actorRole: 'admin',
    action: product.isActive ? LOG_ACTIONS.PRODUCT_ACTIVATED : LOG_ACTIONS.PRODUCT_DEACTIVATED,
    branchId,
    targetId: product._id,
    targetType: 'Product',
    detail: { name: product.name, isActive: product.isActive }
  });

  invalidateCache(branchId);
  return product;
};

// ── ADMIN: DELETE PRODUCT ─────────────────────────────────────────────────────
const deleteProduct = async (productId, adminId, branchId) => {
  const query = { _id: productId };
  if (branchId) query.branchId = branchId;

  const product = await Product.findOne(query);
  if (!product) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');

  const orderCount = await Order.countDocuments({ 'orderItems.productId': productId, branchId });
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
    branchId,
    targetId: productId,
    targetType: 'Product',
    detail: { name: product.name, category: product.category }
  });

  invalidateCache(branchId);
  return { deleted: true };
};

// ── ADMIN: DUPLICATE PRODUCT ──────────────────────────────────────────────────
const duplicate = async (productId, adminId, branchId) => {
  const query = { _id: productId };
  if (branchId) query.branchId = branchId;

  const original = await Product.findOne(query).lean();
  if (!original) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');

  const { _id, createdAt, updatedAt, __v, ...productData } = original;

  const copy = await Product.create({
    ...productData,
    name: `${original.name} (Copy)`,
    isActive: false,
    createdBy: adminId,
    branchId
  });

  await activityLogService.log({
    actorId: adminId,
    actorRole: 'admin',
    action: LOG_ACTIONS.PRODUCT_ADDED,
    branchId,
    targetId: copy._id,
    targetType: 'Product',
    detail: { name: copy.name, duplicatedFrom: productId }
  });

  invalidateCache(branchId);
  return copy;
};

module.exports = {
  getAll,
  getById,
  getCategories,
  getSuggestions,
  getAllAdmin,
  create,
  update,
  toggleActive,
  deleteProduct,
  duplicate,
  invalidateCache
};
