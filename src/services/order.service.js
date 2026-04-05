const crypto = require('crypto');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Guest = require('../models/Guest');
const User = require('../models/User');
const { AppError } = require('../middleware/errorHandler.middleware');
const activityLogService = require('./activityLog.service');
const stockService = require('./stock.service');
const settingsService = require('./settings.service');
const generateOrderRef = require('../utils/generateOrderRef');
const {
  LOG_ACTIONS,
  ORDER_STATUSES,
  ORDER_STATUS_TRANSITIONS,
  STOCK_CHANGE_TYPES,
  STOCK_RESERVATION_STATUSES
} = require('../utils/constants');
const { paginate, buildPaginationMeta } = require('../utils/paginate');

let autoCancelLastRunAt = 0;
const AUTO_CANCEL_CHECK_INTERVAL_MS = 60 * 1000;

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
  order.statusHistory[0].note = actorRole === 'guest'
    ? 'Order placed and stock reserved'
    : 'Order placed and stock reserved';
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

const getConfiguredDeliveryFee = (settings, deliveryMethod) => (
  deliveryMethod === 'delivery' ? (Number(settings.deliveryFee) || 0) : 0
);

const autoCancelExpiredPendingOrders = async (branchId) => {
  const now = Date.now();
  if (now - autoCancelLastRunAt < AUTO_CANCEL_CHECK_INTERVAL_MS) return;
  autoCancelLastRunAt = now;

  if (!branchId) return; // skip auto-cancel in global (no-branch) context

  const settings = await settingsService.getSettings(branchId);
  if (!settings.autoCancelHours || settings.autoCancelHours <= 0) return;

  const cutoff = new Date(now - (settings.autoCancelHours * 60 * 60 * 1000));
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
  await autoCancelExpiredPendingOrders(branchId);
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

  const deliveryFee = getConfiguredDeliveryFee(settings, orderData.deliveryMethod);
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
      total: subtotal + deliveryFee,
      deliveryMethod: orderData.deliveryMethod,
      deliveryAddress: orderData.deliveryAddress || null,
      paymentMethod: orderData.paymentMethod,
      paymentStatus: 'pending',
      status: ORDER_STATUSES.PENDING,
      stockReservationStatus: STOCK_RESERVATION_STATUSES.NONE,
      specialInstructions: orderData.specialInstructions || null,
      trackingTokenHash,
      statusHistory: [{
        status: ORDER_STATUSES.PENDING,
        changedAt: new Date(),
        changedBy: guest._id,
        note: 'Order placed'
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
  await autoCancelExpiredPendingOrders(branchId);

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
  const deliveryFee = getConfiguredDeliveryFee(settings, orderData.deliveryMethod);
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
      total: subtotal + deliveryFee,
      deliveryMethod: orderData.deliveryMethod,
      deliveryAddress: orderData.deliveryAddress || null,
      paymentMethod: orderData.paymentMethod,
      paymentStatus: 'pending',
      status: ORDER_STATUSES.PENDING,
      stockReservationStatus: STOCK_RESERVATION_STATUSES.NONE,
      specialInstructions: orderData.specialInstructions || null,
      statusHistory: [{
        status: ORDER_STATUSES.PENDING,
        changedAt: new Date(),
        changedBy: userId,
        note: 'Order placed'
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
  await autoCancelExpiredPendingOrders(branchId);

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
  await autoCancelExpiredPendingOrders(branchId);

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
  await autoCancelExpiredPendingOrders(branchId);

  const { page, limit, skip } = paginate(query);
  // Customers can see their orders across all branches (shared accounts)
  const filter = { userId };

  const [total, orders] = await Promise.all([
    Order.countDocuments(filter),
    Order.find(filter)
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
  await autoCancelExpiredPendingOrders();

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
const approve = async (orderId, adminId, branchId) => {
  await autoCancelExpiredPendingOrders(branchId);

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
      actorRole: 'supervisor',
      action: LOG_ACTIONS.ORDER_APPROVED,
      branchId: order.branchId,
      targetId: order._id,
      targetType: 'Order',
      detail: { orderRef: order.orderRef }
    });

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
const reject = async (orderId, adminId, reason, branchId) => {
  await autoCancelExpiredPendingOrders(branchId);

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
      actorRole: 'supervisor',
      action: LOG_ACTIONS.ORDER_REJECTED,
      branchId: order.branchId,
      targetId: order._id,
      targetType: 'Order',
      detail: { orderRef: order.orderRef, reason, stockReleased: true }
    });

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
const updateStatus = async (orderId, newStatus, adminId, note = null, branchId) => {
  await autoCancelExpiredPendingOrders(branchId);
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
      actorRole: 'staff',
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
  await autoCancelExpiredPendingOrders(branchId);
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
const bulkApprove = async (orderIds, adminId, branchId) => {
  const results = { approved: [], failed: [] };

  for (const id of orderIds) {
    try {
      const order = await approve(id, adminId, branchId);
      results.approved.push(order.orderRef);
    } catch (err) {
      results.failed.push({ id, error: err.message });
    }
  }

  return results;
};

// ── BULK REJECT ───────────────────────────────────────────────────────────────
const bulkReject = async (orderIds, adminId, reason, branchId) => {
  if (!reason || reason.trim().length < 3) {
    throw new AppError('A rejection reason is required for bulk reject', 400, 'REASON_REQUIRED');
  }

  const results = { rejected: [], failed: [] };

  for (const id of orderIds) {
    try {
      const order = await reject(id, adminId, reason, branchId);
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
  await autoCancelExpiredPendingOrders(branchId);

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

module.exports = {
  createGuestOrder,
  createCustomerOrder,
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
  getPackingSlip
};
