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
const { LOG_ACTIONS, ORDER_STATUSES, ORDER_STATUS_TRANSITIONS } = require('../utils/constants');
const { paginate, buildPaginationMeta } = require('../utils/paginate');

let autoCancelLastRunAt = 0;
const AUTO_CANCEL_CHECK_INTERVAL_MS = 60 * 1000;

// ── VALIDATE STOCK AVAILABILITY ───────────────────────────────────────────────
// Called before order submission to prevent cart submission on out-of-stock (UX C1)
const validateOrderStock = async (orderItems) => {
  const errors = [];

  for (const item of orderItems) {
    const product = await Product.findOne(
      {
        _id: item.productId,
        isActive: true,
        'varieties.varietyName': item.variety
      }
    ).lean();

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
const buildOrderItems = async (cartItems) => {
  const items = [];
  let subtotal = 0;

  for (const item of cartItems) {
    const product = await Product.findById(item.productId).lean();
    if (!product) throw new AppError(`Product not found: ${item.productId}`, 404, 'PRODUCT_NOT_FOUND');

    const variety = product.varieties.find(v => v.varietyName === item.variety);
    const packaging = variety?.packaging.find(p => p.size === item.packaging);

    if (!packaging) throw new AppError(`Packaging ${item.variety} ${item.packaging} not found`, 404, 'PACKAGING_NOT_FOUND');

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

const autoCancelExpiredPendingOrders = async () => {
  const now = Date.now();
  if (now - autoCancelLastRunAt < AUTO_CANCEL_CHECK_INTERVAL_MS) return;
  autoCancelLastRunAt = now;

  const settings = await settingsService.getSettings();
  if (!settings.autoCancelHours || settings.autoCancelHours <= 0) return;

  const cutoff = new Date(now - (settings.autoCancelHours * 60 * 60 * 1000));
  const expiredOrders = await Order.find({
    status: ORDER_STATUSES.PENDING,
    createdAt: { $lte: cutoff }
  });

  for (const order of expiredOrders) {
    const actorId = order.userId || order.guestId;

    order.status = ORDER_STATUSES.CANCELLED;
    order.statusHistory.push({
      status: ORDER_STATUSES.CANCELLED,
      changedAt: new Date(),
      changedBy: actorId,
      note: `Auto-cancelled after ${settings.autoCancelHours} hour(s) in pending status`
    });

    await order.save();

    await activityLogService.log({
      actorId,
      actorRole: order.userId ? 'customer' : 'guest',
      action: LOG_ACTIONS.ORDER_CANCELLED,
      targetId: order._id,
      targetType: 'Order',
      detail: {
        orderRef: order.orderRef,
        automatic: true,
        reason: 'AUTO_CANCEL_EXPIRED_PENDING'
      }
    });
  }
};

// ── CREATE GUEST ORDER ────────────────────────────────────────────────────────
// SRS 5.2 + 5.5 - no login required
const createGuestOrder = async (orderData) => {
  await autoCancelExpiredPendingOrders();

  // Validate stock before submission
  const stockErrors = await validateOrderStock(orderData.orderItems);
  if (stockErrors.length > 0) {
    throw new AppError(stockErrors[0], 409, 'STOCK_INSUFFICIENT');
  }

  // Build items with price snapshots
  const { items, subtotal } = await buildOrderItems(orderData.orderItems);
  const settings = await settingsService.getSettings();
  assertShopCanAcceptOrders(settings);
  assertOrderMatchesSettings({
    settings,
    deliveryMethod: orderData.deliveryMethod,
    paymentMethod: orderData.paymentMethod,
    subtotal,
    isGuestOrder: true
  });

  // Find or create guest record
  let guest = await Guest.findOne({ phone: orderData.phone });
  if (!guest) {
    guest = await Guest.create({
      name: orderData.name,
      phone: orderData.phone,
      location: orderData.deliveryAddress || ''
    });
  }

  const orderRef = await generateOrderRef();
  const deliveryFee = getConfiguredDeliveryFee(settings, orderData.deliveryMethod);

  const order = await Order.create({
    orderRef,
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
    specialInstructions: orderData.specialInstructions || null,
    statusHistory: [{
      status: ORDER_STATUSES.PENDING,
      changedAt: new Date(),
      changedBy: guest._id, // use guestId as actor for guest orders
      note: 'Order placed'
    }]
  });

  // Link order to guest
  await Guest.findByIdAndUpdate(guest._id, { $push: { orders: order._id } });

  await activityLogService.log({
    actorId: guest._id,
    actorRole: 'guest',
    action: LOG_ACTIONS.ORDER_CREATED,
    targetId: order._id,
    targetType: 'Order',
    detail: { orderRef, total: order.total, itemCount: items.length }
  });

  return order;
};

// ── CREATE CUSTOMER ORDER ─────────────────────────────────────────────────────
// SRS 5.2 - registered customer order
const createCustomerOrder = async (orderData, userId) => {
  await autoCancelExpiredPendingOrders();

  const stockErrors = await validateOrderStock(orderData.orderItems);
  if (stockErrors.length > 0) {
    throw new AppError(stockErrors[0], 409, 'STOCK_INSUFFICIENT');
  }

  const user = await User.findById(userId);
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

  const { items, subtotal } = await buildOrderItems(orderData.orderItems);
  const settings = await settingsService.getSettings();
  assertShopCanAcceptOrders(settings);
  assertOrderMatchesSettings({
    settings,
    deliveryMethod: orderData.deliveryMethod,
    paymentMethod: orderData.paymentMethod,
    subtotal,
    isGuestOrder: false
  });
  const orderRef = await generateOrderRef();
  const deliveryFee = getConfiguredDeliveryFee(settings, orderData.deliveryMethod);

  const order = await Order.create({
    orderRef,
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
    specialInstructions: orderData.specialInstructions || null,
    statusHistory: [{
      status: ORDER_STATUSES.PENDING,
      changedAt: new Date(),
      changedBy: userId,
      note: 'Order placed'
    }]
  });

  // Link order to user history
  await User.findByIdAndUpdate(userId, { $push: { orderHistory: order._id } });

  await activityLogService.log({
    actorId: userId,
    actorRole: 'customer',
    action: LOG_ACTIONS.ORDER_CREATED,
    targetId: order._id,
    targetType: 'Order',
    detail: { orderRef, total: order.total, itemCount: items.length }
  });

  return order;
};

// ── GET SINGLE ORDER ──────────────────────────────────────────────────────────
const getById = async (orderId) => {
  await autoCancelExpiredPendingOrders();

  const order = await Order.findById(orderId)
    .populate('userId', 'name phone email')
    .populate('guestId', 'name phone location')
    .populate('paymentId')
    .lean();

  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  return order;
};

// ── GET ALL ORDERS (ADMIN) ────────────────────────────────────────────────────
// SRS 5.2 admin capabilities + SRS 5.9 filtering
const getAll = async (filters = {}, query = {}) => {
  await autoCancelExpiredPendingOrders();

  const { page, limit, skip } = paginate(query);
  const matchStage = {};

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
const getMyOrders = async (userId, query = {}) => {
  await autoCancelExpiredPendingOrders();

  const { page, limit, skip } = paginate(query);

  const [total, orders] = await Promise.all([
    Order.countDocuments({ userId }),
    Order.find({ userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
  ]);

  return { orders, pagination: buildPaginationMeta(page, limit, total) };
};

// ── TRACK BY REF (GUEST) ──────────────────────────────────────────────────────
// SRS 5.5 - public order tracking by phone + ref
const trackByRef = async (phone, orderRef) => {
  await autoCancelExpiredPendingOrders();

  // Find guest by phone
  const guest = await Guest.findOne({ phone });
  if (!guest) throw new AppError('No orders found for this phone number', 404, 'NOT_FOUND');

  const order = await Order.findOne({
    orderRef,
    guestId: guest._id
  }).lean();

  if (!order) throw new AppError('Order not found. Check your reference number.', 404, 'ORDER_NOT_FOUND');

  return order;
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
const approve = async (orderId, adminId) => {
  await autoCancelExpiredPendingOrders();

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');

    validateTransition(order.status, ORDER_STATUSES.APPROVED);

    // Re-check stock inside transaction (concurrent orders protection - UX C1)
    const stockWarnings = [];
    for (const item of order.orderItems) {
      const product = await Product.findOne(
        { _id: item.productId, 'varieties.varietyName': item.variety },
        { 'varieties.$': 1 },
        { session }
      );

      const packaging = product?.varieties[0]?.packaging.find(p => p.size === item.packaging);
      if (!packaging || packaging.stock < item.quantity) {
        stockWarnings.push({
          product: `${item.variety} ${item.packaging}`,
          available: packaging?.stock || 0,
          ordered: item.quantity
        });
      }
    }

    if (stockWarnings.length > 0) {
      await session.abortTransaction();
      throw new AppError(
        `Stock insufficient for: ${stockWarnings.map(w => `${w.product} (available: ${w.available}, ordered: ${w.ordered})`).join(', ')}`,
        409,
        'STOCK_INSUFFICIENT'
      );
    }

    // Deduct stock atomically for each item - SRS 5.4
    for (const item of order.orderItems) {
      await stockService.deductStock(
        item.productId, item.variety, item.packaging,
        item.quantity, order._id, adminId, session
      );
    }

    // Update order status
    order.status = ORDER_STATUSES.APPROVED;
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
const reject = async (orderId, adminId, reason) => {
  await autoCancelExpiredPendingOrders();

  if (!reason || reason.trim().length < 3) {
    throw new AppError('A rejection reason is required', 400, 'REASON_REQUIRED');
  }

  const order = await Order.findById(orderId);
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

  await order.save();

  await activityLogService.log({
    actorId: adminId,
    actorRole: 'supervisor',
    action: LOG_ACTIONS.ORDER_REJECTED,
    targetId: order._id,
    targetType: 'Order',
    detail: { orderRef: order.orderRef, reason }
  });

  return order;
};

// ── UPDATE STATUS ─────────────────────────────────────────────────────────────
// SRS 5.2 - staff+ moves order through the pipeline
const updateStatus = async (orderId, newStatus, adminId, note = null) => {
  await autoCancelExpiredPendingOrders();

  const order = await Order.findById(orderId);
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');

  validateTransition(order.status, newStatus);

  order.status = newStatus;
  order.statusHistory.push({
    status: newStatus,
    changedAt: new Date(),
    changedBy: adminId,
    note
  });

  await order.save();

  await activityLogService.log({
    actorId: adminId,
    actorRole: 'staff',
    action: LOG_ACTIONS.ORDER_STATUS_CHANGED,
    targetId: order._id,
    targetType: 'Order',
    detail: { orderRef: order.orderRef, newStatus, note }
  });

  return order;
};

// ── CANCEL ORDER ──────────────────────────────────────────────────────────────
// SRS 5.2 - customer can cancel only if still pending
const cancel = async (orderId, userId) => {
  await autoCancelExpiredPendingOrders();

  const order = await Order.findById(orderId);
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');

  // Customers can only cancel their own orders
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

  await order.save();

  await activityLogService.log({
    actorId: userId,
    actorRole: 'customer',
    action: LOG_ACTIONS.ORDER_CANCELLED,
    targetId: order._id,
    targetType: 'Order',
    detail: { orderRef: order.orderRef }
  });

  return order;
};

// ── BULK APPROVE ──────────────────────────────────────────────────────────────
// SRS 5.2 admin - approve multiple pending orders
const bulkApprove = async (orderIds, adminId) => {
  const results = { approved: [], failed: [] };

  for (const id of orderIds) {
    try {
      const order = await approve(id, adminId);
      results.approved.push(order.orderRef);
    } catch (err) {
      results.failed.push({ id, error: err.message });
    }
  }

  return results;
};

// ── BULK REJECT ───────────────────────────────────────────────────────────────
const bulkReject = async (orderIds, adminId, reason) => {
  if (!reason || reason.trim().length < 3) {
    throw new AppError('A rejection reason is required for bulk reject', 400, 'REASON_REQUIRED');
  }

  const results = { rejected: [], failed: [] };

  for (const id of orderIds) {
    try {
      const order = await reject(id, adminId, reason);
      results.rejected.push(order.orderRef);
    } catch (err) {
      results.failed.push({ id, error: err.message });
    }
  }

  return results;
};

// ── PACKING SLIP DATA ─────────────────────────────────────────────────────────
// SRS 5.2 - returns formatted data for print layout
const getPackingSlip = async (orderId) => {
  await autoCancelExpiredPendingOrders();

  const order = await Order.findById(orderId)
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
