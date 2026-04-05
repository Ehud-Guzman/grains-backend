// ── PAYMENT SERVICE ───────────────────────────────────────────────────────────
// Handles M-Pesa STK Push initiation, callback processing,
// manual confirmation, and timeout handling

const axios = require('axios');
const Payment = require('../models/Payment');
const Order   = require('../models/Order');
const { AppError } = require('../middleware/errorHandler.middleware');
const { PAYMENT_STATUSES, PAYMENT_METHODS, LOG_ACTIONS } = require('../utils/constants');
const activityLogService = require('./activityLog.service');
const { getDarajaToken, getUrls } = require('../config/mpesa.config');
const {
  formatPhone,
  generateTimestamp,
  generatePassword,
  parseCallbackMetadata
} = require('../utils/mpesaHelpers');

// ── INITIATE STK PUSH ─────────────────────────────────────────────────────────
const initiateStkPush = async (orderId, phone) => {
  const order = await Order.findById(orderId);
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');

  if (order.paymentStatus === PAYMENT_STATUSES.PAID) {
    throw new AppError('This order has already been paid', 400, 'ALREADY_PAID');
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
    TransactionType:   'CustomerPayBillOnline',
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
    const msg = err.response?.data?.errorMessage || err.message;
    console.error('[M-PESA] STK push failed:', msg);
    throw new AppError(`M-Pesa request failed: ${msg}`, 502, 'MPESA_REQUEST_FAILED');
  }

  const { CheckoutRequestID, MerchantRequestID, ResponseCode, ResponseDescription } = darajaResponse.data;

  if (ResponseCode !== '0') {
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

  // Link payment to order
  await Order.findByIdAndUpdate(orderId, {
    paymentId:     payment._id,
    paymentStatus: PAYMENT_STATUSES.PENDING
  });

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
    console.warn('[M-PESA] Invalid callback structure received');
    return { success: false, message: 'Invalid callback structure' };
  }

  const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = body;

  // Find the payment by checkoutRequestId
  const payment = await Payment.findOne({ checkoutRequestId: CheckoutRequestID });
  if (!payment) {
    console.warn(`[M-PESA] Callback for unknown CheckoutRequestID: ${CheckoutRequestID}`);
    return { success: false, message: 'Payment record not found' };
  }

  // IDEMPOTENCY — if already processed, do nothing
  if (payment.status === PAYMENT_STATUSES.PAID) {
    console.log(`[M-PESA] Duplicate callback for already-paid: ${CheckoutRequestID}`);
    return { success: true, message: 'Already processed' };
  }

  if (ResultCode === 0) {
    // ── SUCCESS ──────────────────────────────────────────────────────────────
    const metadata = parseCallbackMetadata(CallbackMetadata?.Item || []);
    const mpesaTransactionId = metadata.MpesaReceiptNumber;
    const paidAmount         = metadata.Amount;

    // Verify Safaricom paid the correct amount — reject underpayments
    if (!paidAmount || Math.ceil(paidAmount) < Math.ceil(payment.amount)) {
      console.warn(
        `[M-PESA] Amount mismatch on ${CheckoutRequestID}: expected ${payment.amount}, got ${paidAmount}`
      );
      await Payment.findByIdAndUpdate(payment._id, { status: PAYMENT_STATUSES.FAILED });
      await Order.findByIdAndUpdate(payment.orderId, { paymentStatus: PAYMENT_STATUSES.FAILED });
      await activityLogService.log({
        actorId:    payment.orderId,
        actorRole:  'customer',
        action:     LOG_ACTIONS.PAYMENT_FAILED,
        targetId:   payment._id,
        targetType: 'Payment',
        detail:     { reason: 'AMOUNT_MISMATCH', expected: payment.amount, received: paidAmount }
      }).catch(() => {});
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
    }).catch(() => {});

    console.log(`[M-PESA] Payment confirmed: ${mpesaTransactionId} for order ${payment.orderId}`);
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
    }).catch(() => {});

    console.log(`[M-PESA] Payment failed (code ${ResultCode}): ${ResultDesc}`);
    return { success: false, status: 'failed', resultCode: ResultCode, resultDesc: ResultDesc };
  }
};

// ── CHECK PAYMENT STATUS ──────────────────────────────────────────────────────
// Used by frontend polling every 5 seconds after STK push
const checkPaymentStatus = async (orderId) => {
  const order = await Order.findById(orderId).select('paymentStatus paymentId orderRef total');
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');

  const payment = order.paymentId
    ? await Payment.findById(order.paymentId).select('status mpesaTransactionId mpesaPhone amount')
    : null;

  return {
    orderId:           order._id,
    orderRef:          order.orderRef,
    paymentStatus:     order.paymentStatus,
    total:             order.total,
    mpesaTransactionId: payment?.mpesaTransactionId || null,
    mpesaPhone:        payment?.mpesaPhone || null
  };
};

// ── MANUAL PAYMENT CONFIRMATION ───────────────────────────────────────────────
// Admin fallback when M-Pesa callback was lost
const manualConfirmPayment = async (orderId, adminId, transactionRef) => {
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
      status:            PAYMENT_STATUSES.PAID,
      mpesaTransactionId: transactionRef || null,
      confirmedBy:       adminId,
      paidAt:            new Date()
    });
  } else {
    payment = await Payment.create({
      orderId:            order._id,
      method:             PAYMENT_METHODS.MPESA,
      amount:             order.total,
      currency:           'KES',
      status:             PAYMENT_STATUSES.PAID,
      mpesaTransactionId: transactionRef || null,
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
    actorRole:  'admin',
    action:     LOG_ACTIONS.PAYMENT_MANUALLY_CONFIRMED,
    targetId:   payment._id,
    targetType: 'Payment',
    detail:     { orderId, transactionRef }
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
    console.log(`[M-PESA] Payment timed out for order ${order.orderRef}`);
  }
};

module.exports = {
  initiateStkPush,
  handleCallback,
  checkPaymentStatus,
  manualConfirmPayment,
  handleTimeout
};