const productService = require('../services/product.service');
const { resolvePublicBranch } = require('../services/defaultBranch.service');
const priceLogService = require('../services/priceLog.service');
const { success, paginated } = require('../utils/apiResponse');

// ── LIST ALL PRODUCTS (public) ────────────────────────────────────────────────
const getAll = async (req, res, next) => {
  try {
    const { page, limit, category, search, inStock, packagingSize, minPrice, maxPrice } = req.query;
    // Public shop scoped to default branch (or branchId query param for multi-shop
    // support) — an invalid/inactive branchId falls back to default rather than
    // erroring or leaking a deactivated branch's catalog.
    const branch = await resolvePublicBranch(req.query.branchId);
    const result = await productService.getAll(
      { category, search, inStock, packagingSize, minPrice, maxPrice },
      { page, limit },
      branch?._id
    );
    return paginated(res, result.products, result.pagination);
  } catch (err) { next(err); }
};

// ── GET SINGLE PRODUCT (public) ───────────────────────────────────────────────
const getById = async (req, res, next) => {
  try {
    const branch = req.branchId ? { _id: req.branchId } : await resolvePublicBranch(req.query.branchId);
    // req.user is only set when an auth middleware (verifyToken/requireMinRole) ran before this
    const product = await productService.getById(req.params.id, branch?._id, false, !!req.user);
    return success(res, product);
  } catch (err) { next(err); }
};

// ── GET CATEGORIES (public) ───────────────────────────────────────────────────
const getCategories = async (req, res, next) => {
  try {
    const branch = await resolvePublicBranch(req.query.branchId);
    const categories = await productService.getCategories(branch?._id);
    return success(res, categories);
  } catch (err) { next(err); }
};

// ── AUTOCOMPLETE SUGGESTIONS (public) ────────────────────────────────────────
const getSuggestions = async (req, res, next) => {
  try {
    const { q } = req.query;
    const branch = await resolvePublicBranch(req.query.branchId);
    const suggestions = await productService.getSuggestions(q, branch?._id);
    return success(res, suggestions);
  } catch (err) { next(err); }
};

// ── ADMIN: LIST ALL PRODUCTS (includes inactive) ──────────────────────────────
const getAllAdmin = async (req, res, next) => {
  try {
    const { page, limit, category, search, isActive } = req.query;
    const result = await productService.getAllAdmin(
      { category, search, isActive },
      { page, limit },
      req.branchId
    );
    return paginated(res, result.products, result.pagination);
  } catch (err) { next(err); }
};

// ── ADMIN: CREATE PRODUCT ─────────────────────────────────────────────────────
const create = async (req, res, next) => {
  try {
    const product = await productService.create(req.body, req.user.id, req.branchId, req.user.role);
    return success(res, product, 'Product created', 201);
  } catch (err) { next(err); }
};

// ── ADMIN: UPDATE PRODUCT ─────────────────────────────────────────────────────
const update = async (req, res, next) => {
  try {
    const product = await productService.update(req.params.id, req.body, req.user.id, req.branchId, req.user.role);
    return success(res, product, 'Product updated');
  } catch (err) { next(err); }
};

// ── ADMIN: TOGGLE ACTIVE ──────────────────────────────────────────────────────
const toggleActive = async (req, res, next) => {
  try {
    const product = await productService.toggleActive(req.params.id, req.user.id, req.branchId, req.user.role);
    return success(res, product, product.isActive ? 'Product activated' : 'Product deactivated');
  } catch (err) { next(err); }
};

// ── ADMIN: DUPLICATE PRODUCT ──────────────────────────────────────────────────
const duplicate = async (req, res, next) => {
  try {
    const product = await productService.duplicate(req.params.id, req.user.id, req.branchId, req.user.role);
    return success(res, product, 'Product duplicated', 201);
  } catch (err) { next(err); }
};

// ── ADMIN: DELETE PRODUCT ─────────────────────────────────────────────────────
const deleteProduct = async (req, res, next) => {
  try {
    await productService.deleteProduct(req.params.id, req.user.id, req.branchId, req.user.role);
    return success(res, null, 'Product deleted');
  } catch (err) { next(err); }
};

// ── ADMIN: ADD IMAGES TO PRODUCT ──────────────────────────────────────────────
const addImagesToProduct = async (productId, urls, branchId) => {
  return productService.addImages(productId, urls, branchId);
};

// ── ADMIN: PRICE HISTORY (audit trail — branch-scoped, includes changedBy) ────
const getPriceHistoryAdmin = async (req, res, next) => {
  try {
    const history = await priceLogService.getHistoryAdmin(req.params.id, req.branchId);
    return success(res, history);
  } catch (err) { next(err); }
};

// ── PRICE HISTORY (public — for chart on product detail page) ─────────────────
const getPriceHistory = async (req, res, next) => {
  try {
    const { variety, packaging } = req.query;
    const history = await priceLogService.getHistory(req.params.id, { varietyName: variety, packaging });
    return success(res, history);
  } catch (err) { next(err); }
};

// ── BATCH PRICE CHANGES (public — for card badges on product lists) ───────────
const getPriceChanges = async (req, res, next) => {
  try {
    const ids = (req.query.ids || '').split(',').filter(Boolean);
    if (!ids.length) return success(res, {});
    const data = await priceLogService.getBatchPriceChanges(ids);
    return success(res, data);
  } catch (err) { next(err); }
};

// ── BEST-TIME-TO-BUY BADGE (public) ──────────────────────────────────────────
const getBestTimeBadge = async (req, res, next) => {
  try {
    const { variety, packaging, price } = req.query;
    const badge = await priceLogService.getBestTimeBadge(
      req.params.id, variety, packaging, Number(price)
    );
    return success(res, badge);
  } catch (err) { next(err); }
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
  duplicate,
  deleteProduct,
  addImagesToProduct,
  getPriceHistoryAdmin,
  getPriceHistory,
  getPriceChanges,
  getBestTimeBadge,
};
