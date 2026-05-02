const crypto = require('crypto');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Guest = require('../models/Guest');
const User = require('../models/User');
const Branch = require('../models/Branch');
const { AppError } = require('../middleware/errorHandler.middleware');
const activityLogService = require('./activityLog.service');
const notificationService = require('./notification.service');
const stockService = require('./stock.service');
const settingsService = require('./settings.service');
const generateOrderRef = require('../utils/generateOrderRef');
const haversine = require('../utils/haversine');
const {
  LOG_ACTIONS,
  ORDER_STATUSES,
  ORDER_STATUS_TRANSITIONS,
  STOCK_CHANGE_TYPES,
  STOCK_RESERVATION_STATUSES
} = require('../utils/constants');
const { paginate, buildPaginationMeta } = require('../utils/paginate');

const orderHasHeldStock = (order) => (
  [STOCK_RESERVATION_STATUSES.HELD, STOCK_RESERVATION_STATUSES.CONSUMED]
    .includes(order.stockReservationStatus || STOCK_RESERVATION_STATUSES.NONE)
);

// ── VALIDATE STOCK AVAILABILITY ───────────────────────────────────────────────
// Called before order submission to prevent cart submission on out-of-stock (UX C1)
const validateOrderStock = async (orderItems) => {
  const errors = [];

  // One query for all unique products instead of one query per item
  const productIds = [...new Set(orderItems.map(i => i.productId))];
  const products = await Product.find({ _id: { $in: productIds }, isActive: true }).lean();
  const productsMap = new Map(products.map(p => [p._id.toString(), p]));

  for (const item of orderItems) {
    const product = productsMap.get(item.productId?.toString());

    if (!product) {
      errors.push(`Product "${item.productName}" is no longer available`);
      continue;
    }

    const variety = product.varieties.find(v => v.varietyName === item.variety);
    const packaging = variety?.packaging.find(p => p.size === item.packaging);

    if (!packaging) {
      errors.push(`${item.variety} ${item.packaging} is no longer available`);
      continue;
    }

    if (packaging.quoteOnly) {
      errors.push(`${item.variety} ${item.packaging} requires a quote — it cannot be ordered online`);
      continue;
    }

    if (packaging.stock < item.quantity) {
      errors.push(
        `Insufficient stock for ${item.variety} ${item.packaging}. Available: ${packaging.stock}, Requested: ${item.quantity}`
      );
    }
  }

  return errors;
};

// ── BUILD ORDER ITEMS WITH PRICE SNAPSHOT ────────────────────────────────────
// Snapshot prices at time of order - SRS 7.4
const buildOrderItems = async (cartItems, options = {}) => {
  const { branchId = null, session = null } = options;
  const items = [];
  let subtotal = 0;

  // One query for all unique products instead of one query per item.
  // Deduplicating IDs handles carts with the same product in multiple varieties.
  const productIds = [...new Set(cartItems.map(i => i.productId))];
  const query = { _id: { $in: productIds }, isActive: true };
  if (branchId) query.branchId = branchId;

  const products = await Product.find(query, null, { session }).lean();
  const productsMap = new Map(products.map(p => [p._id.toString(), p]));

  for (const item of cartItems) {
    const product = productsMap.get(item.productId?.toString());
    if (!product) throw new AppError(`Product not found: ${item.productId}`, 404, 'PRODUCT_NOT_FOUND');

    const variety = product.varieties.find(v => v.varietyName === item.variety);
    const packaging = variety?.packaging.find(p => p.size === item.packaging);

    if (!packaging) throw new AppError(`Packaging ${item.variety} ${item.packaging} not found`, 404, 'PACKAGING_NOT_FOUND');
    if (packaging.quoteOnly) {
      throw new AppError(`${item.variety} ${item.packaging} requires a quote and cannot be ordered online`, 400, 'QUOTE_ONLY');
    }
    if (packaging.stock < item.quantity) {
      throw new AppError(
        `Insufficient stock for ${item.variety} ${item.packaging}. Available: ${packaging.stock}, Requested: ${item.quantity}`,
        409,
        'STOCK_INSUFFICIENT'
      );
    }

    const lineTotal = packaging.priceKES * item.quantity;
    subtotal += lineTotal;

    items.push({
      productId: product._id,
      productName: product.name, // snapshot
      variety: item.variety,
      packaging: item.packaging,
      quantity: item.quantity,
      unitPrice: packaging.priceKES, // snapshot at time of order
      lineTotal
    });
  }

  return { items, subtotal };
};

const reserveOrderStock = async (order, actorId, actorRole, session) => {
  for (const item of order.orderItems) {
    await stockService.deductStock(
      item.productId,
      item.variety,
      item.packaging,
      item.quantity,
      order._id,
      actorId,
      session,
      order.branchId,
      {
        changeType: STOCK_CHANGE_TYPES.ORDER_RESERVATION,
        reason: `Order ${order.orderRef} stock reserved at placement`
      }
    );
  }

  order.stockReservationStatus = STOCK_RESERVATION_STATUSES.HELD;
  order.stockReservedAt = new Date();
  order.stockReleasedAt = null;
  order.stockConsumedAt = null;
  order.statusHistory[0].note = 'Order placed and stock reserved';
  await order.save({ session });
};

const releaseOrderStock = async (order, actorId, session, note) => {
  if (!orderHasHeldStock(order)) return false;

  for (const item of order.orderItems) {
    await stockService.releaseStock(
      item.productId,
      item.variety,
      item.packaging,
      item.quantity,
      order._id,
      actorId,
      session,
      order.branchId
    );
  }

  order.stockReservationStatus = STOCK_RESERVATION_STATUSES.RELEASED;
  order.stockReleasedAt = new Date();
  if (note) {
    const historyEntry = order.statusHistory[order.statusHistory.length - 1];
    if (historyEntry) historyEntry.note = note;
  }

  return true;
};

const markOrderReservationConsumed = (order) => {
  order.stockReservationStatus = STOCK_RESERVATION_STATUSES.CONSUMED;
  if (!order.stockReservedAt) order.stockReservedAt = new Date();
  order.stockConsumedAt = new Date();
};

const assertShopCanAcceptOrders = (settings) => {
  if (settings.maintenanceMode) {
    throw new AppError(
      settings.maintenanceMessage || 'We are currently undergoing maintenance. Please check back soon.',
      503,
      'MAINTENANCE_MODE'
    );
  }
};

const assertOrderMatchesSettings = ({ settings, deliveryMethod, paymentMethod, subtotal, isGuestOrder }) => {
  if (isGuestOrder && !settings.allowGuestOrders) {
    throw new AppError('Guest checkout is currently disabled. Please sign in to continue.', 403, 'GUEST_ORDERS_DISABLED');
  }

  if (settings.minimumOrderValue > 0 && subtotal < settings.minimumOrderValue) {
    throw new AppError(
      `Minimum order value is KES ${settings.minimumOrderValue.toLocaleString()}.`,
      400,
      'MINIMUM_ORDER_NOT_MET'
    );
  }

  if (paymentMethod === 'mpesa' && !settings.allowMpesa) {
    throw new AppError('M-Pesa payments are currently unavailable.', 400, 'PAYMENT_METHOD_DISABLED');
  }

  if (paymentMethod === 'pickup') {
    if (!settings.allowPayOnPickup) {
      throw new AppError('Pay on pickup is currently unavailable.', 400, 'PAYMENT_METHOD_DISABLED');
    }
    if (deliveryMethod !== 'pickup') {
      throw new AppError('Pay on pickup is only available for pickup orders.', 400, 'INVALID_PAYMENT_METHOD');
    }
  }

  if (paymentMethod === 'delivery') {
    if (!settings.allowCashOnDelivery) {
      throw new AppError('Cash on delivery is currently unavailable.', 400, 'PAYMENT_METHOD_DISABLED');
    }
    if (deliveryMethod !== 'delivery') {
      throw new AppError('Pay on delivery is only available for delivery orders.', 400, 'INVALID_PAYMENT_METHOD');
    }
  }
};

/**
 * Calculate the delivery fee for an order.
 * - deliveryMethod !== 'delivery'  → fee 0, deliveryAvailable: true (N/A)
 * - mode 'flat'                    → settings.deliveryFee, deliveryAvailable: true
 * - mode 'distance'                → Haversine distance → closest band → band fee
 *   If branch has no coordinates or customer skipped geolocation → fall back to flat fee.
 *   If distance > settings.maxDeliveryKm → deliveryAvailable: false (pickup only)
 *
 * Returns { fee, distanceKm, zoneName, deliveryAvailable }
 */
const calculateDeliveryFee = (settings, deliveryMethod, customerCoords) => {
  if (deliveryMethod !== 'delivery') return { fee: 0, distanceKm: null, zoneName: null, deliveryAvailable: true };

  const flatFee = Number(settings.deliveryFee) || 0;

  if (
    settings.deliveryPricingMode === 'distance' &&
    settings.deliveryZones?.length > 0 &&
    settings.branchLat != null && settings.branchLng != null &&
    customerCoords?.lat != null && customerCoords?.lng != null
  ) {
    const distanceKm = haversine(
      settings.branchLat, settings.branchLng,
      customerCoords.lat, customerCoords.lng
    );

    // Block delivery beyond max radius if configured
    if (settings.maxDeliveryKm != null && distanceKm > settings.maxDeliveryKm) {
      return {
        fee:              0,
        distanceKm:       Math.round(distanceKm * 10) / 10,
        zoneName:         null,
        deliveryAvailable: false,
      };
    }

    // Sort ascending so cheaper bands are checked first.
    // Lower bound: inclusive only for the first band (minKm === 0), exclusive otherwise.
    // Upper bound: always inclusive — "up to X km" includes X km.
    // This means each boundary point belongs to exactly ONE band (the cheaper one).
    const sortedZones = [...settings.deliveryZones].sort((a, b) => (a.minKm ?? 0) - (b.minKm ?? 0));
    const band = sortedZones.find(z => {
      const min = z.minKm ?? 0;
      const max = z.maxKm ?? 9999;
      return (min === 0 ? distanceKm >= 0 : distanceKm > min) && distanceKm <= max;
    });

    return {
      fee:              band ? band.fee : flatFee,
      distanceKm:       Math.round(distanceKm * 10) / 10,
      zoneName:         band ? band.name : null,
      deliveryAvailable: true,
    };
  }

  return { fee: flatFee, distanceKm: null, zoneName: null, deliveryAvailable: true };
};

// Called by autoCancel.job.js every 5 minutes — do NOT call per-request;
// the per-instance module variable anti-pattern was removed (see audit M3).
const autoCancelExpiredPendingOrders = async (branchId) => {
  if (!branchId) return; // skip auto-cancel in global (no-branch) context

  const settings = await settingsService.getSettings(branchId);
  if (!settings.autoCancelHours || settings.autoCancelHours <= 0) return;

  const cutoff = new Date(Date.now() - (settings.autoCancelHours * 60 * 60 * 1000));
  const expiredOrders = await Order.find({
    branchId,
    status: ORDER_STATUSES.PENDING,
    createdAt: { $lte: cutoff }
  }).select('_id').lean();

  for (const { _id } of expiredOrders) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const order = await Order.findById(_id).session(session);
      if (!order || order.status !== ORDER_STATUSES.PENDING) {
        await session.commitTransaction();
        continue;
      }

      const actorId = order.userId || order.guestId;
      const note = `Auto-cancelled after ${settings.autoCancelHours} hour(s) in pending status`;

      order.status = ORDER_STATUSES.CANCELLED;
      order.statusHistory.push({
        status: ORDER_STATUSES.CANCELLED,
        changedAt: new Date(),
        changedBy: actorId,
        note
      });

      await releaseOrderStock(order, actorId, session, note);
      await order.save({ session });
      await session.commitTransaction();

      await activityLogService.log({
        actorId,
        actorRole: order.userId ? 'customer' : 'guest',
        action: LOG_ACTIONS.ORDER_CANCELLED,
        branchId: order.branchId,
        targetId: order._id,
        targetType: 'Order',
        detail: {
          orderRef: order.orderRef,
          automatic: true,
          reason: 'AUTO_CANCEL_EXPIRED_PENDING'
        }
      });
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  }
};

// ── CREATE GUEST ORDER ────────────────────────────────────────────────────────
// SRS 5.2 + 5.5 - no login required
const createGuestOrder = async (orderData, branchId) => {
  if (!branchId) throw new AppError('Branch context required to place an order', 400, 'BRANCH_REQUIRED');
  const branch = await Branch.findOne({ _id: branchId, isActive: true }).lean();
  if (!branch) throw new AppError('Branch not found or is currently unavailable', 404, 'BRANCH_NOT_FOUND');
  // Auto-cancel is handled by autoCancel.job.js — no per-request call needed
  const settings = await settingsService.getSettings(branchId);
  assertShopCanAcceptOrders(settings);

  const { items, subtotal } = await buildOrderItems(orderData.orderItems, { branchId });
  assertOrderMatchesSettings({
    settings,
    deliveryMethod: orderData.deliveryMethod,
    paymentMethod: orderData.paymentMethod,
    subtotal,
    isGuestOrder: true
  });

  const { fee: deliveryFee, distanceKm, zoneName, deliveryAvailable } = calculateDeliveryFee(
    settings, orderData.deliveryMethod, orderData.deliveryCoordinates
  );
  if (!deliveryAvailable) {
    throw new AppError(
      'Delivery is not available to your location. Please choose pickup instead.',
      400, 'DELIVERY_OUT_OF_RANGE'
    );
  }
  const vatEnabled = settings.vatEnabled === true;
  const vatRate    = vatEnabled ? (Number(settings.vatRate) || 0) : 0;
  const vatAmount  = vatEnabled ? Math.round(subtotal * vatRate) / 100 : 0;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    let guest = await Guest.findOne({ phone: orderData.phone }, null, { session });
    if (!guest) {
      [guest] = await Guest.create([{
        name: orderData.name,
        phone: orderData.phone,
        location: orderData.deliveryAddress || ''
      }], { session });
    }

    const orderRef = await generateOrderRef(branchId, session);

    // Generate one-time tracking token for the guest — returned to frontend, stored hashed
    const trackingToken = crypto.randomBytes(32).toString('hex');
    const trackingTokenHash = crypto.createHash('sha256').update(trackingToken).digest('hex');

    let [order] = await Order.create([{
      orderRef,
      branchId,
      guestId: guest._id,
      userId: null,
      orderItems: items,
      subtotal,
      deliveryFee,
      vatEnabled,
      vatRate,
      vatAmount,
      total: subtotal + deliveryFee + vatAmount,
      deliveryMethod: orderData.deliveryMethod,
      deliveryAddress: orderData.deliveryAddress || null,
      paymentMethod: orderData.paymentMethod,
      paymentStatus: 'pending',
      status: ORDER_STATUSES.PENDING,
      stockReservationStatus: STOCK_RESERVATION_STATUSES.NONE,
      specialInstructions: orderData.specialInstructions || null,
      trackingTokenHash,
      deliveryCoordinates: orderData.deliveryCoordinates?.lat
        ? { lat: orderData.deliveryCoordinates.lat, lng: orderData.deliveryCoordinates.lng }
        : { lat: null, lng: null },
      deliveryDistanceKm: distanceKm,
      statusHistory: [{
        status: ORDER_STATUSES.PENDING,
        changedAt: new Date(),
        changedBy: guest._id,
        note: zoneName ? `Order placed · delivery zone: ${zoneName} (${distanceKm} km)` : 'Order placed'
      }]
    }], { session });

    await reserveOrderStock(order, guest._id, 'guest', session);
    await Guest.findByIdAndUpdate(guest._id, { $push: { orders: order._id } }, { session });
    await session.commitTransaction();

    await activityLogService.log({
      actorId: guest._id,
      actorRole: 'guest',
      action: LOG_ACTIONS.ORDER_CREATED,
      branchId,
      targetId: order._id,
      targetType: 'Order',
      detail: { orderRef, total: order.total, itemCount: items.length, stockReserved: true }
    });

    notificationService.dispatchOrderPlaced(order, branchId).catch(err =>
      console.error('[notification] guest order placed:', err.message)
    );

    // Attach plain token to returned object — only time it is ever available in plaintext
    order = order.toObject();
    order.trackingToken = trackingToken;
    return order;
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

// ── CREATE CUSTOMER ORDER ─────────────────────────────────────────────────────
// SRS 5.2 - registered customer order
const createCustomerOrder = async (orderData, userId, branchId) => {
  if (!branchId) throw new AppError('Branch context required to place an order', 400, 'BRANCH_REQUIRED');
  const branch = await Branch.findOne({ _id: branchId, isActive: true }).lean();
  if (!branch) throw new AppError('Branch not found or is currently unavailable', 404, 'BRANCH_NOT_FOUND');
  // Auto-cancel is handled by autoCancel.job.js — no per-request call needed

  const user = await User.findById(userId);
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

  const settings = await settingsService.getSettings(branchId);
  const { items, subtotal } = await buildOrderItems(orderData.orderItems, { branchId });
  assertShopCanAcceptOrders(settings);
  assertOrderMatchesSettings({
    settings,
    deliveryMethod: orderData.deliveryMethod,
    paymentMethod: orderData.paymentMethod,
    subtotal,
    isGuestOrder: false
  });
  const { fee: deliveryFee, distanceKm, zoneName, deliveryAvailable } = calculateDeliveryFee(
    settings, orderData.deliveryMethod, orderData.deliveryCoordinates
  );
  if (!deliveryAvailable) {
    throw new AppError(
      'Delivery is not available to your location. Please choose pickup instead.',
      400, 'DELIVERY_OUT_OF_RANGE'
    );
  }
  const vatEnabled = settings.vatEnabled === true;
  const vatRate    = vatEnabled ? (Number(settings.vatRate) || 0) : 0;
  const vatAmount  = vatEnabled ? Math.round(subtotal * vatRate) / 100 : 0;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const orderRef = await generateOrderRef(branchId, session);
    let [order] = await Order.create([{
      orderRef,
      branchId,
      userId,
      guestId: null,
      orderItems: items,
      subtotal,
      deliveryFee,
      vatEnabled,
      vatRate,
      vatAmount,
      total: subtotal + deliveryFee + vatAmount,
      deliveryMethod: orderData.deliveryMethod,
      deliveryAddress: orderData.deliveryAddress || null,
      paymentMethod: orderData.paymentMethod,
      paymentStatus: 'pending',
      status: ORDER_STATUSES.PENDING,
      stockReservationStatus: STOCK_RESERVATION_STATUSES.NONE,
      specialInstructions: orderData.specialInstructions || null,
      deliveryCoordinates: orderData.deliveryCoordinates?.lat
        ? { lat: orderData.deliveryCoordinates.lat, lng: orderData.deliveryCoordinates.lng }
        : { lat: null, lng: null },
      deliveryDistanceKm: distanceKm,
      statusHistory: [{
        status: ORDER_STATUSES.PENDING,
        changedAt: new Date(),
        changedBy: userId,
        note: zoneName ? `Order placed · delivery zone: ${zoneName} (${distanceKm} km)` : 'Order placed'
      }]
    }], { session });

    await reserveOrderStock(order, userId, 'customer', session);
    await User.findByIdAndUpdate(userId, { $push: { orderHistory: order._id } }, { session });
    await session.commitTransaction();

    await activityLogService.log({
      actorId: userId,
      actorRole: 'customer',
      action: LOG_ACTIONS.ORDER_CREATED,
      branchId,
      targetId: order._id,
      targetType: 'Order',
      detail: { orderRef, total: order.total, itemCount: items.length, stockReserved: true }
    });

    notificationService.dispatchOrderPlaced(order, branchId).catch(err =>
      console.error('[notification] customer order placed:', err.message)
    );

    return order;
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

// ── GET SINGLE ORDER ──────────────────────────────────────────────────────────
const getById = async (orderId, branchId) => {
  // Auto-cancel is handled by autoCancel.job.js — no per-request call needed

  const query = { _id: orderId };
  if (branchId) query.branchId = branchId;

  const order = await Order.findOne(query)
    .populate('userId', 'name phone email')
    .populate('guestId', 'name phone location')
    .populate('paymentId')
    .lean();

  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  return order;
};

// ── GET ALL ORDERS (ADMIN) ────────────────────────────────────────────────────
// SRS 5.2 admin capabilities + SRS 5.9 filtering
const getAll = async (filters = {}, query = {}, branchId) => {
  // Auto-cancel is handled by autoCancel.job.js — no per-request call needed

  const { page, limit, skip } = paginate(query);
  const matchStage = {};

  if (branchId) matchStage.branchId = branchId;

  if (filters.status) {
    matchStage.status = Array.isArray(filters.status)
      ? { $in: filters.status }
      : filters.status;
  }

  if (filters.paymentMethod) matchStage.paymentMethod = filters.paymentMethod;
  if (filters.deliveryMethod) matchStage.deliveryMethod = filters.deliveryMethod;

  if (filters.from || filters.to) {
    matchStage.createdAt = {};
    if (filters.from) matchStage.createdAt.$gte = new Date(filters.from);
    if (filters.to) matchStage.createdAt.$lte = new Date(filters.to);
  }

  // Search by orderRef, customer name, or phone - SRS 5.9
  if (filters.search) {
    matchStage.$or = [
      { orderRef: { $regex: filters.search, $options: 'i' } }
    ];
  }

  const [total, orders] = await Promise.all([
    Order.countDocuments(matchStage),
    Order.find(matchStage)
      .populate('userId', 'name phone email')
      .populate('guestId', 'name phone')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
  ]);

  return { orders, pagination: buildPaginationMeta(page, limit, total) };
};

// ── GET MY ORDERS (CUSTOMER) ──────────────────────────────────────────────────
const getMyOrders = async (userId, query = {}, branchId) => {
  // Auto-cancel is handled by autoCancel.job.js — no per-request call needed

  const { page, limit, skip } = paginate(query);
  // Customers can see their orders across all branches (shared accounts)
  const filter = { userId };

  const CUSTOMER_ORDER_FIELDS = 'orderRef orderItems subtotal deliveryFee vatEnabled vatRate vatAmount total deliveryMethod deliveryAddress paymentMethod paymentStatus status rejectionReason specialInstructions branchId createdAt updatedAt statusHistory';

  const [total, orders] = await Promise.all([
    Order.countDocuments(filter),
    Order.find(filter)
      .select(CUSTOMER_ORDER_FIELDS)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
  ]);

  return { orders, pagination: buildPaginationMeta(page, limit, total) };
};

// ── TRACK BY REF (GUEST) ──────────────────────────────────────────────────────
// SRS 5.5 - public order tracking by phone + ref + verificationToken
const trackByRef = async (phone, orderRef, verificationToken) => {
  // Auto-cancel is handled by autoCancel.job.js — no per-request call needed

  if (!verificationToken) {
    throw new AppError('Verification token is required', 400, 'TOKEN_REQUIRED');
  }

  const guest = await Guest.findOne({ phone });
  if (!guest) throw new AppError('Order not found', 404, 'NOT_FOUND');

  // Include trackingTokenHash in this query (excluded from default projections via select:false)
  const order = await Order.findOne({ orderRef, guestId: guest._id })
    .select('+trackingTokenHash')
    .lean();

  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');

  // Constant-time comparison to prevent timing attacks
  const expectedHash = order.trackingTokenHash;
  const providedHash = crypto.createHash('sha256').update(verificationToken).digest('hex');
  const isValid = expectedHash && crypto.timingSafeEqual(
    Buffer.from(expectedHash, 'hex'),
    Buffer.from(providedHash, 'hex')
  );

  if (!isValid) {
    throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  }

  // Strip the hash before returning
  const { trackingTokenHash: _omit, ...safeOrder } = order;
  return safeOrder;
};

// ── VALIDATE STATUS TRANSITION ────────────────────────────────────────────────
// SRS 5.2 - only allowed transitions per the pipeline
const validateTransition = (currentStatus, newStatus) => {
  const allowed = ORDER_STATUS_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(newStatus)) {
    throw new AppError(
      `Cannot transition order from "${currentStatus}" to "${newStatus}"`,
      400,
      'INVALID_STATUS_TRANSITION'
    );
  }
};

// ── APPROVE ORDER ─────────────────────────────────────────────────────────────
// SRS 5.2 - supervisor+, deducts stock atomically inside MongoDB transaction
const approve = async (orderId, adminId, branchId, actorRole = 'supervisor') => {
  // Auto-cancel is handled by autoCancel.job.js — no per-request call needed

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const query = { _id: orderId };
    if (branchId) query.branchId = branchId;
    const order = await Order.findOne(query).session(session);
    if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');

    validateTransition(order.status, ORDER_STATUSES.APPROVED);

    if (order.stockReservationStatus === STOCK_RESERVATION_STATUSES.RELEASED) {
      throw new AppError('This order no longer has stock reserved. Ask the customer to reorder.', 409, 'STOCK_RESERVATION_RELEASED');
    }

    if (order.stockReservationStatus === STOCK_RESERVATION_STATUSES.NONE) {
      for (const item of order.orderItems) {
        await stockService.deductStock(
          item.productId,
          item.variety,
          item.packaging,
          item.quantity,
          order._id,
          adminId,
          session,
          order.branchId
        );
      }
    }

    // Update order status
    order.status = ORDER_STATUSES.APPROVED;
    markOrderReservationConsumed(order);
    order.statusHistory.push({
      status: ORDER_STATUSES.APPROVED,
      changedAt: new Date(),
      changedBy: adminId,
      note: null
    });

    await order.save({ session });
    await session.commitTransaction();

    await activityLogService.log({
      actorId: adminId,
      actorRole,
      action: LOG_ACTIONS.ORDER_APPROVED,
      branchId: order.branchId,
      targetId: order._id,
      targetType: 'Order',
      detail: { orderRef: order.orderRef }
    });

    notificationService.dispatchOrderApproved(order, order.branchId).catch(err =>
      console.error('[notification] order approved:', err.message)
    );

    return order;

  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

// ── REJECT ORDER ──────────────────────────────────────────────────────────────
// SRS 5.2 - reason is mandatory
const reject = async (orderId, adminId, reason, branchId, actorRole = 'supervisor') => {
  // Auto-cancel is handled by autoCancel.job.js — no per-request call needed

  if (!reason || reason.trim().length < 3) {
    throw new AppError('A rejection reason is required', 400, 'REASON_REQUIRED');
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const query = { _id: orderId };
    if (branchId) query.branchId = branchId;
    const order = await Order.findOne(query).session(session);
    if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');

    validateTransition(order.status, ORDER_STATUSES.REJECTED);

    order.status = ORDER_STATUSES.REJECTED;
    order.rejectionReason = reason;
    order.statusHistory.push({
      status: ORDER_STATUSES.REJECTED,
      changedAt: new Date(),
      changedBy: adminId,
      note: reason
    });

    await releaseOrderStock(order, adminId, session, reason);
    await order.save({ session });
    await session.commitTransaction();

    await activityLogService.log({
      actorId: adminId,
      actorRole,
      action: LOG_ACTIONS.ORDER_REJECTED,
      branchId: order.branchId,
      targetId: order._id,
      targetType: 'Order',
      detail: { orderRef: order.orderRef, reason, stockReleased: true }
    });

    notificationService.dispatchOrderRejected(order, order.branchId).catch(err =>
      console.error('[notification] order rejected:', err.message)
    );

    return order;
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

// ── UPDATE STATUS ─────────────────────────────────────────────────────────────
// SRS 5.2 - staff+ moves order through the pipeline
const updateStatus = async (orderId, newStatus, adminId, note = null, branchId, actorRole = 'staff') => {
  // Auto-cancel is handled by autoCancel.job.js — no per-request call needed
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const query = { _id: orderId };
    if (branchId) query.branchId = branchId;
    const order = await Order.findOne(query).session(session);
    if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');

    validateTransition(order.status, newStatus);

    order.status = newStatus;
    order.statusHistory.push({
      status: newStatus,
      changedAt: new Date(),
      changedBy: adminId,
      note
    });

    if (newStatus === ORDER_STATUSES.CANCELLED) {
      await releaseOrderStock(order, adminId, session, note || 'Cancelled by staff');
    }

    await order.save({ session });
    await session.commitTransaction();

    await activityLogService.log({
      actorId: adminId,
      actorRole,
      action: LOG_ACTIONS.ORDER_STATUS_CHANGED,
      branchId: order.branchId,
      targetId: order._id,
      targetType: 'Order',
      detail: {
        orderRef: order.orderRef,
        newStatus,
        note,
        stockReleased: newStatus === ORDER_STATUSES.CANCELLED
      }
    });

    if (newStatus === ORDER_STATUSES.OUT_FOR_DELIVERY) {
      notificationService.dispatchOrderDispatched(order, order.branchId).catch(err =>
        console.error('[notification] order dispatched:', err.message)
      );
    }

    return order;
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

// ── CANCEL ORDER ──────────────────────────────────────────────────────────────
// SRS 5.2 - customer can cancel only if still pending
const cancel = async (orderId, userId, branchId) => {
  // Auto-cancel is handled by autoCancel.job.js — no per-request call needed
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');

    if (order.userId && order.userId.toString() !== userId.toString()) {
      throw new AppError('You can only cancel your own orders', 403, 'FORBIDDEN');
    }

    validateTransition(order.status, ORDER_STATUSES.CANCELLED);

    order.status = ORDER_STATUSES.CANCELLED;
    order.statusHistory.push({
      status: ORDER_STATUSES.CANCELLED,
      changedAt: new Date(),
      changedBy: userId,
      note: 'Cancelled by customer'
    });

    await releaseOrderStock(order, userId, session, 'Cancelled by customer');
    await order.save({ session });
    await session.commitTransaction();

    await activityLogService.log({
      actorId: userId,
      actorRole: 'customer',
      action: LOG_ACTIONS.ORDER_CANCELLED,
      branchId: order.branchId,
      targetId: order._id,
      targetType: 'Order',
      detail: { orderRef: order.orderRef, stockReleased: true }
    });

    return order;
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

// ── BULK APPROVE ──────────────────────────────────────────────────────────────
// SRS 5.2 admin - approve multiple pending orders
const bulkApprove = async (orderIds, adminId, branchId, actorRole = 'supervisor') => {
  const results = { approved: [], failed: [] };

  for (const id of orderIds) {
    try {
      const order = await approve(id, adminId, branchId, actorRole);
      results.approved.push(order.orderRef);
    } catch (err) {
      results.failed.push({ id, error: err.message });
    }
  }

  return results;
};

// ── BULK REJECT ───────────────────────────────────────────────────────────────
const bulkReject = async (orderIds, adminId, reason, branchId, actorRole = 'supervisor') => {
  if (!reason || reason.trim().length < 3) {
    throw new AppError('A rejection reason is required for bulk reject', 400, 'REASON_REQUIRED');
  }

  const results = { rejected: [], failed: [] };

  for (const id of orderIds) {
    try {
      const order = await reject(id, adminId, reason, branchId, actorRole);
      results.rejected.push(order.orderRef);
    } catch (err) {
      results.failed.push({ id, error: err.message });
    }
  }

  return results;
};

// ── PACKING SLIP DATA ─────────────────────────────────────────────────────────
// SRS 5.2 - returns formatted data for print layout
const getPackingSlip = async (orderId, branchId) => {
  // Auto-cancel is handled by autoCancel.job.js — no per-request call needed

  const query = { _id: orderId };
  if (branchId) query.branchId = branchId;
  const order = await Order.findOne(query)
    .populate('userId', 'name phone email addresses')
    .populate('guestId', 'name phone location')
    .lean();

  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');

  const customer = order.userId || order.guestId;

  return {
    orderRef: order.orderRef,
    date: order.createdAt,
    customer: {
      name: customer?.name,
      phone: customer?.phone,
      address: order.deliveryAddress || customer?.location || 'Pickup'
    },
    deliveryMethod: order.deliveryMethod,
    items: order.orderItems,
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    total: order.total,
    specialInstructions: order.specialInstructions,
    paymentMethod: order.paymentMethod
  };
};

// ── ASSIGN DRIVER TO ORDER ────────────────────────────────────────────────────
// Admin assigns a driver when order is preparing or out_for_delivery.
// Automatically transitions preparing → out_for_delivery on first assignment.
const assignDriver = async (orderId, driverId, adminId, branchId, actorRole = 'admin') => {
  const User = require('../models/User');
  const { ROLES } = require('../utils/constants');

  const order = await Order.findOne({ _id: orderId, branchId });
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');

  if (order.deliveryMethod !== 'delivery') {
    throw new AppError('Cannot assign a driver to a pickup order', 400, 'NOT_DELIVERY_ORDER');
  }

  const allowed = [ORDER_STATUSES.PREPARING, ORDER_STATUSES.OUT_FOR_DELIVERY];
  if (!allowed.includes(order.status)) {
    throw new AppError(`Driver can only be assigned when order is preparing or out for delivery`, 400, 'INVALID_ORDER_STATUS');
  }

  // Verify driver belongs to this branch
  const driver = await User.findOne({ _id: driverId, role: ROLES.DRIVER, branchId });
  if (!driver) throw new AppError('Driver not found in this branch', 404, 'DRIVER_NOT_FOUND');

  order.driverId = driverId;

  // Auto-advance: preparing → out_for_delivery when driver is first assigned
  if (order.status === ORDER_STATUSES.PREPARING) {
    order.status = ORDER_STATUSES.OUT_FOR_DELIVERY;
    order.statusHistory.push({
      status: ORDER_STATUSES.OUT_FOR_DELIVERY,
      changedAt: new Date(),
      changedBy: adminId,
      note: `Driver ${driver.name} assigned`
    });
  }

  await order.save();

  await activityLogService.log({
    actorId: adminId,
    actorRole,
    action: LOG_ACTIONS.DRIVER_ASSIGNED_TO_ORDER,
    branchId,
    targetId: order._id,
    targetType: 'Order',
    detail: { orderRef: order.orderRef, driverId, driverName: driver.name }
  });

  // If the driver assignment auto-advanced the order to out_for_delivery, notify customer
  if (order.status === ORDER_STATUSES.OUT_FOR_DELIVERY) {
    notificationService.dispatchOrderDispatched(order, branchId).catch(err =>
      console.error('[notification] driver assigned dispatch:', err.message)
    );
  }

  return order;
};

module.exports = {
  createGuestOrder,
  createCustomerOrder,
  calculateDeliveryFee,
  getById,
  getAll,
  getMyOrders,
  trackByRef,
  approve,
  reject,
  updateStatus,
  cancel,
  bulkApprove,
  bulkReject,
  getPackingSlip,
  assignDriver,
  autoCancelExpiredPendingOrders,
};
