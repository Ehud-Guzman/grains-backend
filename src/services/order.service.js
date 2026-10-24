const crypto = require('crypto');
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
const { appEvents, ORDER_EVENTS, STOCK_EVENTS } = require('../events/appEvents');
const settingsService = require('./settings.service');
const logger = require('../utils/logger');
const generateOrderRef = require('../utils/generateOrderRef');
const OrderDedupe = require('../models/OrderDedupe');
const { createKeyedLimiter } = require('../utils/keyedLimiter');
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
const { formatPhone, phoneVariants } = require('../utils/mpesaHelpers');
const { paginate, buildPaginationMeta } = require('../utils/paginate');
const { validateReason } = require('../utils/validateReason');
const { withGuestFallback, withGuestFallbackList } = require('../utils/orderGuestFallback');
const { escapeRegex } = require('../utils/escapeRegex');
const couponService = require('./coupon.service');
const { startOfMonthEAT } = require('../utils/businessTime');
const { runTransaction } = require('../utils/transaction');

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
    // A packaging saved without a price (it is nullable) used to sell at KES 0.
    if (!(Number(packaging.priceKES) > 0)) {
      throw new AppError(`${item.variety} ${item.packaging} is not available to order online right now`, 409, 'PRICE_NOT_SET');
    }
    if (packaging.stock < item.quantity) {
      throw new AppError(
        `Insufficient stock for ${item.variety} ${item.packaging}. Available: ${packaging.stock}, Requested: ${item.quantity}`,
        409,
        'STOCK_INSUFFICIENT'
      );
    }

    // Apply volume pricing tier if configured
    let unitPrice = round2(packaging.priceKES);
    if (packaging.pricingTiers?.length > 0) {
      const sorted = [...packaging.pricingTiers].sort((a, b) => b.minQty - a.minQty);
      const tier = sorted.find(t => item.quantity >= t.minQty);
      if (tier) unitPrice = round2(tier.priceKES);
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
  // Keep whatever the placement note already says (delivery zone, "no location
  // shared") — overwriting it threw that information away.
  const placed = order.statusHistory[0].note || 'Order placed';
  order.statusHistory[0].note = placed.replace(/^Order placed/, 'Order placed and stock reserved');
  await order.save({ session });
};

// Returns the released items whose stock went 0 → positive, so the caller can
// emit back-in-stock events AFTER the transaction commits (emitting in here
// would fire customer alerts for a release the transaction may still abort).
const releaseOrderStock = async (order, actorId, session, note) => {
  if (!orderHasHeldStock(order)) return [];

  const restocked = [];
  for (const item of order.orderItems) {
    let released;
    try {
      released = await stockService.releaseStock(
        item.productId,
        item.variety,
        item.packaging,
        item.quantity,
        order._id,
        actorId,
        session,
        order.branchId
      );
    } catch (err) {
      // The line was renamed or removed from the catalogue after the order was
      // placed. There is nothing left to put the stock back into — letting this
      // throw made the order impossible to cancel or reject (and auto-cancel failed
      // every run). Skip the line, keep the rest, and leave a trail.
      if (err.errorCode !== 'PRODUCT_NOT_FOUND') throw err;
      logger.warn('[stock] Release skipped — packaging no longer exists', {
        orderRef: order.orderRef, productId: String(item.productId), variety: item.variety, packaging: item.packaging
      });
      continue;
    }
    const { balanceAfter } = released;
    if (balanceAfter === item.quantity) {
      restocked.push({
        productId: item.productId,
        branchId: order.branchId,
        varietyName: item.variety,
        packaging: item.packaging,
        newStock: balanceAfter
      });
    }
  }

  order.stockReservationStatus = STOCK_RESERVATION_STATUSES.RELEASED;
  order.stockReleasedAt = new Date();
  if (note) {
    const historyEntry = order.statusHistory[order.statusHistory.length - 1];
    if (historyEntry) historyEntry.note = note;
  }

  return restocked;
};

// Fire back-in-stock events for items a release returned from 0 to available —
// call only after the surrounding transaction has committed.
const emitRestockEvents = (restocked = []) => {
  for (const payload of restocked) {
    appEvents.emit(STOCK_EVENTS.UPDATED, payload);
  }
};

const markOrderReservationConsumed = (order) => {
  order.stockReservationStatus = STOCK_RESERVATION_STATUSES.CONSUMED;
  if (!order.stockReservedAt) order.stockReservedAt = new Date();
  order.stockConsumedAt = new Date();
};

// Current wall-clock time in Nairobi as a zero-padded "HH:MM" string —
// lexicographic comparison against the stored orderAcceptanceStart/End
// (same format) is then a correct time comparison.
const currentTimeEAT = () => {
  const shifted = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
};

const assertShopCanAcceptOrders = (settings) => {
  if (settings.maintenanceMode) {
    throw new AppError(
      settings.maintenanceMessage || 'We are currently undergoing maintenance. Please check back soon.',
      503,
      'MAINTENANCE_MODE'
    );
  }

  // Platform lock is the superadmin "stop everything" switch — no new orders
  // while it's on (admin-side writes are blocked by platformLock.middleware.js).
  if (settings.platformLocked) {
    throw new AppError(
      'Ordering is temporarily paused. Please check back soon.',
      503,
      'PLATFORM_LOCKED'
    );
  }

  // Order acceptance hours (Nairobi clock). Window is inclusive on both ends;
  // start > end means an overnight window (e.g. 20:00–06:00). start === end is
  // treated as "no restriction" rather than a one-minute window — a misclick
  // must not silently close the shop 24/7.
  if (settings.enableOrderHours && settings.orderAcceptanceStart && settings.orderAcceptanceEnd) {
    const start = settings.orderAcceptanceStart;
    const end = settings.orderAcceptanceEnd;
    if (start !== end) {
      const now = currentTimeEAT();
      const withinWindow = start < end
        ? (now >= start && now <= end)
        : (now >= start || now <= end); // overnight window
      if (!withinWindow) {
        throw new AppError(
          `We accept orders between ${start} and ${end}. Please come back then — your cart will be waiting.`,
          400,
          'OUTSIDE_ORDER_HOURS'
        );
      }
    }
  }
};

const assertOrderMatchesSettings = ({ settings, deliveryMethod, paymentMethod, subtotal, totalQuantity, isGuestOrder }) => {
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

  if (settings.minimumOrderQuantity > 0 && totalQuantity < settings.minimumOrderQuantity) {
    throw new AppError(
      `This branch takes bulk orders only — minimum ${settings.minimumOrderQuantity} bags per order.`,
      400,
      'MINIMUM_ORDER_QTY_NOT_MET'
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
  // Never auto-cancel an order the customer has PAID for (or whose STK prompt is still in flight): the
  // old behaviour cancelled it and flagged "refund owed" a minute after the money arrived (2026-10
  // audit, F-19). Those wait for staff, who are reminded below instead.
  const expiredOrders = await Order.find({
    branchId,
    status: ORDER_STATUSES.PENDING,
    paymentStatus: { $nin: [PAYMENT_STATUSES.PAID, PAYMENT_STATUSES.PENDING] },
    createdAt: { $lte: cutoff }
  }).select('_id').lean();

  const stalePaid = await Order.find({
    branchId,
    status: ORDER_STATUSES.PENDING,
    paymentStatus: PAYMENT_STATUSES.PAID,
    createdAt: { $lte: cutoff }
  }).select('orderRef total createdAt').limit(20).lean();
  const alertService = require('./alert.service'); // lazy: avoids a require cycle
  for (const o of stalePaid) {
    alertService.sendAlert(
      'PAID_ORDER_AWAITING_APPROVAL',
      { 'Order ref': o.orderRef, Total: o.total, Placed: o.createdAt.toISOString() },
      String(o._id)
    ).catch(() => {});
  }

  for (const { _id } of expiredOrders) {
    try {
      const outcome = await runTransaction(async (session) => {
        const order = await Order.findById(_id).session(session);
        if (!order || order.status !== ORDER_STATUSES.PENDING) return null; // acted on since the list was read
        if ([PAYMENT_STATUSES.PAID, PAYMENT_STATUSES.PENDING].includes(order.paymentStatus)) return null; // paid since the list was read

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

        const restocked = await releaseOrderStock(order, actorId, session, note);
        if (order.couponCode) await couponService.releaseUsage(order.couponCode, order.branchId, session);
        // A PENDING order can already be PAID — order.status only advances to
        // APPROVED on admin action, but an M-Pesa STK payment can succeed while
        // an order still sits PENDING awaiting approval (handleCallback never
        // touches order.status). Same gap as reject()/cancel() — see refundPaymentIfPaid.
        // Inside the transaction so the refund is recorded or the cancel doesn't happen.
        const refunded = await refundPaymentIfPaid(order, note, session);
        await order.save({ session });
        return { order, actorId, restocked, refunded, note };
      });
      if (!outcome) continue;

      const { order, actorId, restocked, refunded, note } = outcome;
      emitRestockEvents(restocked);
      if (refunded) await logRefund(order, actorId, order.userId ? 'customer' : 'guest', note);
      appEvents.emit(ORDER_EVENTS.CANCELLED, { order, branchId: order.branchId, refundOwed: refunded, automatic: true });

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
          reason: 'AUTO_CANCEL_EXPIRED_PENDING',
          ...(order.couponCode && { couponCode: order.couponCode, couponUsageReleased: true })
        }
      });
    } catch (err) {
      // Don't let one order's failure abort the rest of this cycle's batch — log and
      // move on, the next 5-minute run will pick this order back up if it's still eligible.
      // (A write conflict with a concurrent admin approve() is retried inside runTransaction.)
      logger.error('[autoCancel] Failed to auto-cancel order', { orderId: _id, err: err.message });
    }
  }
};

// ── DUPLICATE ORDER GUARD ─────────────────────────────────────────────────────
// Idempotency guard: reject an exact-duplicate submission (double-click / network retry resubmitting the
// same checkout) landing within a short window, since order creation has no client-supplied idempotency key.
// Mirrors stock.service.js's addDelivery duplicate guard. The guard is a unique-key claim on a fingerprint of
// the checkout (OrderDedupe) made inside the order's transaction - race-free without any shared counter.
const DUPLICATE_ORDER_WINDOW_MS = 20000;
const duplicateSubmission = () => new AppError(
  'An identical order was just placed — please wait before resubmitting',
  409,
  'DUPLICATE_SUBMISSION'
);

// Fingerprint of a checkout: who, which exact basket, what total. The basket is part of it (2026-10 audit,
// F-36): the old guard compared only the total and the NUMBER of lines, so a customer buying a different
// product for the same price within 20 seconds was told they had double-clicked.
const orderFingerprint = ({ branchId, identity, total, items }) => {
  const lines = items
    .map((i) => `${i.productId}:${i.variety}:${i.packaging}:${i.quantity}`)
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(`${branchId}#${identity}#${total}#${lines}`).digest('hex');
};

// Cheap pre-check, made before an order number is allocated so a double-click does not burn one.
const assertNotJustPlaced = async (fingerprint) => {
  const row = await OrderDedupe.findById(fingerprint).lean();
  if (row && row.createdAt.getTime() > Date.now() - DUPLICATE_ORDER_WINDOW_MS) throw duplicateSubmission();
};

// The race-proof version, inside the order's transaction: claim the fingerprint, or take over one that is
// older than the window (TTL cleanup lags). Two simultaneous submissions both reach the insert; MongoDB lets
// one commit, the other conflicts, is retried and then finds the committed row -> 409.
const claimFingerprint = async (fingerprint, session) => {
  try {
    await OrderDedupe.updateOne(
      { _id: fingerprint, createdAt: { $lt: new Date(Date.now() - DUPLICATE_ORDER_WINDOW_MS) } },
      { $set: { createdAt: new Date() } },
      { upsert: true, session }
    );
  } catch (err) {
    if (err.code === 11000) throw duplicateSubmission();
    throw err;
  }
};

// Checkouts for one branch are fed to MongoDB a few at a time (see utils/keyedLimiter.js).
const placementQueue = createKeyedLimiter({
  concurrency: Number(process.env.ORDER_PLACEMENT_CONCURRENCY) || 3,
  maxWaiting: 200,
  maxWaitMs: 10000,
});
const orderRetryBudgetMs = () => Number(process.env.ORDER_RETRY_BUDGET_MS) || 8000;

// Allocate the order number, then create the order in one retried transaction.
//
// The number is taken OUTSIDE the transaction. Inside it, the branch's counter was a document every order
// wrote, so unrelated orders (different products!) collided and a 40-order burst lost 10-75% of its
// orders to conflicts - and one crashed transaction holding the counter froze the branch for ~80 seconds
// (2026-10 audit, F-05/F-06). A failed order now leaves a gap in the sequence instead of giving its number
// back; references only need to be unique and increasing, they are not fiscal invoice numbers.
const placeOrder = async ({ branchId, identity, total, items }, build) => {
  const fingerprint = orderFingerprint({ branchId, identity, total, items });
  await assertNotJustPlaced(fingerprint);
  return placementQueue(branchId, async () => {
    const orderRef = await generateOrderRef(branchId);
    return runTransaction(async (session) => {
      await claimFingerprint(fingerprint, session);
      return build(session, orderRef);
    }, { maxAttempts: 60, budgetMs: orderRetryBudgetMs() });
  });
};

// The customer's screen showed `expected`; if the live total differs by more than a shilling, a price moved
// while they were checking out. Refuse with a clear message rather than charge (and prompt on M-Pesa for)
// an amount they never saw. A missing or malformed hint is ignored: older clients do not send one.
const assertExpectedTotal = (expected, total) => {
  if (expected === undefined || expected === null || expected === '') return;
  const shown = Number(expected);
  if (!Number.isFinite(shown)) return;
  if (Math.abs(shown - total) > 1) {
    throw new AppError(
      `Prices changed while you were checking out. The new total is KES ${total.toLocaleString('en-KE', { maximumFractionDigits: 2 })}. Please review your order and confirm again.`,
      409,
      'PRICE_CHANGED'
    );
  }
};

// What the order's first history line says. In distance-pricing mode a delivery order
// with no location shared pays the flat fee and skips the delivery-radius check
// (the customer's own GPS is the only input) — say so on the order so staff can
// adjust at approval instead of finding out at the door.
const placementNote = ({ zoneName, distanceKm, settings, deliveryMethod }) => {
  if (zoneName) return `Order placed · delivery zone: ${zoneName} (${distanceKm} km)`;
  if (deliveryMethod === 'delivery' && settings.deliveryPricingMode === 'distance' && distanceKm == null) {
    return 'Order placed · no location shared, flat delivery fee charged — check distance before approving';
  }
  return 'Order placed';
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
    totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
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
      orderData.couponCode, branchId, null, subtotal, orderData.phone
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
  const vatAmount  = vatEnabled ? round2(vatBase * vatRate / 100) : 0;

  const preferredDriverId = await resolvePreferredDriver(orderData.preferredDriverId, branchId);
  const total = round2(Math.max(0, subtotal + deliveryFee + vatAmount - couponDiscount));
  assertExpectedTotal(orderData.expectedTotal, total);

  // Match against every historically-possible stored format (07.../+254.../254...)
  // so a repeat guest is recognised regardless of which format their earlier
  // order was placed under — see phoneVariants for why this can't just be a
  // straight equality check.
  const phoneMatch = { phone: { $in: phoneVariants(orderData.phone) } };
  // Race-safe guest lookup (outside the transaction, before the duplicate-order
  // check): a plain findOne-or-create isn't atomic on its own — two concurrent
  // first-time submissions can both see "no guest yet" and both bypass
  // the duplicate-submission guard in placeOrder (which needs a guest id to
  // fingerprint), creating two orders. The actual atomicity comes from Guest.phone's unique
  // index (Guest.js) — only one concurrent create() can win; the loser catches
  // the E11000 and re-reads what the winner inserted. (A bare upsert here is
  // NOT sufficient: per MongoDB's own docs, upsert:true only avoids duplicate
  // inserts under concurrency when the matched field is uniquely indexed.)
  // New guests are stored in the canonical 2547XXXXXXXX form so future lookups
  // (tracking, dedup) never need the variant fallback for them.
  let guest = await Guest.findOne(phoneMatch);
  if (!guest) {
    try {
      guest = await Guest.create({
        name: orderData.name,
        phone: formatPhone(orderData.phone),
        email: orderData.email?.trim().toLowerCase() || null,
        location: orderData.deliveryAddress || ''
      });
    } catch (err) {
      if (err.code !== 11000) throw err;
      guest = await Guest.findOne(phoneMatch);
    }
  } else if (orderData.email?.trim()) {
    // Repeat guest supplying an email (new or updated) — keep the record
    // current so order-status emails reach where they asked, this order included.
    const email = orderData.email.trim().toLowerCase();
    if (guest.email !== email) {
      guest.email = email;
      await guest.save();
    }
  }
  // The order, its stock reservation, the guest link and the coupon use commit together or not at
  // all. placeOrder re-runs this whole block if MongoDB reports a write conflict with another order
  // (typically one reserving the same product) - see utils/transaction.js.
  const order = await placeOrder({ branchId, identity: `guest:${guest._id}`, total, items }, async (session, orderRef) => {
    const [created] = await Order.create([{
      orderRef,
      branchId,
      guestId: guest._id,
      guestName: orderData.name?.trim() || guest.name,
      guestPhone: guest.phone,
      userId: null,
      orderItems: items,
      subtotal,
      deliveryFee,
      vatEnabled,
      vatRate,
      vatAmount,
      couponCode,
      couponDiscount,
      total,
      deliveryMethod: orderData.deliveryMethod,
      deliveryAddress: orderData.deliveryAddress || null,
      paymentMethod: orderData.paymentMethod,
      paymentStatus: PAYMENT_STATUSES.UNPAID,
      status: ORDER_STATUSES.PENDING,
      stockReservationStatus: STOCK_RESERVATION_STATUSES.NONE,
      specialInstructions: orderData.specialInstructions || null,
      preferredDeliveryDate: orderData.preferredDeliveryDate ? new Date(orderData.preferredDeliveryDate) : null,
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
        note: placementNote({ zoneName, distanceKm, settings, deliveryMethod: orderData.deliveryMethod })
      }]
    }], { session });

    await reserveOrderStock(created, guest._id, 'guest', session);
    await Guest.findByIdAndUpdate(guest._id, { $push: { orders: created._id } }, { session });
    if (couponCode) await couponService.incrementUsage(couponCode, branchId, session, { guestId: guest._id, excludeOrderId: created._id });
    return created;
  });

  await activityLogService.log({
    actorId: guest._id,
    actorRole: 'guest',
    action: LOG_ACTIONS.ORDER_CREATED,
    branchId,
    targetId: order._id,
    targetType: 'Order',
    detail: {
      orderRef: order.orderRef, total: order.total, itemCount: items.length, stockReserved: true,
      ...(couponCode && { couponCode, couponDiscount })
    }
  });

  appEvents.emit(ORDER_EVENTS.PLACED, { order, branchId });

  return order;
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
    totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
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
  const vatAmount  = vatEnabled ? round2(vatBase * vatRate / 100) : 0;

  const preferredDriverId = await resolvePreferredDriver(orderData.preferredDriverId, branchId);
  const total = round2(Math.max(0, subtotal + deliveryFee + vatAmount - couponDiscount));
  assertExpectedTotal(orderData.expectedTotal, total);

  // Same shape as createGuestOrder: one queued, retried transaction.
  const order = await placeOrder({ branchId, identity: `user:${userId}`, total, items }, async (session, orderRef) => {
    const [created] = await Order.create([{
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
      total,
      deliveryMethod: orderData.deliveryMethod,
      deliveryAddress: orderData.deliveryAddress || null,
      paymentMethod: orderData.paymentMethod,
      paymentStatus: PAYMENT_STATUSES.UNPAID,
      status: ORDER_STATUSES.PENDING,
      stockReservationStatus: STOCK_RESERVATION_STATUSES.NONE,
      specialInstructions: orderData.specialInstructions || null,
      preferredDeliveryDate: orderData.preferredDeliveryDate ? new Date(orderData.preferredDeliveryDate) : null,
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
        note: placementNote({ zoneName, distanceKm, settings, deliveryMethod: orderData.deliveryMethod })
      }]
    }], { session });

    await reserveOrderStock(created, userId, 'customer', session);
    await User.findByIdAndUpdate(userId, { $push: { orderHistory: created._id }, $addToSet: { orderedBranchIds: branchId } }, { session });
    if (couponCode) await couponService.incrementUsage(couponCode, branchId, session, { userId, excludeOrderId: created._id });
    return created;
  });

  await activityLogService.log({
    actorId: userId,
    actorRole: 'customer',
    action: LOG_ACTIONS.ORDER_CREATED,
    branchId,
    targetId: order._id,
    targetType: 'Order',
    detail: {
      orderRef: order.orderRef, total: order.total, itemCount: items.length, stockReserved: true,
      ...(couponCode && { couponCode, couponDiscount })
    }
  });

  appEvents.emit(ORDER_EVENTS.PLACED, { order, branchId });

  return order;
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
  return withGuestFallback(order);
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
  // The reconciliation queues: paymentStatus=refunded → money owed back to
  // customers; paymentStatus=unpaid + status=completed → COD cash not yet
  // remitted by the driver.
  if (filters.paymentStatus) matchStage.paymentStatus = filters.paymentStatus;
  if (filters.deliveryMethod) matchStage.deliveryMethod = filters.deliveryMethod;

  if (filters.from || filters.to) {
    matchStage.createdAt = {};
    if (filters.from) matchStage.createdAt.$gte = new Date(filters.from);
    if (filters.to) matchStage.createdAt.$lte = new Date(filters.to);
  }

  // Search by orderRef, guest name/phone (snapshotted on the order itself), or
  // a registered customer's name/phone - SRS 5.9. User lives in a different
  // collection so it can't be regex-matched inside the Order query directly —
  // resolve matching user IDs first. (Orders placed before the guestName/
  // guestPhone snapshot existed won't match on those two fields.)
  if (filters.search) {
    const searchRe = { $regex: escapeRegex(filters.search), $options: 'i' };
    // Only customers who have ordered at THIS branch can own one of its orders, so the user scan is limited to
    // them (and capped) instead of regex-matching every account on the platform (2026-10 audit, F-22).
    const matchingUsers = await User.find({
      role: 'customer',
      ...(branchId && { orderedBranchIds: branchId }),
      $or: [{ name: searchRe }, { phone: searchRe }]
    }).select('_id').limit(200).lean();
    matchStage.$or = [
      { orderRef: searchRe },
      { guestName: searchRe },
      { guestPhone: searchRe },
      ...(matchingUsers.length ? [{ userId: { $in: matchingUsers.map(u => u._id) } }] : [])
    ];
  }

  const [total, orders] = await Promise.all([
    Order.countDocuments(matchStage).maxTimeMS(10000),
    Order.find(matchStage)
      .populate('userId', 'name phone email')
      .populate('guestId', 'name phone')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .maxTimeMS(10000)
      .lean()
  ]);

  return { orders: withGuestFallbackList(orders), pagination: buildPaginationMeta(page, limit, total) };
};

// ── CUSTOMER VIEW OF AN ORDER'S HISTORY ───────────────────────────────────────
// The timeline a customer sees is the status, when it happened and - only if staff wrote one for them - a
// public note. The internal `note` ("no location shared, check distance before approving", cancel reasons)
// and `changedBy` (staff user ids) stay on the server (2026-10 audit, F-20).
const toCustomerHistory = (history = []) =>
  history.map((h) => ({ status: h.status, changedAt: h.changedAt, note: h.publicNote || null }));
const toCustomerOrder = (order) => (order ? { ...order, statusHistory: toCustomerHistory(order.statusHistory) } : order);

// ── GET MY ORDERS (CUSTOMER) ──────────────────────────────────────────────────
const CUSTOMER_ORDER_FIELDS = 'orderRef orderItems subtotal deliveryFee couponCode couponDiscount vatEnabled vatRate vatAmount total deliveryMethod deliveryAddress paymentMethod paymentStatus status rejectionReason specialInstructions buyerKraPin branchId createdAt updatedAt statusHistory.status statusHistory.changedAt statusHistory.publicNote driverId preferredDriverId deliveredAt';

const getMyOrders = async (userId, query = {}, branchId) => {
  // Auto-cancel is handled by autoCancel.job.js — no per-request call needed

  const { page, limit, skip } = paginate(query);
  // Customers can see their orders across all branches (shared accounts)
  const filter = { userId };

  // Search by order reference — lets a repeat customer jump straight to an
  // old order instead of paging through their full history.
  if (query.search) {
    filter.orderRef = { $regex: escapeRegex(query.search), $options: 'i' };
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

  return { orders: orders.map(toCustomerOrder), pagination: buildPaginationMeta(page, limit, total) };
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
  return toCustomerOrder(order);
};

// ── TRACK BY REF (GUEST) ──────────────────────────────────────────────────────
// SRS 5.5 - public order tracking by phone + ref
// Field list mirrors CUSTOMER_ORDER_FIELDS — this is an unauthenticated lookup
// (phone + ref only), so GPS coordinates, buyerKraPin, and statusHistory actor
// IDs must never be exposed here even though they're safe on the authed routes.
const TRACK_ORDER_FIELDS = 'orderRef orderItems subtotal deliveryFee couponCode couponDiscount vatEnabled vatRate vatAmount total deliveryMethod paymentMethod paymentStatus status rejectionReason createdAt statusHistory.status statusHistory.changedAt statusHistory.publicNote';

const trackByRef = async (phone, orderRef) => {
  // Auto-cancel is handled by autoCancel.job.js — no per-request call needed

  // Match every historically-possible stored format — see phoneVariants.
  const guest = await Guest.findOne({ phone: { $in: phoneVariants(phone) } });
  if (!guest) throw new AppError('Order not found', 404, 'NOT_FOUND');

  const order = await Order.findOne({ orderRef, guestId: guest._id })
    .select(TRACK_ORDER_FIELDS)
    .lean();

  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');

  return toCustomerOrder(order);
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

  const order = await runTransaction(async (session) => {
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
    return order;
  });

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
};

// ── REJECT ORDER ──────────────────────────────────────────────────────────────
// SRS 5.2 - reason is mandatory
const reject = async (orderId, adminId, reason, branchId, actorRole = 'supervisor') => {
  // Auto-cancel is handled by autoCancel.job.js — no per-request call needed

  validateReason(reason, 'A rejection reason');

  const { order, restocked, refunded } = await runTransaction(async (session) => {
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

    const restocked = await releaseOrderStock(order, adminId, session, reason);
    if (order.couponCode) await couponService.releaseUsage(order.couponCode, order.branchId, session);
    const refunded = await refundPaymentIfPaid(order, reason, session);
    flagCreditNoteIfInvoiced(order);
    await order.save({ session });
    return { order, restocked, refunded };
  });

  emitRestockEvents(restocked);
  if (refunded) await logRefund(order, adminId, actorRole, reason);

  await activityLogService.log({
    actorId: adminId,
    actorRole,
    action: LOG_ACTIONS.ORDER_REJECTED,
    branchId: order.branchId,
    targetId: order._id,
    targetType: 'Order',
    detail: {
      orderRef: order.orderRef, reason, stockReleased: true,
      ...(order.couponCode && { couponCode: order.couponCode, couponUsageReleased: true })
    }
  });

  appEvents.emit(ORDER_EVENTS.REJECTED, { order, branchId: order.branchId });

  return order;
};

// ── REFUND HELPER ──────────────────────────────────────────────────────────────
// Mirrors the refund side-effect in reject(): any terminal transition away from
// a paid order must flip the Payment to REFUNDED so the money owed is tracked,
// not just the stock/coupon release.
//
// Runs INSIDE the cancel/reject transaction (pass the session), together with the
// stock release and coupon release. It used to run after commit as separate writes:
// a failure there left a cancelled order still marked paid — money owed, not
// recorded — and surfaced to the caller as a transaction error. It only touches the
// Payment document and sets order.paymentStatus in memory; the caller's own
// order.save({ session }) persists the order side. Returns true when a refund was
// recorded, so the caller can log it (logRefund) after commit.
const refundPaymentIfPaid = async (order, reason, session) => {
  if (!(order.paymentStatus === PAYMENT_STATUSES.PAID && order.paymentId)) return false;
  await Payment.findByIdAndUpdate(order.paymentId, {
    status:       PAYMENT_STATUSES.REFUNDED,
    refundedAt:   new Date(),
    refundReason: reason
  }, session ? { session } : {});
  // Mirror onto the order — leaving it 'paid' shows a green Paid badge on a
  // cancelled order and hides that money is owed back. 'refunded' here means
  // "refund recorded/owed"; the actual M-Pesa reversal is a manual step the
  // admin does off-system, tracked via the Payment record + activity log.
  order.paymentStatus = PAYMENT_STATUSES.REFUNDED;
  return true;
};

// An order that was fiscalised with KRA and is then cancelled or rejected needs a credit note against its invoice, or
// KRA keeps a sale that never happened (and the VAT on it). Invoices are only filed once an order is dispatched or
// completed AND paid, so in practice this is an order cancelled while out for delivery. Runs INSIDE the cancel/reject
// transaction and only sets the field in memory; the caller's order.save({ session }) persists it. Filing the credit
// note with KRA is a manual step for now (see markCreditNoteIssued): nothing here talks to KRA.
const flagCreditNoteIfInvoiced = (order) => {
  if (order.etimsStatus === 'submitted' && order.etimsCreditNoteStatus !== 'issued') {
    order.etimsCreditNoteStatus = 'required';
    return true;
  }
  return false;
};

const logRefund = (order, actorId, actorRole, reason) => activityLogService.log({
  actorId,
  actorRole,
  action:     LOG_ACTIONS.PAYMENT_REFUNDED,
  branchId:   order.branchId,
  targetId:   order.paymentId,
  targetType: 'Payment',
  detail:     { orderRef: order.orderRef, reason }
});

// ── UPDATE STATUS ─────────────────────────────────────────────────────────────
// SRS 5.2 - staff+ moves order through the pipeline
const updateStatus = async (orderId, newStatus, adminId, note = null, branchId, actorRole = 'staff') => {
  // Auto-cancel is handled by autoCancel.job.js — no per-request call needed
  const { order, restocked, refunded } = await runTransaction(async (session) => {
    const query = { _id: orderId };
    if (branchId) query.branchId = branchId;
    const order = await Order.findOne(query).session(session);
    if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');

    validateTransition(order.status, newStatus);

    // Completion payment gates by method:
    // - mpesa:    no gate here — payment was already required at approval.
    // - pickup:   gated — the counter staff confirming the cash and completing
    //             the order are the same person, so confirm-then-complete.
    // - delivery: NOT gated — the driver at the door collects the cash but has
    //             no permission to confirm payments (supervisor+ only), so COD
    //             orders complete with paymentStatus still unpaid and the
    //             supervisor confirms the cash when the driver remits it.
    if (
      newStatus === ORDER_STATUSES.COMPLETED &&
      order.paymentMethod === PAYMENT_METHODS.PICKUP &&
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

    let restocked = [];
    let refunded = false;
    if (newStatus === ORDER_STATUSES.CANCELLED) {
      restocked = await releaseOrderStock(order, adminId, session, note || 'Cancelled by staff');
      if (order.couponCode) await couponService.releaseUsage(order.couponCode, order.branchId, session);
      refunded = await refundPaymentIfPaid(order, note || 'Cancelled by staff', session);
      flagCreditNoteIfInvoiced(order);
    }

    if (newStatus === ORDER_STATUSES.COMPLETED && !order.deliveredAt) {
      order.deliveredAt = new Date();
    }

    await order.save({ session });
    return { order, restocked, refunded };
  });

  emitRestockEvents(restocked);

  if (refunded) await logRefund(order, adminId, actorRole, note || 'Cancelled by staff');
  if (newStatus === ORDER_STATUSES.CANCELLED) {
    appEvents.emit(ORDER_EVENTS.CANCELLED, { order, branchId: order.branchId, refundOwed: refunded, reason: note });
  }
  if (newStatus === ORDER_STATUSES.COMPLETED) {
    appEvents.emit(ORDER_EVENTS.COMPLETED, { order, branchId: order.branchId });
  }

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
      stockReleased: newStatus === ORDER_STATUSES.CANCELLED,
      ...(newStatus === ORDER_STATUSES.CANCELLED && order.couponCode && {
        couponCode: order.couponCode, couponUsageReleased: true
      })
    }
  });

  if (newStatus === ORDER_STATUSES.OUT_FOR_DELIVERY) {
    appEvents.emit(ORDER_EVENTS.DISPATCHED, { order, branchId: order.branchId });
  }

  // eTIMS: fiscalise COD and pickup orders at the moment of completion — but
  // only if the money has actually been confirmed. A COD order can now
  // complete unpaid (see the gate above); those are fiscalised later by
  // manualConfirmPayment when the supervisor confirms the cash.
  // M-Pesa orders are already fiscalised when the payment callback arrives.
  if (
    newStatus === ORDER_STATUSES.COMPLETED &&
    order.paymentMethod !== 'mpesa' &&
    order.paymentStatus === PAYMENT_STATUSES.PAID
  ) {
    etimsService.submitInvoice(order._id).catch(err =>
      logger.error('[eTIMS] Invoice submission failed on order completion', { orderId: order._id, err: err.message })
    );
  }

  return order;
};

// ── CANCEL ORDER ──────────────────────────────────────────────────────────────
// SRS 5.2 - customer can cancel only if still pending
const cancel = async (orderId, userId) => {
  // Auto-cancel is handled by autoCancel.job.js — no per-request call needed
  const { order, restocked, refunded } = await runTransaction(async (session) => {
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

    const restocked = await releaseOrderStock(order, userId, session, 'Cancelled by customer');
    if (order.couponCode) await couponService.releaseUsage(order.couponCode, order.branchId, session);
    const refunded = await refundPaymentIfPaid(order, 'Cancelled by customer', session);
    await order.save({ session });
    return { order, restocked, refunded };
  });

  emitRestockEvents(restocked);

  if (refunded) await logRefund(order, userId, 'customer', 'Cancelled by customer');
  appEvents.emit(ORDER_EVENTS.CANCELLED, { order, branchId: order.branchId, refundOwed: refunded, byCustomer: true });

  await activityLogService.log({
    actorId: userId,
    actorRole: 'customer',
    action: LOG_ACTIONS.ORDER_CANCELLED,
    branchId: order.branchId,
    targetId: order._id,
    targetType: 'Order',
    detail: {
      orderRef: order.orderRef, stockReleased: true,
      ...(order.couponCode && { couponCode: order.couponCode, couponUsageReleased: true })
    }
  });

  return order;
};

// ── BULK APPROVE ──────────────────────────────────────────────────────────────
// SRS 5.2 admin - approve multiple pending orders
// Each order runs in its own session (partial success semantics: some can fail
// while others succeed). Processed one at a time — fired concurrently, up to 50
// transactions at once contended for the connection pool and for the same product
// documents (shared stock lines), turning ordinary approvals into write conflicts.
const bulkApprove = async (orderIds, adminId, branchId, actorRole = 'supervisor') => {
  const result = { approved: [], failed: [] };
  for (const id of orderIds) {
    try {
      const order = await approve(id, adminId, branchId, actorRole);
      result.approved.push(order.orderRef);
    } catch (err) {
      result.failed.push({ id, error: err?.message || 'Unknown error' });
    }
  }
  return result;
};

// ── BULK REJECT ───────────────────────────────────────────────────────────────
const bulkReject = async (orderIds, adminId, reason, branchId, actorRole = 'supervisor') => {
  validateReason(reason, 'A rejection reason');

  const result = { rejected: [], failed: [] };
  for (const id of orderIds) {
    try {
      const order = await reject(id, adminId, reason, branchId, actorRole);
      result.rejected.push(order.orderRef);
    } catch (err) {
      result.failed.push({ id, error: err?.message || 'Unknown error' });
    }
  }
  return result;
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
  withGuestFallback(order);

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
// ── MARK AN eTIMS CREDIT NOTE AS ISSUED ───────────────────────────────────────
// Staff file the credit note with KRA (portal or the accountant) and record its reference here, which clears the order
// from the "credit notes to file" list in the Control Center.
const markCreditNoteIssued = async (orderId, actorId, actorRole, branchId, reference) => {
  const ref = typeof reference === 'string' ? reference.trim().toUpperCase() : '';
  if (ref.length < 3 || ref.length > 60) {
    throw new AppError('Enter the credit-note reference KRA gave (3-60 characters)', 400, 'CREDIT_NOTE_REF_REQUIRED');
  }
  const query = { _id: orderId };
  if (branchId) query.branchId = branchId;
  const order = await Order.findOne(query).select('orderRef branchId etimsCreditNoteStatus').lean();
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  if (order.etimsCreditNoteStatus !== 'required') {
    throw new AppError('This order has no credit note waiting to be filed', 400, 'NO_CREDIT_NOTE_REQUIRED');
  }
  const done = await Order.findOneAndUpdate(
    { _id: orderId, etimsCreditNoteStatus: 'required' },
    { $set: { etimsCreditNoteStatus: 'issued', etimsCreditNoteRef: ref, etimsCreditNoteAt: new Date() } },
    { new: true }
  );
  if (!done) throw new AppError('This credit note has already been recorded', 409, 'CREDIT_NOTE_ALREADY_RECORDED');
  await activityLogService.log({
    actorId,
    actorRole,
    action: LOG_ACTIONS.ETIMS_CREDIT_NOTE_ISSUED,
    branchId: order.branchId,
    targetId: order._id,
    targetType: 'Order',
    detail: { orderRef: order.orderRef, creditNoteRef: ref },
  });
  return done;
};

const assignDriver = async (orderId, driverId, adminId, branchId, actorRole = 'admin') => {
  // Everything the code after the commit needs (activity log, dispatch/reassign events) is
  // returned from the transaction - it must not be read from variables assigned inside a
  // callback that may run more than once.
  const { order, driver, dispatchedNow, previousDriverId } = await runTransaction(async (session) => {
    const order = await Order.findOne({ _id: orderId, branchId }).session(session);
    if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');

    if (order.deliveryMethod !== 'delivery') {
      throw new AppError('Cannot assign a driver to a pickup order', 400, 'NOT_DELIVERY_ORDER');
    }

    const allowed = [ORDER_STATUSES.PREPARING, ORDER_STATUSES.OUT_FOR_DELIVERY];
    if (!allowed.includes(order.status)) {
      throw new AppError(`Driver can only be assigned when order is preparing or out for delivery`, 400, 'INVALID_ORDER_STATUS');
    }

    const driver = await User.findOne({ _id: driverId, role: ROLES.DRIVER, branchId }).session(session);
    if (!driver) throw new AppError('Driver not found in this branch', 404, 'DRIVER_NOT_FOUND');
    // A locked driver can't log in to see or complete the delivery — assigning
    // them strands the order. (isAvailableForDelivery stays a soft preference;
    // the admin UI already filters on it but may deliberately override.)
    if (driver.isLocked) {
      throw new AppError('This driver\'s account is locked and cannot take deliveries', 400, 'DRIVER_LOCKED');
    }

    // Captured BEFORE the overwrite so a reassignment can be detected afterwards
    // and the driver being replaced can be told to stand down (see the emit at
    // the end of this function).
    const previousDriverId = order.driverId ? String(order.driverId) : null;
    order.driverId = driverId;

    // Auto-advance: preparing → out_for_delivery when driver is first assigned
    const dispatchedNow = order.status === ORDER_STATUSES.PREPARING;
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
    return { order, driver, dispatchedNow, previousDriverId };
  });

  await activityLogService.log({
    actorId: adminId,
    actorRole,
    action: LOG_ACTIONS.DRIVER_ASSIGNED_TO_ORDER,
    branchId,
    targetId: order._id,
    targetType: 'Order',
    detail: { orderRef: order.orderRef, driverId, driverName: driver.name, previousDriverId: previousDriverId || undefined }
  });

  // Notify customer only when this call actually transitioned the order to
  // out_for_delivery — reassigning a driver on an already-dispatched order
  // must not re-send the "on the way" SMS/email.
  if (dispatchedNow) {
    appEvents.emit(ORDER_EVENTS.DISPATCHED, { order, branchId });
  }

  // A genuine reassignment (a different driver than the one currently holding it)
  // is emitted separately from DISPATCHED, for the opposite audience: the
  // customer must NOT be re-notified, but the previous driver MUST be told to
  // stand down. Without this their own order list simply loses the order on the
  // next refresh, with no explanation, possibly while already en route.
  if (previousDriverId && previousDriverId !== String(driverId)) {
    let previousDriver = null;
    try {
      previousDriver = await User.findOne({ _id: previousDriverId }).select('name phone').lean();
    } catch {
      // Notification is best-effort — a failed lookup must not fail the assignment.
    }
    if (previousDriver) {
      appEvents.emit(ORDER_EVENTS.REASSIGNED, { order, branchId, previousDriver });
    }
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

  // Aggregation pipelines are NOT cast by Mongoose — userId arrives as the JWT's
  // string id, and matching a string against the ObjectId-typed field silently
  // returns nothing (every customer's dashboard stats read as zero).
  const userObjectId = new mongoose.Types.ObjectId(String(userId));

  const [result] = await Order.aggregate([
    { $match: { userId: userObjectId, status: { $in: COUNTED_STATUSES } } },
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
  markCreditNoteIssued,
  cancel,
  bulkApprove,
  bulkReject,
  getPackingSlip,
  assignDriver,
  autoCancelExpiredPendingOrders,
};
