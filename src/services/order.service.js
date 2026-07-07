const mongoose = require('mongoose');
const Order = require('../models/Order');
const Payment = require('../models/Payment');
const Product = require('../models/Product');
const Guest = require('../models/Guest');
const User = require('../models/User');
const Branch = require('../models/Branch');
const { AppError } = require('../middleware/errorHandler.middleware');
const activityLogService = require('./activityLog.service');
const stockService       = require('./stock.service');
const etimsService       = require('./etims.service');
const { appEvents, ORDER_EVENTS } = require('../events/appEvents');
const settingsService = require('./settings.service');
const logger = require('../utils/logger');
const generateOrderRef = require('../utils/generateOrderRef');
const haversine = require('../utils/haversine');
const {
  LOG_ACTIONS,
  ORDER_STATUSES,
  ORDER_STATUS_TRANSITIONS,
  STOCK_CHANGE_TYPES,
  STOCK_RESERVATION_STATUSES,
  PAYMENT_STATUSES,
  PAYMENT_METHODS,
  ROLES
} = require('../utils/constants');
const { formatPhone } = require('../utils/mpesaHelpers');
const { paginate, buildPaginationMeta } = require('../utils/paginate');
const { validateReason } = require('../utils/validateReason');
const couponService = require('./coupon.service');
const { startOfMonthEAT } = require('../utils/businessTime');

// Guards against float noise (e.g. 120.10 * 3 === 360.29999999999995) leaking into
// stored order totals and downstream CSV/eTIMS output — not a business-rounding
// rule, just IEEE-754 cleanup to the nearest cent.
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// A customer's preferred rider is informational only — admin still confirms the
// real assignment via assignDriver(). Silently drops anything that doesn't
// resolve to an available driver in this branch rather than failing the order.
const resolvePreferredDriver = async (preferredDriverId, branchId) => {
  if (!preferredDriverId || !mongoose.Types.ObjectId.isValid(preferredDriverId)) return null;
  const driver = await User.findOne({
    _id: preferredDriverId, role: ROLES.DRIVER, branchId, isLocked: false,
  }).select('_id').lean();
  return driver ? driver._id : null;
};

const orderHasHeldStock = (order) => (
  [STOCK_RESERVATION_STATUSES.HELD, STOCK_RESERVATION_STATUSES.CONSUMED]
    .includes(order.stockReservationStatus || STOCK_RESERVATION_STATUSES.NONE)
);

// ── BUILD ORDER ITEMS WITH PRICE SNAPSHOT ────────────────────────────────────
// Snapshot prices at time of order - SRS 7.4
const buildOrderItems = async (cartItems, options = {}) => {
  const { branchId = null, session = null } = options;
  const items = [];
  let subtotal = 0;
  let taxableSubtotal = 0;

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

    // Apply volume pricing tier if configured
    let unitPrice = packaging.priceKES;
    if (packaging.pricingTiers?.length > 0) {
      const sorted = [...packaging.pricingTiers].sort((a, b) => b.minQty - a.minQty);
      const tier = sorted.find(t => item.quantity >= t.minQty);
      if (tier) unitPrice = tier.priceKES;
    }
    const lineTotal = round2(unitPrice * item.quantity);
    subtotal += lineTotal;
    const taxable = product.taxable !== false;
    if (taxable) taxableSubtotal += lineTotal;

    items.push({
      productId: product._id,
      productName: product.name, // snapshot
      variety: item.variety,
      packaging: item.packaging,
      quantity: item.quantity,
      unitPrice, // snapshot at time of order (tier-adjusted)
      lineTotal,
      taxable
    });
  }

  return { items, subtotal: round2(subtotal), taxableSubtotal: round2(taxableSubtotal) };
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

      validateTransition(order.status, ORDER_STATUSES.CANCELLED);
      order.status = ORDER_STATUSES.CANCELLED;
      order.statusHistory.push({
        status: ORDER_STATUSES.CANCELLED,
        changedAt: new Date(),
        changedBy: actorId,
        note
      });

      await releaseOrderStock(order, actorId, session, note);
      if (order.couponCode) await couponService.releaseUsage(order.couponCode, order.branchId, session);
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
      // Don't let one order's failure (e.g. a write conflict with a concurrent
      // admin approve()) abort the rest of this cycle's batch — log and move on,
      // the next 5-minute run will pick this order back up if it's still eligible.
      logger.error('[autoCancel] Failed to auto-cancel order', { orderId: _id, err: err.message });
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

  const { items, subtotal, taxableSubtotal } = await buildOrderItems(orderData.orderItems, { branchId });
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
  // Coupon — computed before VAT so the net subtotal (post-discount) forms the VAT base
  let couponCode = null;
  let couponDiscount = 0;
  if (orderData.couponCode) {
    const { coupon, discountAmount } = await couponService.validate(
      orderData.couponCode, branchId, null, subtotal
    );
    couponCode = coupon.code;
    couponDiscount = discountAmount;
  }

  const vatEnabled = settings.vatEnabled === true;
  const vatRate    = vatEnabled ? (Number(settings.vatRate) || 0) : 0;
  // Coupon discount is shared proportionally between taxable and exempt value
  // so an exempt (e.g. by-product) line isn't taxed just because a discount was applied elsewhere.
  const discountShare = subtotal > 0 ? taxableSubtotal / subtotal : 0;
  const vatBase    = Math.max(0, taxableSubtotal - couponDiscount * discountShare);
  const vatAmount  = vatEnabled ? Math.round(vatBase * vatRate / 100) : 0;

  const preferredDriverId = await resolvePreferredDriver(orderData.preferredDriverId, branchId);

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
      couponCode,
      couponDiscount,
      total: round2(Math.max(0, subtotal + deliveryFee + vatAmount - couponDiscount)),
      deliveryMethod: orderData.deliveryMethod,
      deliveryAddress: orderData.deliveryAddress || null,
      paymentMethod: orderData.paymentMethod,
      paymentStatus: PAYMENT_STATUSES.UNPAID,
      status: ORDER_STATUSES.PENDING,
      stockReservationStatus: STOCK_RESERVATION_STATUSES.NONE,
      specialInstructions: orderData.specialInstructions || null,
      buyerKraPin: orderData.buyerKraPin?.trim() || null,
      preferredDriverId,
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
    if (couponCode) await couponService.incrementUsage(couponCode, branchId, session);
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

    appEvents.emit(ORDER_EVENTS.PLACED, { order, branchId });

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
  const { items, subtotal, taxableSubtotal } = await buildOrderItems(orderData.orderItems, { branchId });
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
  // Coupon — computed before VAT so the net subtotal (post-discount) forms the VAT base
  let couponCode = null;
  let couponDiscount = 0;
  if (orderData.couponCode) {
    const { coupon, discountAmount } = await couponService.validate(
      orderData.couponCode, branchId, userId, subtotal
    );
    couponCode = coupon.code;
    couponDiscount = discountAmount;
  }

  const vatEnabled = settings.vatEnabled === true;
  const vatRate    = vatEnabled ? (Number(settings.vatRate) || 0) : 0;
  // Coupon discount is shared proportionally between taxable and exempt value
  // so an exempt (e.g. by-product) line isn't taxed just because a discount was applied elsewhere.
  const discountShare = subtotal > 0 ? taxableSubtotal / subtotal : 0;
  const vatBase    = Math.max(0, taxableSubtotal - couponDiscount * discountShare);
  const vatAmount  = vatEnabled ? Math.round(vatBase * vatRate / 100) : 0;

  const preferredDriverId = await resolvePreferredDriver(orderData.preferredDriverId, branchId);

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
      couponCode,
      couponDiscount,
      total: round2(Math.max(0, subtotal + deliveryFee + vatAmount - couponDiscount)),
      deliveryMethod: orderData.deliveryMethod,
      deliveryAddress: orderData.deliveryAddress || null,
      paymentMethod: orderData.paymentMethod,
      paymentStatus: PAYMENT_STATUSES.UNPAID,
      status: ORDER_STATUSES.PENDING,
      stockReservationStatus: STOCK_RESERVATION_STATUSES.NONE,
      specialInstructions: orderData.specialInstructions || null,
      buyerKraPin: orderData.buyerKraPin?.trim() || null,
      preferredDriverId,
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
    if (couponCode) await couponService.incrementUsage(couponCode, branchId, session);
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

    appEvents.emit(ORDER_EVENTS.PLACED, { order, branchId });

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
    .populate('driverId', 'name vehicleInfo')
    .populate('preferredDriverId', 'name vehicleInfo')
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
const CUSTOMER_ORDER_FIELDS = 'orderRef orderItems subtotal deliveryFee vatEnabled vatRate vatAmount total deliveryMethod deliveryAddress paymentMethod paymentStatus status rejectionReason specialInstructions buyerKraPin branchId createdAt updatedAt statusHistory driverId preferredDriverId deliveredAt';

const getMyOrders = async (userId, query = {}, branchId) => {
  // Auto-cancel is handled by autoCancel.job.js — no per-request call needed

  const { page, limit, skip } = paginate(query);
  // Customers can see their orders across all branches (shared accounts)
  const filter = { userId };

  // Search by order reference — lets a repeat customer jump straight to an
  // old order instead of paging through their full history.
  if (query.search) {
    filter.orderRef = { $regex: query.search, $options: 'i' };
  }

  const [total, orders] = await Promise.all([
    Order.countDocuments(filter),
    Order.find(filter)
      .select(CUSTOMER_ORDER_FIELDS)
      .populate('driverId', 'name vehicleInfo')
      .populate('preferredDriverId', 'name vehicleInfo')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
  ]);

  return { orders, pagination: buildPaginationMeta(page, limit, total) };
};

// ── GET SINGLE ORDER (CUSTOMER) ───────────────────────────────────────────────
// Scoped to the requesting user — a customer can only fetch their own order.
const getMyOrderById = async (userId, orderId) => {
  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    throw new AppError('Order not found', 404, 'NOT_FOUND');
  }

  const order = await Order.findOne({ _id: orderId, userId })
    .select(CUSTOMER_ORDER_FIELDS)
    .populate('driverId', 'name vehicleInfo')
    .populate('preferredDriverId', 'name vehicleInfo')
    .lean();

  if (!order) throw new AppError('Order not found', 404, 'NOT_FOUND');
  return order;
};

// ── TRACK BY REF (GUEST) ──────────────────────────────────────────────────────
// SRS 5.5 - public order tracking by phone + ref
const trackByRef = async (phone, orderRef) => {
  // Auto-cancel is handled by autoCancel.job.js — no per-request call needed

  const guest = await Guest.findOne({ phone: formatPhone(phone) });
  if (!guest) throw new AppError('Order not found', 404, 'NOT_FOUND');

  const order = await Order.findOne({ orderRef, guestId: guest._id })
    .lean();

  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');

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

    if (
      order.paymentMethod === PAYMENT_METHODS.MPESA &&
      order.paymentStatus !== PAYMENT_STATUSES.PAID
    ) {
      throw new AppError(
        'Cannot approve order: M-Pesa payment has not been confirmed yet.',
        400,
        'PAYMENT_NOT_CONFIRMED'
      );
    }

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

    appEvents.emit(ORDER_EVENTS.APPROVED, { order, branchId: order.branchId });

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

  validateReason(reason, 'A rejection reason');

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
    if (order.couponCode) await couponService.releaseUsage(order.couponCode, order.branchId, session);
    await order.save({ session });
    await session.commitTransaction();

    if (order.paymentStatus === PAYMENT_STATUSES.PAID && order.paymentId) {
      await Payment.findByIdAndUpdate(order.paymentId, {
        status:       PAYMENT_STATUSES.REFUNDED,
        refundedAt:   new Date(),
        refundReason: reason
      });
      await activityLogService.log({
        actorId:    adminId,
        actorRole,
        action:     LOG_ACTIONS.PAYMENT_REFUNDED,
        branchId:   order.branchId,
        targetId:   order.paymentId,
        targetType: 'Payment',
        detail:     { orderRef: order.orderRef, reason }
      });
    }

    await activityLogService.log({
      actorId: adminId,
      actorRole,
      action: LOG_ACTIONS.ORDER_REJECTED,
      branchId: order.branchId,
      targetId: order._id,
      targetType: 'Order',
      detail: { orderRef: order.orderRef, reason, stockReleased: true }
    });

    appEvents.emit(ORDER_EVENTS.REJECTED, { order, branchId: order.branchId });

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

    if (
      newStatus === ORDER_STATUSES.COMPLETED &&
      order.paymentMethod !== PAYMENT_METHODS.MPESA &&
      order.paymentStatus !== PAYMENT_STATUSES.PAID
    ) {
      throw new AppError(
        'Cannot complete order: cash payment has not been confirmed yet.',
        400,
        'PAYMENT_NOT_CONFIRMED'
      );
    }

    order.status = newStatus;
    order.statusHistory.push({
      status: newStatus,
      changedAt: new Date(),
      changedBy: adminId,
      note
    });

    if (newStatus === ORDER_STATUSES.CANCELLED) {
      await releaseOrderStock(order, adminId, session, note || 'Cancelled by staff');
      if (order.couponCode) await couponService.releaseUsage(order.couponCode, order.branchId, session);
    }

    if (newStatus === ORDER_STATUSES.COMPLETED && !order.deliveredAt) {
      order.deliveredAt = new Date();
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
      appEvents.emit(ORDER_EVENTS.DISPATCHED, { order, branchId: order.branchId });
    }

    // eTIMS: fiscalise COD and pickup orders at the moment of completion.
    // M-Pesa orders are already fiscalised when the payment callback arrives.
    if (newStatus === ORDER_STATUSES.COMPLETED && order.paymentMethod !== 'mpesa') {
      etimsService.submitInvoice(order._id).catch(err =>
        logger.error('[eTIMS] Invoice submission failed on order completion', { orderId: order._id, err: err.message })
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
const cancel = async (orderId, userId) => {
  // Auto-cancel is handled by autoCancel.job.js — no per-request call needed
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const order = await Order.findById(orderId).session(session);
    // Same 404 for "doesn't exist" and "isn't yours" — a distinct 403 would let a
    // logged-in customer enumerate which order IDs exist by reading the status code.
    if (!order || !order.userId || order.userId.toString() !== userId.toString()) {
      throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
    }

    // Customers may only self-cancel while pending — once approved, staff have
    // started fulfilling it, so cancellation past that point goes through admin
    // (updateStatus, which allows cancelled from any non-terminal stage).
    if (order.status !== ORDER_STATUSES.PENDING) {
      throw new AppError(
        `Cannot cancel an order that is already "${order.status}". Please contact us to cancel.`,
        400,
        'INVALID_STATUS_TRANSITION'
      );
    }

    order.status = ORDER_STATUSES.CANCELLED;
    order.statusHistory.push({
      status: ORDER_STATUSES.CANCELLED,
      changedAt: new Date(),
      changedBy: userId,
      note: 'Cancelled by customer'
    });

    await releaseOrderStock(order, userId, session, 'Cancelled by customer');
    if (order.couponCode) await couponService.releaseUsage(order.couponCode, order.branchId, session);
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
// Each order runs in its own session (partial success semantics: some can fail
// while others succeed). Promise.allSettled processes all concurrently.
const bulkApprove = async (orderIds, adminId, branchId, actorRole = 'supervisor') => {
  const settled = await Promise.allSettled(
    orderIds.map(id => approve(id, adminId, branchId, actorRole))
  );

  return settled.reduce((acc, result, i) => {
    if (result.status === 'fulfilled') {
      acc.approved.push(result.value.orderRef);
    } else {
      acc.failed.push({ id: orderIds[i], error: result.reason?.message || 'Unknown error' });
    }
    return acc;
  }, { approved: [], failed: [] });
};

// ── BULK REJECT ───────────────────────────────────────────────────────────────
const bulkReject = async (orderIds, adminId, reason, branchId, actorRole = 'supervisor') => {
  validateReason(reason, 'A rejection reason');

  const settled = await Promise.allSettled(
    orderIds.map(id => reject(id, adminId, reason, branchId, actorRole))
  );

  return settled.reduce((acc, result, i) => {
    if (result.status === 'fulfilled') {
      acc.rejected.push(result.value.orderRef);
    } else {
      acc.failed.push({ id: orderIds[i], error: result.reason?.message || 'Unknown error' });
    }
    return acc;
  }, { rejected: [], failed: [] });
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
  const session = await mongoose.startSession();
  session.startTransaction();

  let order, driver;
  try {
    order = await Order.findOne({ _id: orderId, branchId }).session(session);
    if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');

    if (order.deliveryMethod !== 'delivery') {
      throw new AppError('Cannot assign a driver to a pickup order', 400, 'NOT_DELIVERY_ORDER');
    }

    const allowed = [ORDER_STATUSES.PREPARING, ORDER_STATUSES.OUT_FOR_DELIVERY];
    if (!allowed.includes(order.status)) {
      throw new AppError(`Driver can only be assigned when order is preparing or out for delivery`, 400, 'INVALID_ORDER_STATUS');
    }

    driver = await User.findOne({ _id: driverId, role: ROLES.DRIVER, branchId }).session(session);
    if (!driver) throw new AppError('Driver not found in this branch', 404, 'DRIVER_NOT_FOUND');

    order.driverId = driverId;

    // Auto-advance: preparing → out_for_delivery when driver is first assigned
    if (order.status === ORDER_STATUSES.PREPARING) {
      validateTransition(order.status, ORDER_STATUSES.OUT_FOR_DELIVERY);
      order.status = ORDER_STATUSES.OUT_FOR_DELIVERY;
      order.statusHistory.push({
        status: ORDER_STATUSES.OUT_FOR_DELIVERY,
        changedAt: new Date(),
        changedBy: adminId,
        note: `Driver ${driver.name} assigned`
      });
    }

    await order.save({ session });
    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }

  await activityLogService.log({
    actorId: adminId,
    actorRole,
    action: LOG_ACTIONS.DRIVER_ASSIGNED_TO_ORDER,
    branchId,
    targetId: order._id,
    targetType: 'Order',
    detail: { orderRef: order.orderRef, driverId, driverName: driver.name }
  });

  // Notify customer only when the order transitions to out_for_delivery
  if (order.status === ORDER_STATUSES.OUT_FOR_DELIVERY) {
    appEvents.emit(ORDER_EVENTS.DISPATCHED, { order, branchId });
  }

  return order;
};

// ── CUSTOMER SPENDING STATS ───────────────────────────────────────────────────
// Returns this-month spend, last-month spend, all-time total, and a simple
// category breakdown derived from completed/approved orders.
const getMyStats = async (userId) => {
  const now = new Date();
  // EAT-aware month boundaries (not server/UTC) — matches getDashboardKPIs, so an
  // order placed late at night in Nairobi lands in the same month everywhere.
  const thisMonthStart = startOfMonthEAT(now);
  const lastMonthStart = startOfMonthEAT(new Date(thisMonthStart.getTime() - 1));
  const lastMonthEnd   = thisMonthStart;

  const COUNTED_STATUSES = ['pending', 'approved', 'preparing', 'out_for_delivery', 'completed'];

  const [result] = await Order.aggregate([
    { $match: { userId, status: { $in: COUNTED_STATUSES } } },
    { $facet: {
      thisMonth: [
        { $match: { createdAt: { $gte: thisMonthStart } } },
        { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } }
      ],
      lastMonth: [
        { $match: { createdAt: { $gte: lastMonthStart, $lt: lastMonthEnd } } },
        { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } }
      ],
      allTime: [
        { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } }
      ],
      topProducts: [
        { $unwind: '$orderItems' },
        { $group: { _id: '$orderItems.productName', total: { $sum: '$orderItems.lineTotal' } } },
        { $sort: { total: -1 } },
        { $limit: 5 }
      ]
    }}
  ]);

  return {
    thisMonth:   { total: result.thisMonth[0]?.total   || 0, orderCount: result.thisMonth[0]?.count   || 0 },
    lastMonth:   { total: result.lastMonth[0]?.total   || 0, orderCount: result.lastMonth[0]?.count   || 0 },
    allTime:     { total: result.allTime[0]?.total     || 0, orderCount: result.allTime[0]?.count     || 0 },
    topProducts: result.topProducts.map(r => ({ name: r._id, total: r.total }))
  };
};

module.exports = {
  createGuestOrder,
  createCustomerOrder,
  calculateDeliveryFee,
  getById,
  getAll,
  getMyOrders,
  getMyOrderById,
  getMyStats,
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
