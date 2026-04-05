const mongoose = require('mongoose');
const Product = require('../models/Product');
const StockLog = require('../models/StockLog');
const { AppError } = require('../middleware/errorHandler.middleware');
const activityLogService = require('./activityLog.service');
const { LOG_ACTIONS, STOCK_CHANGE_TYPES } = require('../utils/constants');
const { paginate, buildPaginationMeta } = require('../utils/paginate');
const { invalidateCache } = require('./product.service');

// ── HELPER: write stock log entry ─────────────────────────────────────────────
const writeStockLog = async (
  { branchId, productId, varietyName, packagingSize, changeType, quantityChange, balanceAfter, reason, orderId, supplierId, performedBy },
  session = null
) => {
  const logData = [{
    branchId,
    productId,
    varietyName,
    packagingSize,
    changeType,
    quantityChange,
    balanceAfter,
    reason,
    orderId: orderId || null,
    supplierId: supplierId || null,
    performedBy,
    timestamp: new Date()
  }];

  if (session) {
    await StockLog.create(logData, { session });
  } else {
    await StockLog.create(logData);
  }
};

// ── DEDUCT STOCK ──────────────────────────────────────────────────────────────
// SRS 5.4 - atomic, idempotent, runs inside MongoDB transaction
// Throws if stock would go below 0
const deductStock = async (
  productId,
  varietyName,
  packagingSize,
  quantity,
  orderId,
  performedBy,
  session,
  branchId,
  options = {}
) => {
  const changeType = options.changeType || STOCK_CHANGE_TYPES.ORDER_DEDUCTION;
  const reason = options.reason || `Order ${orderId} approved`;

  // findOneAndUpdate with $inc is atomic - prevents race conditions (SRS 5.4 + UX C1)
  const product = await Product.findOneAndUpdate(
    {
      _id: productId,
      'varieties.varietyName': varietyName,
      'varieties.packaging': {
        $elemMatch: {
          size: packagingSize,
          stock: { $gte: quantity } // only update if enough stock - prevents oversell
        }
      }
    },
    {
      $inc: { 'varieties.$[v].packaging.$[p].stock': -quantity }
    },
    {
      arrayFilters: [
        { 'v.varietyName': varietyName },
        { 'p.size': packagingSize }
      ],
      new: true,
      session
    }
  );

  // If null returned, either product not found or insufficient stock
  if (!product) {
    // Check if it's a stock issue or product issue
    const exists = await Product.findOne(
      { _id: productId, 'varieties.varietyName': varietyName },
      null,
      { session }
    );

    if (!exists) throw new AppError('Product or variety not found', 404, 'PRODUCT_NOT_FOUND');

    throw new AppError(
      `Insufficient stock for ${varietyName} ${packagingSize}`,
      409,
      'STOCK_INSUFFICIENT'
    );
  }

  // Get the updated balance for the log
  const variety = product.varieties.find(v => v.varietyName === varietyName);
  const packaging = variety?.packaging.find(p => p.size === packagingSize);
  const balanceAfter = packaging?.stock ?? 0;

  await writeStockLog({
    branchId,
    productId,
    varietyName,
    packagingSize,
    changeType,
    quantityChange: -quantity,
    balanceAfter,
    reason,
    orderId,
    performedBy
  }, session);

  // Check low stock threshold and flag if needed
  if (packaging && packaging.lowStockThreshold && balanceAfter <= packaging.lowStockThreshold) {
    console.warn(`[LOW STOCK] ${product.name} - ${varietyName} ${packagingSize}: ${balanceAfter} remaining (threshold: ${packaging.lowStockThreshold})`);
  }

  return { product, balanceAfter };
};

// ── RELEASE STOCK ─────────────────────────────────────────────────────────────
const releaseStock = async (productId, varietyName, packagingSize, quantity, orderId, performedBy, session, branchId) => {
  const product = await Product.findOneAndUpdate(
    {
      _id: productId,
      'varieties.varietyName': varietyName,
      'varieties.packaging.size': packagingSize
    },
    {
      $inc: { 'varieties.$[v].packaging.$[p].stock': quantity }
    },
    {
      arrayFilters: [
        { 'v.varietyName': varietyName },
        { 'p.size': packagingSize }
      ],
      new: true,
      session
    }
  );

  if (!product) {
    throw new AppError('Product, variety or packaging size not found', 404, 'PRODUCT_NOT_FOUND');
  }

  const variety = product.varieties.find(v => v.varietyName === varietyName);
  const packaging = variety?.packaging.find(p => p.size === packagingSize);
  const balanceAfter = packaging?.stock ?? 0;

  await writeStockLog({
    branchId,
    productId,
    varietyName,
    packagingSize,
    changeType: STOCK_CHANGE_TYPES.ORDER_RELEASE,
    quantityChange: quantity,
    balanceAfter,
    reason: `Order ${orderId} stock released`,
    orderId,
    performedBy
  }, session);

  return { product, balanceAfter };
};

// ── ADD DELIVERY ──────────────────────────────────────────────────────────────
// SRS 5.4 - supervisor+ adds new stock after a delivery
const addDelivery = async (productId, varietyName, packagingSize, quantity, reason, supplierId, performedBy, branchId) => {
  if (quantity <= 0) throw new AppError('Quantity must be greater than 0', 400, 'INVALID_QUANTITY');

  const product = await Product.findOneAndUpdate(
    {
      _id: productId,
      'varieties.varietyName': varietyName,
      'varieties.packaging.size': packagingSize
    },
    {
      $inc: { 'varieties.$[v].packaging.$[p].stock': quantity }
    },
    {
      arrayFilters: [
        { 'v.varietyName': varietyName },
        { 'p.size': packagingSize }
      ],
      new: true
    }
  );

  if (!product) throw new AppError('Product, variety or packaging size not found', 404, 'PRODUCT_NOT_FOUND');

  const variety = product.varieties.find(v => v.varietyName === varietyName);
  const packaging = variety?.packaging.find(p => p.size === packagingSize);
  const balanceAfter = packaging?.stock ?? 0;

  await writeStockLog({
    branchId,
    productId,
    varietyName,
    packagingSize,
    changeType: STOCK_CHANGE_TYPES.DELIVERY,
    quantityChange: quantity,
    balanceAfter,
    reason: reason || 'New delivery',
    supplierId,
    performedBy
  });

  await activityLogService.log({
    actorId: performedBy,
    actorRole: 'supervisor',
    action: LOG_ACTIONS.STOCK_DELIVERY_ADDED,
    branchId,
    targetId: productId,
    targetType: 'Product',
    detail: { varietyName, packagingSize, quantity, balanceAfter, supplierId }
  });

  invalidateCache();
  return { product, balanceAfter };
};

// ── MANUAL ADJUSTMENT ─────────────────────────────────────────────────────────
// SRS 5.4 - supervisor+ manual correction, reason is mandatory
const manualAdjustment = async (productId, varietyName, packagingSize, newQuantity, reason, performedBy, branchId) => {
  if (!reason || reason.trim().length < 3) {
    throw new AppError('A reason is required for manual stock adjustments', 400, 'REASON_REQUIRED');
  }

  if (newQuantity < 0) throw new AppError('Stock quantity cannot be negative', 400, 'INVALID_QUANTITY');

  // Get current stock first
  const current = await Product.findOne(
    { _id: productId, 'varieties.varietyName': varietyName },
    { 'varieties.$': 1 }
  );

  if (!current) throw new AppError('Product or variety not found', 404, 'PRODUCT_NOT_FOUND');

  const packaging = current.varieties[0]?.packaging.find(p => p.size === packagingSize);
  if (!packaging) throw new AppError('Packaging size not found', 404, 'PACKAGING_NOT_FOUND');

  const currentStock = packaging.stock;
  const quantityChange = newQuantity - currentStock;

  const product = await Product.findOneAndUpdate(
    {
      _id: productId,
      'varieties.varietyName': varietyName,
      'varieties.packaging.size': packagingSize
    },
    {
      $set: { 'varieties.$[v].packaging.$[p].stock': newQuantity }
    },
    {
      arrayFilters: [
        { 'v.varietyName': varietyName },
        { 'p.size': packagingSize }
      ],
      new: true
    }
  );

  await writeStockLog({
    branchId,
    productId,
    varietyName,
    packagingSize,
    changeType: STOCK_CHANGE_TYPES.MANUAL_ADJUSTMENT,
    quantityChange,
    balanceAfter: newQuantity,
    reason,
    performedBy
  });

  await activityLogService.log({
    actorId: performedBy,
    actorRole: 'supervisor',
    action: LOG_ACTIONS.STOCK_MANUALLY_ADJUSTED,
    branchId,
    targetId: productId,
    targetType: 'Product',
    detail: { varietyName, packagingSize, before: currentStock, after: newQuantity, reason }
  });

  invalidateCache();
  return { product, balanceAfter: newQuantity };
};

// ── BATCH UPDATE ──────────────────────────────────────────────────────────────
// SRS 5.1 - update multiple products from one screen after delivery
const batchUpdate = async (updates, performedBy, branchId) => {
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new AppError('Updates array is required', 400, 'INVALID_INPUT');
  }

  const results = [];
  for (const u of updates) {
    const result = await addDelivery(
      u.productId, u.varietyName, u.packagingSize,
      u.quantity, u.reason, u.supplierId || null, performedBy, branchId
    );
    results.push(result);
  }
  return results;
};

// ── GET STOCK OVERVIEW ────────────────────────────────────────────────────────
// All products x varieties x sizes with current stock - SRS 5.4
const getOverview = async (filters = {}, branchId) => {
  const matchStage = {};
  if (branchId) matchStage.branchId = branchId;
  if (filters.lowStock === 'true') {
    matchStage['varieties.packaging'] = {
      $elemMatch: { $expr: { $lte: ['$stock', '$lowStockThreshold'] } }
    };
  }

  const products = await Product.find(matchStage)
    .select('name category varieties isActive')
    .lean();

  // Flatten into a list of variety x packaging rows for the table view
  const rows = [];
  for (const product of products) {
    for (const variety of product.varieties) {
      for (const pkg of variety.packaging) {
        const isLow = pkg.stock <= pkg.lowStockThreshold;
        rows.push({
          productId: product._id,
          productName: product.name,
          category: product.category,
          isActive: product.isActive,
          varietyName: variety.varietyName,
          packagingSize: pkg.size,
          stock: pkg.stock,
          lowStockThreshold: pkg.lowStockThreshold,
          priceKES: pkg.priceKES,
          quoteOnly: pkg.quoteOnly,
          status: pkg.stock === 0 ? 'out_of_stock' : isLow ? 'low_stock' : 'in_stock'
        });
      }
    }
  }

if (filters.lowStock === 'true') {
  return rows.filter(r => r.status !== 'in_stock' && !r.quoteOnly);
}

  return rows;
};

// ── GET LOW STOCK ITEMS ───────────────────────────────────────────────────────
// SRS 5.4 - dashboard alert panel (UX B1)
const getLowStock = async (branchId) => {
  const rows = await getOverview({}, branchId);
  return rows.filter(r => r.status !== 'in_stock' && !r.quoteOnly);
};

// ── GET STOCK LOGS ────────────────────────────────────────────────────────────
// SRS 5.4 - movement history per product, paginated
const getLogs = async (productId, filters = {}, query = {}, branchId) => {
  const { page, limit, skip } = paginate(query);
  const matchStage = {};

  if (branchId) matchStage.branchId = branchId;
  if (productId) matchStage.productId = new mongoose.Types.ObjectId(productId);
  if (filters.varietyName) matchStage.varietyName = filters.varietyName;
  if (filters.packagingSize) matchStage.packagingSize = filters.packagingSize;
  if (filters.changeType) matchStage.changeType = filters.changeType;
  if (filters.performedBy) matchStage.performedBy = new mongoose.Types.ObjectId(filters.performedBy);

  if (filters.from || filters.to) {
    matchStage.timestamp = {};
    if (filters.from) matchStage.timestamp.$gte = new Date(filters.from);
    if (filters.to) matchStage.timestamp.$lte = new Date(filters.to);
  }

  const [total, logs] = await Promise.all([
    StockLog.countDocuments(matchStage),
    StockLog.find(matchStage)
      .populate('performedBy', 'name role')
      .populate('productId', 'name category')
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
  ]);

  return { logs, pagination: buildPaginationMeta(page, limit, total) };
};

module.exports = {
  deductStock,
  releaseStock,
  addDelivery,
  manualAdjustment,
  batchUpdate,
  getOverview,
  getLowStock,
  getLogs
};
