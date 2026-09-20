const mongoose = require('mongoose');
const Product = require('../models/Product');
const StockLog = require('../models/StockLog');
const { AppError } = require('../middleware/errorHandler.middleware');
const activityLogService = require('./activityLog.service');
const { LOG_ACTIONS, STOCK_CHANGE_TYPES } = require('../utils/constants');
const { appEvents, STOCK_EVENTS } = require('../events/appEvents');
const { validateReason } = require('../utils/validateReason');
const { paginate, buildPaginationMeta } = require('../utils/paginate');
const { invalidateCache } = require('./product.service');
const logger = require('../utils/logger');

// ── HELPER: write stock log entry ─────────────────────────────────────────────
const writeStockLog = async (
  { branchId, productId, varietyName, packagingSize, changeType, quantityChange, balanceAfter, reason, orderId, supplierId, performedBy, dedupeKey },
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
    timestamp: new Date(),
    // Spread conditionally — an explicit `undefined` would still be a key, and
    // the partial unique index keys off the field being absent.
    ...(dedupeKey ? { dedupeKey } : {})
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
  // NOTE: the outer filter must correlate varietyName + packaging.size + stock guard
  // on the SAME varieties array element via a single $elemMatch. Matching them as
  // independent top-level predicates would let a different variety's packaging (e.g.
  // another size sharing the same packagingSize string) satisfy the stock>=quantity
  // guard, allowing the real target to be decremented below zero.
  const product = await Product.findOneAndUpdate(
    {
      _id: productId,
      branchId,
      varieties: {
        $elemMatch: {
          varietyName,
          packaging: {
            $elemMatch: {
              size: packagingSize,
              stock: { $gte: quantity } // only update if enough stock - prevents oversell
            }
          }
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
      { _id: productId, branchId, 'varieties.varietyName': varietyName },
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
    logger.warn('[LOW STOCK] Threshold reached', {
      productName: product.name,
      varietyName,
      packagingSize,
      balanceAfter,
      threshold: packaging.lowStockThreshold
    });
  }

  return { product, balanceAfter };
};

// ── RELEASE STOCK ─────────────────────────────────────────────────────────────
const releaseStock = async (productId, varietyName, packagingSize, quantity, orderId, performedBy, session, branchId) => {
  const product = await Product.findOneAndUpdate(
    {
      _id: productId,
      branchId,
      varieties: {
        $elemMatch: {
          varietyName,
          packaging: { $elemMatch: { size: packagingSize } }
        }
      }
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
const addDelivery = async (productId, varietyName, packagingSize, quantity, reason, supplierId, performedBy, branchId, actorRole = 'supervisor', sourceIntakeId = null) => {
  if (quantity <= 0) throw new AppError('Quantity must be greater than 0', 400, 'INVALID_QUANTITY');

  // Idempotency guard: reject an exact-duplicate submission (double-click / network
  // retry resubmitting the same delivery) landing within a short window, since this
  // write has no client-supplied idempotency key.
  const DUPLICATE_WINDOW_MS = 15000;
  // Same fields as the query below, plus a 15-second time bucket. Enforced by the
  // unique partial index on StockLog.dedupeKey, because the read-then-write check
  // alone was a TOCTOU race: two concurrent identical submissions both saw no
  // duplicate and both applied, double-counting an entire truckload. The
  // pre-check below is kept only as a fast path that returns the same 409 without
  // depending on a duplicate-key error.
  const dedupeKey = [
    branchId, productId, varietyName, packagingSize,
    STOCK_CHANGE_TYPES.DELIVERY, quantity, performedBy,
    Math.floor(Date.now() / DUPLICATE_WINDOW_MS),
  ].join('|');
  const recentDuplicate = await StockLog.findOne({
    branchId,
    productId,
    varietyName,
    packagingSize,
    changeType: STOCK_CHANGE_TYPES.DELIVERY,
    quantityChange: quantity,
    performedBy,
    timestamp: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) }
  }).sort({ timestamp: -1 });

  if (recentDuplicate) {
    throw new AppError(
      'An identical delivery was just recorded — please wait before resubmitting',
      409,
      'DUPLICATE_SUBMISSION'
    );
  }

  // The stock increment, its StockLog row and the optional StockIntake link are
  // now ONE transaction. Previously the increment and the log were two
  // independent writes, so a crash or connection blip between them moved stock
  // with no audit row — an invisible movement that getLogs() and reconciliation
  // could never account for. deductStock/releaseStock already ran inside the
  // order transactions for exactly this reason; addDelivery did not take a
  // session at all.
  //
  // withTransaction() (rather than a hand-rolled start/commit/abort) because
  // MongoDB aborts one of two concurrent transactions that touch the same product
  // document with a WriteConflict, and the documented handling is to retry the
  // whole transaction. Without that retry:
  //   • a concurrent *identical* delivery reported the raw driver error instead of
  //     DUPLICATE_SUBMISSION, because the losing transaction never reached the
  //     unique-index check; and
  //   • a concurrent *different* delivery to the same product failed outright with
  //     an opaque error instead of simply applying.
  const session = await mongoose.startSession();

  let product, balanceAfter;
  try {
    await session.withTransaction(async () => {
      product = await Product.findOneAndUpdate(
        {
          _id: productId,
          branchId,
          varieties: {
            $elemMatch: {
              varietyName,
              packaging: { $elemMatch: { size: packagingSize } }
            }
          }
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

      if (!product) throw new AppError('Product, variety or packaging size not found', 404, 'PRODUCT_NOT_FOUND');

      const variety = product.varieties.find(v => v.varietyName === varietyName);
      const packaging = variety?.packaging.find(p => p.size === packagingSize);
      balanceAfter = packaging?.stock ?? 0;

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
        performedBy,
        dedupeKey
      }, session);

      // Optional audit-trail link back to the raw truck arrival this delivery packs out —
      // closes the reconciliation gap between StockIntake and actual sellable stock.
      if (sourceIntakeId) {
        const StockIntake = require('../models/StockIntake');
        await StockIntake.findOneAndUpdate(
          { _id: sourceIntakeId, branchId },
          { $push: { linkedDeliveries: { productId, varietyName, packagingSize, quantity, performedBy, appliedAt: new Date() } } },
          { session }
        );
      }
    });
  } catch (err) {
    // A concurrent identical submission won the race and its StockLog insert
    // landed first — the unique index rejected ours, so the increment above was
    // rolled back. Report it exactly like the pre-check does.
    if (err?.code === 11000 && String(err.message || '').includes('dedupeKey')) {
      throw new AppError(
        'An identical delivery was just recorded — please wait before resubmitting',
        409,
        'DUPLICATE_SUBMISSION'
      );
    }
    throw err;
  } finally {
    session.endSession();
  }

  await activityLogService.log({
    actorId: performedBy,
    actorRole,
    action: LOG_ACTIONS.STOCK_DELIVERY_ADDED,
    branchId,
    targetId: productId,
    targetType: 'Product',
    detail: { varietyName, packagingSize, quantity, balanceAfter, supplierId, sourceIntakeId: sourceIntakeId || undefined }
  });

  appEvents.emit(STOCK_EVENTS.UPDATED, {
    productId, branchId, varietyName, packaging: packagingSize, newStock: balanceAfter,
  });

  invalidateCache(branchId);
  return { product, balanceAfter };
};

// ── MANUAL ADJUSTMENT ─────────────────────────────────────────────────────────
// SRS 5.4 - supervisor+ manual correction, reason is mandatory
const manualAdjustment = async (productId, varietyName, packagingSize, newQuantity, reason, performedBy, branchId, actorRole = 'supervisor') => {
  validateReason(reason, 'A reason for manual stock adjustments');

  if (newQuantity < 0) throw new AppError('Stock quantity cannot be negative', 400, 'INVALID_QUANTITY');

  // Single atomic write. `new: false` returns the document as it stood
  // immediately BEFORE this update was applied, from the same operation — so the
  // "before" stock used for the log/audit trail can never be stale, unlike a
  // separate read-then-write where a concurrent adjustment landing in between
  // would make quantityChange/before describe a state that was never actually
  // current at write time.
  // Same one-transaction guarantee as addDelivery: the stock write and its
  // StockLog row commit together or not at all. Without this, a crash between
  // the two left stock changed with no audit row — and a manual adjustment is
  // precisely the write most likely to be questioned later.
  const session = await mongoose.startSession();

  let before, currentStock, quantityChange, product;
  try {
    // withTransaction() for the same reason as addDelivery — it retries on the
    // WriteConflict MongoDB raises when two transactions touch the same product
    // document concurrently, rather than failing the second one outright.
    await session.withTransaction(async () => {
      before = await Product.findOneAndUpdate(
        {
          _id: productId,
          branchId,
          varieties: {
            $elemMatch: {
              varietyName,
              packaging: { $elemMatch: { size: packagingSize } }
            }
          }
        },
        {
          $set: { 'varieties.$[v].packaging.$[p].stock': newQuantity }
        },
        {
          arrayFilters: [
            { 'v.varietyName': varietyName },
            { 'p.size': packagingSize }
          ],
          new: false,
          session
        }
      );

      if (!before) throw new AppError('Product, variety or packaging size not found', 404, 'PRODUCT_NOT_FOUND');

      const beforeVariety = before.varieties.find(v => v.varietyName === varietyName);
      const beforePackaging = beforeVariety?.packaging.find(p => p.size === packagingSize);
      currentStock = beforePackaging?.stock ?? 0;
      quantityChange = newQuantity - currentStock;

      // Build the "after" shape locally instead of a second DB round-trip — we
      // already know exactly what our own write changed (the single stock field
      // above); every other caller of this module returns { product, balanceAfter }
      // the same way after their own atomic write.
      product = before.toObject();
      const afterPackaging = product.varieties
        .find(v => v.varietyName === varietyName)?.packaging
        .find(p => p.size === packagingSize);
      if (afterPackaging) afterPackaging.stock = newQuantity;

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
      }, session);
    });
  } finally {
    session.endSession();
  }

  await activityLogService.log({
    actorId: performedBy,
    actorRole,
    action: LOG_ACTIONS.STOCK_MANUALLY_ADJUSTED,
    branchId,
    targetId: productId,
    targetType: 'Product',
    detail: { varietyName, packagingSize, before: currentStock, after: newQuantity, reason }
  });

  // Only emit if stock went from 0 → positive (triggers back-in-stock alerts)
  if (currentStock === 0 && newQuantity > 0) {
    appEvents.emit(STOCK_EVENTS.UPDATED, {
      productId, branchId, varietyName, packaging: packagingSize, newStock: newQuantity,
    });
  }

  invalidateCache(branchId);
  return { product, balanceAfter: newQuantity };
};

// ── BATCH UPDATE ──────────────────────────────────────────────────────────────
// SRS 5.1 - update multiple products from one screen after delivery
// Each entry runs independently (no shared transaction — addDelivery doesn't take
// a session) so a failure partway through must not be reported as a total failure:
// earlier entries already committed their stock + StockLog. Report exactly what
// succeeded and what didn't rather than throwing on the first error.
const batchUpdate = async (updates, performedBy, branchId) => {
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new AppError('Updates array is required', 400, 'INVALID_INPUT');
  }

  const succeeded = [];
  const failed = [];
  for (const u of updates) {
    try {
      const result = await addDelivery(
        u.productId, u.varietyName, u.packagingSize,
        u.quantity, u.reason, u.supplierId || null, performedBy, branchId,
        undefined, u.sourceIntakeId || null
      );
      succeeded.push({ productId: u.productId, varietyName: u.varietyName, packagingSize: u.packagingSize, ...result });
    } catch (err) {
      failed.push({
        productId: u.productId, varietyName: u.varietyName, packagingSize: u.packagingSize,
        message: err.message
      });
    }
  }

  if (succeeded.length === 0) {
    throw new AppError(
      failed.length === 1 ? failed[0].message : `All ${failed.length} stock entries failed`,
      409,
      'BATCH_UPDATE_FAILED'
    );
  }

  return { succeeded, failed };
};

// ── GET STOCK OVERVIEW ────────────────────────────────────────────────────────
// All products x varieties x sizes with current stock - SRS 5.4
const getOverview = async (filters = {}, branchId) => {
  const matchStage = {};
  if (branchId) matchStage.branchId = branchId;
  // Note: low-stock filtering happens in JS below, after flattening — $expr
  // cannot be scoped to elements of a nested array (varieties.packaging) at the
  // query level, so a Mongo-side pre-filter here would either match nothing or
  // throw ("$expr can only be applied to the top-level document").

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
