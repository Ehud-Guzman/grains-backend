// ── PAYMENT SERVICE ───────────────────────────────────────────────────────────
// Handles M-Pesa STK Push initiation, callback processing,
// manual confirmation, and timeout handling

const axios = require('axios');
const Payment = require('../models/Payment');
const Order   = require('../models/Order');
const { AppError } = require('../middleware/errorHandler.middleware');
const { PAYMENT_STATUSES, PAYMENT_METHODS, LOG_ACTIONS, ROLES, MPESA_RECEIPT_REGEX } = require('../utils/constants');
const activityLogService = require('./activityLog.service');
const { getDarajaToken, getUrls } = require('../config/mpesa.config');
const logger = require('../utils/logger');
const {
  formatPhone,
  generateTimestamp,
  generatePassword,
  parseCallbackMetadata
} = require('../utils/mpesaHelpers');

// ── INITIATE STK PUSH ─────────────────────────────────────────────────────────
const initiateStkPush = async (orderId, phone) => {
  // Atomic guard: flip paymentStatus → PENDING only if the order is not already
  // PAID or PENDING. This prevents two concurrent requests both passing the check
  // and issuing two STK pushes to the customer's phone.
  const order = await Order.findOneAndUpdate(
    { _id: orderId, paymentStatus: { $nin: [PAYMENT_STATUSES.PAID, PAYMENT_STATUSES.PENDING] } },
    { $set: { paymentStatus: PAYMENT_STATUSES.PENDING } },
    { new: true }
  );

  if (!order) {
    const existing = await Order.findById(orderId).select('paymentStatus').lean();
    if (!existing) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
    if (existing.paymentStatus === PAYMENT_STATUSES.PAID)
      throw new AppError('This order has already been paid', 400, 'ALREADY_PAID');
    throw new AppError(
      'A payment is already in progress for this order. Please wait for it to complete.',
      400,
      'PAYMENT_IN_PROGRESS'
    );
  }

  // Always derive amount from the order — never trust client-supplied values
  const amount = order.total;
  if (!amount || amount <= 0) {
    throw new AppError('Order has an invalid total amount', 400, 'INVALID_ORDER_AMOUNT');
  }

  const shortcode  = process.env.MPESA_SHORTCODE;
  const passkey    = process.env.MPESA_PASSKEY;
  const callbackURL = process.env.MPESA_CALLBACK_URL;

  if (!shortcode || !passkey || !callbackURL) {
    throw new AppError('M-Pesa is not configured. Please contact support.', 503, 'MPESA_NOT_CONFIGURED');
  }

  const formattedPhone = formatPhone(phone);
  const timestamp      = generateTimestamp();
  const password       = generatePassword(shortcode, passkey, timestamp);
  const token          = await getDarajaToken();

  const payload = {
    BusinessShortCode: shortcode,
    Password:          password,
    Timestamp:         timestamp,
    TransactionType:   process.env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline',
    Amount:            Math.ceil(amount), // M-Pesa requires whole numbers
    PartyA:            formattedPhone,
    PartyB:            shortcode,
    PhoneNumber:       formattedPhone,
    CallBackURL:       callbackURL,
    AccountReference:  order.orderRef,
    TransactionDesc:   `Payment for ${order.orderRef}`
  };

  let darajaResponse;
  try {
    darajaResponse = await axios.post(getUrls().stkpush, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
  } catch (err) {
    // Reset paymentStatus so the customer can retry
    await Order.findByIdAndUpdate(orderId, { paymentStatus: PAYMENT_STATUSES.FAILED })
      .catch(resetErr => logger.error('[M-PESA] Failed to reset paymentStatus after STK error', { orderId, err: resetErr.message }));
    const msg = err.response?.data?.errorMessage || err.message;
    logger.error('[M-PESA] STK push failed', { orderId, msg });
    throw new AppError(`M-Pesa request failed: ${msg}`, 502, 'MPESA_REQUEST_FAILED');
  }

  const { CheckoutRequestID, MerchantRequestID, ResponseCode, ResponseDescription } = darajaResponse.data;

  if (ResponseCode !== '0') {
    await Order.findByIdAndUpdate(orderId, { paymentStatus: PAYMENT_STATUSES.FAILED })
      .catch(resetErr => logger.error('[M-PESA] Failed to reset paymentStatus after rejection', { orderId, err: resetErr.message }));
    throw new AppError(`M-Pesa rejected the request: ${ResponseDescription}`, 502, 'MPESA_REJECTED');
  }

  // Create Payment record
  const payment = await Payment.create({
    orderId:           order._id,
    method:            PAYMENT_METHODS.MPESA,
    mpesaPhone:        formattedPhone,
    checkoutRequestId: CheckoutRequestID,
    amount:            Math.ceil(amount),
    currency:          'KES',
    status:            PAYMENT_STATUSES.PENDING
  });

  // Link payment to order (paymentStatus already set to PENDING by the atomic guard above)
  await Order.findByIdAndUpdate(orderId, { paymentId: payment._id });

  return {
    checkoutRequestId: CheckoutRequestID,
    merchantRequestId: MerchantRequestID,
    paymentId:         payment._id
  };
};

// ── HANDLE SAFARICOM CALLBACK ─────────────────────────────────────────────────
const handleCallback = async (callbackData) => {
  const body = callbackData?.Body?.stkCallback;
  if (!body) {
    logger.warn('[M-PESA] Invalid callback structure received');
    return { success: false, message: 'Invalid callback structure' };
  }

  const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = body;

  // Find the payment by checkoutRequestId
  const payment = await Payment.findOne({ checkoutRequestId: CheckoutRequestID });
  if (!payment) {
    logger.warn('[M-PESA] Callback for unknown CheckoutRequestID', { CheckoutRequestID });
    return { success: false, message: 'Payment record not found' };
  }

  // IDEMPOTENCY — if already in a terminal state (paid or failed), do nothing
  if (payment.status === PAYMENT_STATUSES.PAID || payment.status === PAYMENT_STATUSES.FAILED) {
    logger.info('[M-PESA] Duplicate callback ignored — already in terminal state', { CheckoutRequestID, status: payment.status });
    return { success: true, message: 'Already processed' };
  }

  if (ResultCode === 0) {
    // ── SUCCESS ──────────────────────────────────────────────────────────────
    const metadata = parseCallbackMetadata(CallbackMetadata?.Item || []);
    const mpesaTransactionId = metadata.MpesaReceiptNumber;
    const paidAmount         = metadata.Amount;

    // Verify Safaricom paid the correct amount — reject underpayments
    if (!paidAmount || Math.ceil(paidAmount) < Math.ceil(payment.amount)) {
      logger.warn('[M-PESA] Amount mismatch', {
        CheckoutRequestID,
        expected: payment.amount,
        received: paidAmount
      });
      await Payment.findByIdAndUpdate(payment._id, { status: PAYMENT_STATUSES.FAILED });
      await Order.findByIdAndUpdate(payment.orderId, { paymentStatus: PAYMENT_STATUSES.FAILED });
      await activityLogService.log({
        actorId:    payment.orderId,
        actorRole:  'customer',
        action:     LOG_ACTIONS.PAYMENT_FAILED,
        targetId:   payment._id,
        targetType: 'Payment',
        detail:     { reason: 'AMOUNT_MISMATCH', expected: payment.amount, received: paidAmount }
      }).catch(err => logger.error('[M-PESA] Activity log failed on amount mismatch', { err: err.message }));
      return { success: false, status: 'failed', resultCode: 'AMOUNT_MISMATCH' };
    }

    await Payment.findByIdAndUpdate(payment._id, {
      status:            PAYMENT_STATUSES.PAID,
      mpesaTransactionId,
      paidAt:            new Date()
    });

    await Order.findByIdAndUpdate(payment.orderId, {
      paymentStatus: PAYMENT_STATUSES.PAID
    });

    await activityLogService.log({
      actorId:    payment.orderId,
      actorRole:  'customer',
      action:     LOG_ACTIONS.PAYMENT_CONFIRMED,
      targetId:   payment._id,
      targetType: 'Payment',
      detail:     { mpesaTransactionId, amount: paidAmount }
    }).catch(err => logger.error('[M-PESA] Activity log failed on payment confirmed', { err: err.message }));

    logger.info('[M-PESA] Payment confirmed', { mpesaTransactionId, orderId: payment.orderId });
    return { success: true, status: 'paid', mpesaTransactionId };

  } else {
    // ── FAILURE ───────────────────────────────────────────────────────────────
    // Common result codes:
    // 1032 — cancelled by user
    // 1037 — timeout waiting for user
    // 1    — insufficient funds
    // 2001 — wrong PIN

    await Payment.findByIdAndUpdate(payment._id, {
      status: PAYMENT_STATUSES.FAILED
    });

    await Order.findByIdAndUpdate(payment.orderId, {
      paymentStatus: PAYMENT_STATUSES.FAILED
    });

    await activityLogService.log({
      actorId:    payment.orderId,
      actorRole:  'customer',
      action:     LOG_ACTIONS.PAYMENT_FAILED,
      targetId:   payment._id,
      targetType: 'Payment',
      detail:     { resultCode: ResultCode, resultDesc: ResultDesc }
    }).catch(err => logger.error('[M-PESA] Activity log failed on payment failed', { err: err.message }));

    logger.info('[M-PESA] Payment failed', { resultCode: ResultCode, resultDesc: ResultDesc, orderId: payment.orderId });
    return { success: false, status: 'failed', resultCode: ResultCode, resultDesc: ResultDesc };
  }
};

// ── CHECK PAYMENT STATUS ──────────────────────────────────────────────────────
// Used by frontend polling every 5 seconds after STK push
const ADMIN_ROLES = [ROLES.STAFF, ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.SUPERADMIN];

const checkPaymentStatus = async (orderId, requestingUser) => {
  const order = await Order.findById(orderId).select('paymentStatus paymentId orderRef total userId');
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');

  // Ownership check — only the order owner or admin-tier roles may poll payment status.
  // Return 404 (not 403) to avoid leaking whether the order ID exists at all.
  if (!ADMIN_ROLES.includes(requestingUser.role)) {
    if (!order.userId || order.userId.toString() !== requestingUser.id.toString()) {
      throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
    }
  }

  const payment = order.paymentId
    ? await Payment.findById(order.paymentId).select('status mpesaTransactionId mpesaPhone amount')
    : null;

  return {
    orderId:            order._id,
    orderRef:           order.orderRef,
    paymentStatus:      order.paymentStatus,
    total:              order.total,
    mpesaTransactionId: payment?.mpesaTransactionId || null,
    mpesaPhone:         payment?.mpesaPhone || null
  };
};

// ── MANUAL PAYMENT CONFIRMATION ───────────────────────────────────────────────
// Admin fallback when M-Pesa callback was lost.
// Requires a real M-Pesa receipt number — format validated and uniqueness enforced.

const manualConfirmPayment = async (orderId, adminId, transactionRef, actorRole = 'supervisor') => {
  // Require a non-empty transaction reference
  if (!transactionRef || typeof transactionRef !== 'string' || !transactionRef.trim()) {
    throw new AppError(
      'M-Pesa transaction reference is required for manual confirmation',
      400,
      'TRANSACTION_REF_REQUIRED'
    );
  }

  const ref = transactionRef.trim().toUpperCase();

  // Validate M-Pesa receipt format: exactly 10 uppercase alphanumeric characters (e.g. QDK14KSHD7)
  if (!MPESA_RECEIPT_REGEX.test(ref)) {
    throw new AppError(
      'Invalid M-Pesa transaction reference. Expected 10 uppercase alphanumeric characters (e.g. QDK14KSHD7)',
      400,
      'INVALID_TRANSACTION_REF'
    );
  }

  // Prevent reuse — a receipt number must map to exactly one order
  const duplicate = await Payment.findOne({ mpesaTransactionId: ref });
  if (duplicate) {
    throw new AppError(
      'This M-Pesa transaction reference has already been used on another payment',
      409,
      'DUPLICATE_TRANSACTION_REF'
    );
  }

  const order = await Order.findById(orderId);
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');

  if (order.paymentStatus === PAYMENT_STATUSES.PAID) {
    throw new AppError('Payment is already confirmed', 400, 'ALREADY_PAID');
  }

  // Update or create payment record
  let payment = order.paymentId
    ? await Payment.findById(order.paymentId)
    : null;

  if (payment) {
    await Payment.findByIdAndUpdate(payment._id, {
      status:             PAYMENT_STATUSES.PAID,
      mpesaTransactionId: ref,
      confirmedBy:        adminId,
      paidAt:             new Date()
    });
  } else {
    payment = await Payment.create({
      orderId:            order._id,
      method:             PAYMENT_METHODS.MPESA,
      amount:             order.total,
      currency:           'KES',
      status:             PAYMENT_STATUSES.PAID,
      mpesaTransactionId: ref,
      confirmedBy:        adminId,
      paidAt:             new Date()
    });
  }

  await Order.findByIdAndUpdate(orderId, {
    paymentStatus: PAYMENT_STATUSES.PAID,
    paymentId:     payment._id
  });

  await activityLogService.log({
    actorId:    adminId,
    actorRole,
    action:     LOG_ACTIONS.PAYMENT_MANUALLY_CONFIRMED,
    targetId:   payment._id,
    targetType: 'Payment',
    detail:     { orderId, transactionRef: ref }
  });

  return payment;
};

// ── HANDLE TIMEOUT ────────────────────────────────────────────────────────────
// Called after 120s if no callback received
const handleTimeout = async (orderId) => {
  const order = await Order.findById(orderId);
  if (!order || order.paymentStatus !== PAYMENT_STATUSES.PENDING) return;

  const payment = order.paymentId
    ? await Payment.findById(order.paymentId)
    : null;

  if (payment && payment.status === PAYMENT_STATUSES.PENDING) {
    await Payment.findByIdAndUpdate(payment._id, { status: PAYMENT_STATUSES.FAILED });
    await Order.findByIdAndUpdate(orderId, { paymentStatus: PAYMENT_STATUSES.FAILED });
    logger.info('[M-PESA] Payment timed out', { orderRef: order.orderRef, orderId });
  }
};

module.exports = {
  initiateStkPush,
  handleCallback,
  checkPaymentStatus,
  manualConfirmPayment,
  handleTimeout
};
