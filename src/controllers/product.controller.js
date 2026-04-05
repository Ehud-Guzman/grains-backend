const productService = require('../services/product.service');
const Product = require('../models/Product');
const { getDefaultBranchId } = require('../services/defaultBranch.service');
const { success, paginated } = require('../utils/apiResponse');

// ── LIST ALL PRODUCTS (public) ────────────────────────────────────────────────
const getAll = async (req, res, next) => {
  try {
    const { page, limit, category, search, inStock, packagingSize, minPrice, maxPrice } = req.query;
    // Public shop scoped to default branch (or branchId query param for multi-shop support)
    const branchId = req.query.branchId || await getDefaultBranchId();
    const result = await productService.getAll(
      { category, search, inStock, packagingSize, minPrice, maxPrice },
      { page, limit },
      branchId
    );
    return paginated(res, result.products, result.pagination);
  } catch (err) { next(err); }
};

// ── GET SINGLE PRODUCT (public) ───────────────────────────────────────────────
const getById = async (req, res, next) => {
  try {
    const branchId = req.query.branchId || req.branchId || await getDefaultBranchId();
    const product = await productService.getById(req.params.id, branchId);
    return success(res, product);
  } catch (err) { next(err); }
};

// ── GET CATEGORIES (public) ───────────────────────────────────────────────────
const getCategories = async (req, res, next) => {
  try {
    const branchId = req.query.branchId || await getDefaultBranchId();
    const categories = await productService.getCategories(branchId);
    return success(res, categories);
  } catch (err) { next(err); }
};

// ── AUTOCOMPLETE SUGGESTIONS (public) ────────────────────────────────────────
const getSuggestions = async (req, res, next) => {
  try {
    const { q } = req.query;
    const branchId = req.query.branchId || await getDefaultBranchId();
    const suggestions = await productService.getSuggestions(q, branchId);
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
    const product = await productService.create(req.body, req.user.id, req.branchId);
    return success(res, product, 'Product created', 201);
  } catch (err) { next(err); }
};

// ── ADMIN: UPDATE PRODUCT ─────────────────────────────────────────────────────
const update = async (req, res, next) => {
  try {
    const product = await productService.update(req.params.id, req.body, req.user.id, req.branchId);
    return success(res, product, 'Product updated');
  } catch (err) { next(err); }
};

// ── ADMIN: TOGGLE ACTIVE ──────────────────────────────────────────────────────
const toggleActive = async (req, res, next) => {
  try {
    const product = await productService.toggleActive(req.params.id, req.user.id, req.branchId);
    return success(res, product, product.isActive ? 'Product activated' : 'Product deactivated');
  } catch (err) { next(err); }
};

// ── ADMIN: DUPLICATE PRODUCT ──────────────────────────────────────────────────
const duplicate = async (req, res, next) => {
  try {
    const product = await productService.duplicate(req.params.id, req.user.id, req.branchId);
    return success(res, product, 'Product duplicated', 201);
  } catch (err) { next(err); }
};

// ── ADMIN: DELETE PRODUCT ─────────────────────────────────────────────────────
const deleteProduct = async (req, res, next) => {
  try {
    await productService.deleteProduct(req.params.id, req.user.id, req.branchId);
    return success(res, null, 'Product deleted');
  } catch (err) { next(err); }
};

// ── ADMIN: ADD IMAGES TO PRODUCT ──────────────────────────────────────────────
const addImagesToProduct = async (productId, urls) => {
  if (!productId || !Array.isArray(urls) || urls.length === 0) {
    throw new Error('Invalid productId or image URLs');
  }
  const product = await Product.findByIdAndUpdate(
    productId,
    { $push: { imageURLs: { $each: urls } } },
    { new: true }
  );
  if (!product) throw new Error('Product not found');
  return product;
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
};
