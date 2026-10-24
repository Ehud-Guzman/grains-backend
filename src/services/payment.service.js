// ── PAYMENT SERVICE ───────────────────────────────────────────────────────────
// Handles M-Pesa STK Push initiation, callback processing, and manual confirmation

const axios = require('axios');
const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const Order   = require('../models/Order');
const { AppError } = require('../middleware/errorHandler.middleware');
const { PAYMENT_STATUSES, PAYMENT_METHODS, LOG_ACTIONS, ROLES, MPESA_RECEIPT_REGEX } = require('../utils/constants');
const activityLogService = require('./activityLog.service');
const etimsService       = require('./etims.service');
const alertService       = require('./alert.service');
const settingsService    = require('./settings.service');
const { getDarajaToken, getUrls } = require('../config/mpesa.config');
const logger = require('../utils/logger');
const { appEvents, ORDER_EVENTS } = require('../events/appEvents');
const { runTransaction } = require('../utils/transaction');
const {
  formatPhone,
  generateTimestamp,
  generatePassword,
  parseCallbackMetadata,
  toAccountReference,
  STK_TRANSACTION_DESC
} = require('../utils/mpesaHelpers');

// Safaricom's TransactionDate is YYYYMMDDHHMMSS in Nairobi time. Returns null when absent/garbled.
const parseSafaricomTimestamp = (value) => {
  if (!value) return null;
  const raw = String(value);
  const parsed = new Date(
    `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}T${raw.slice(8,10)}:${raw.slice(10,12)}:${raw.slice(12,14)}`
  );
  return isNaN(parsed.getTime()) ? null : parsed;
};

// How many STK prompts one phone number may be sent in a window, whoever asks. The per-IP limiter
// stops one machine hammering the endpoint, but a prompt lands on the VICTIM's handset: a handful of
// addresses (or a botnet) could still spam any number. A genuine customer who cancels or mistypes
// needs two or three tries, not more than five in ten minutes.
const STK_PHONE_WINDOW_MS = 10 * 60 * 1000;
const STK_PHONE_MAX_PROMPTS = 5;

// Tells the customer their payment landed. Fire-and-forget: a lookup or listener
// failure must never fail a payment that has already been recorded.
const emitOrderPaid = (orderId) => {
  Order.findById(orderId).lean()
    .then(order => { if (order) appEvents.emit(ORDER_EVENTS.PAID, { order, branchId: order.branchId }); })
    .catch(err => logger.error('[payment] order:paid event failed', { orderId, err: err.message }));
};

// ── INITIATE STK PUSH ─────────────────────────────────────────────────────────
const NON_PAYABLE_ORDER_STATUSES = ['cancelled', 'rejected', 'completed'];

const initiateStkPush = async (orderId, phone) => {
  const reservedPaymentId = new mongoose.Types.ObjectId();

  // Everything that can fail WITHOUT touching the order is checked before the
  // atomic claim below. The claim flips paymentStatus to PENDING and points the
  // order at a Payment document that does not exist yet — if a config or amount
  // check threw after that, nothing reset it, and every retry answered
  // PAYMENT_IN_PROGRESS forever (the stale-retry path needs a real Payment doc).
  const candidate = await Order.findById(orderId).select('status paymentMethod total').lean();
  if (!candidate) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  if (NON_PAYABLE_ORDER_STATUSES.includes(candidate.status)) {
    throw new AppError(`This order is ${candidate.status} and can no longer be paid`, 400, 'ORDER_NOT_PAYABLE');
  }
  if (candidate.paymentMethod !== PAYMENT_METHODS.MPESA) {
    throw new AppError('This order is not set to pay by M-Pesa', 400, 'NOT_MPESA_ORDER');
  }
  if (!candidate.total || candidate.total <= 0) {
    throw new AppError('Order has an invalid total amount', 400, 'INVALID_ORDER_AMOUNT');
  }
  const shortcode   = process.env.MPESA_SHORTCODE;
  const passkey     = process.env.MPESA_PASSKEY;
  const callbackURL = process.env.MPESA_CALLBACK_URL;
  if (!shortcode || !passkey || !callbackURL) {
    throw new AppError('M-Pesa payment is temporarily unavailable. Please try again shortly, or contact us to pay another way.', 503, 'MPESA_NOT_CONFIGURED');
  }
  let formattedPhone;
  try {
    if (typeof phone !== 'string') throw new Error('phone must be text');
    formattedPhone = formatPhone(phone);
  } catch {
    throw new AppError('Enter a valid Kenyan phone number', 400, 'INVALID_PHONE');
  }

  // Checked before the claim below, like the other pre-flight checks: a refusal here must leave the
  // order exactly as it was.
  const recentPrompts = await Payment.countDocuments({
    method: PAYMENT_METHODS.MPESA,
    mpesaPhone: formattedPhone,
    createdAt: { $gte: new Date(Date.now() - STK_PHONE_WINDOW_MS) }
  });
  if (recentPrompts >= STK_PHONE_MAX_PROMPTS) {
    throw new AppError(
      'Several payment prompts have already been sent to this phone number. Please wait a few minutes before trying again.',
      429,
      'TOO_MANY_PROMPTS'
    );
  }

  // Atomic guard: flip paymentStatus to PENDING only if the order is not already
  // PAID or PENDING. This prevents two concurrent requests both passing the check
  // and issuing two STK pushes to the customer's phone.
  let order = await Order.findOneAndUpdate(
    { _id: orderId, paymentStatus: { $nin: [PAYMENT_STATUSES.PAID, PAYMENT_STATUSES.PENDING] } },
    { $set: { paymentStatus: PAYMENT_STATUSES.PENDING, paymentId: reservedPaymentId } },
    { new: true }
  );

  if (!order) {
    const existing = await Order.findById(orderId).select('paymentStatus paymentId').lean();
    if (!existing) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
    if (existing.paymentStatus === PAYMENT_STATUSES.PAID)
      throw new AppError('This order has already been paid', 400, 'ALREADY_PAID');

    // Compatibility for orders created before UNPAID existed: they may be
    // pending with no Payment record. Claim exactly that shape once.
    if (existing.paymentStatus === PAYMENT_STATUSES.PENDING && !existing.paymentId) {
      order = await Order.findOneAndUpdate(
        { _id: orderId, paymentStatus: PAYMENT_STATUSES.PENDING, paymentId: null },
        { $set: { paymentId: reservedPaymentId } },
        { new: true }
      );
    }

    // Retry after countdown expiry: the frontend countdown is 60 seconds, so any
    // pending payment older than 90 s is stale (Safaricom never called back, or the
    // callback URL was unreachable in dev). Atomically swap to the new payment ID so
    // only one retry wins; mark the old record failed fire-and-forget.
    if (!order && existing.paymentStatus === PAYMENT_STATUSES.PENDING && existing.paymentId) {
      const STALE_MS = 90_000;
      const oldPayment = await Payment.findById(existing.paymentId).select('createdAt').lean();
      // A claim whose Payment document never got created (crash between the claim and
      // Payment.create) can never be completed by a callback — treat it as stale.
      const ageMs = oldPayment ? Date.now() - new Date(oldPayment.createdAt).getTime() : Infinity;

      if (ageMs >= STALE_MS) {
        // Atomically claim the slot by swapping to the new paymentId.
        order = await Order.findOneAndUpdate(
          { _id: orderId, paymentStatus: PAYMENT_STATUSES.PENDING, paymentId: existing.paymentId },
          { $set: { paymentId: reservedPaymentId } },
          { new: true }
        );
        // Mark the old payment FAILED so a late Safaricom callback for the
        // first STK push doesn't create a second PAID record for the same order.
        if (order) {
          await Payment.findByIdAndUpdate(existing.paymentId, {
            status: PAYMENT_STATUSES.FAILED
          }).catch(err => logger.error('[M-PESA] Failed to mark stale payment failed', { paymentId: existing.paymentId, err: err.message }));
        }
      }
    }
  }

  if (!order) {
    throw new AppError(
      'A payment is already in progress for this order. Please wait for it to complete.',
      400,
      'PAYMENT_IN_PROGRESS'
    );
  }

  // Always derive amount from the order — never trust client-supplied values
  const amount = order.total;

  let payment;
  try {
    payment = await Payment.create({
      _id:               reservedPaymentId,
      orderId:           order._id,
      branchId:          order.branchId,
      method:            PAYMENT_METHODS.MPESA,
      mpesaPhone:        formattedPhone,
      amount:            Math.ceil(amount),
      currency:          'KES',
      status:            PAYMENT_STATUSES.PENDING
    });
  } catch (err) {
    await Order.findByIdAndUpdate(orderId, {
      paymentStatus: PAYMENT_STATUSES.FAILED,
      $unset: { paymentId: '' }
    }).catch(resetErr => logger.error('[M-PESA] Failed to reset payment after reservation error', { orderId, err: resetErr.message }));
    throw err;
  }

  const timestamp      = generateTimestamp();
  const password       = generatePassword(shortcode, passkey, timestamp);

  let token;
  try {
    token = await getDarajaToken();
  } catch (err) {
    await Payment.findByIdAndUpdate(payment._id, { status: PAYMENT_STATUSES.FAILED })
      .catch(resetErr => logger.error('[M-PESA] Failed to mark payment failed after token error', { orderId, err: resetErr.message }));
    await Order.findByIdAndUpdate(orderId, { paymentStatus: PAYMENT_STATUSES.FAILED })
      .catch(resetErr => logger.error('[M-PESA] Failed to reset paymentStatus after token error', { orderId, err: resetErr.message }));
    logger.error('[M-PESA] Daraja token fetch failed', { orderId, msg: err.message });
    throw new AppError(`M-Pesa request failed: ${err.message}`, 502, 'MPESA_REQUEST_FAILED');
  }

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
    // Daraja limits these to 12 and 13 characters - see toAccountReference.
    AccountReference:  toAccountReference(order.orderRef),
    TransactionDesc:   STK_TRANSACTION_DESC
  };

  let darajaResponse;
  try {
    darajaResponse = await axios.post(getUrls().stkpush, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      // Netlify's /api proxy gives up on a response after ~26 s (the browser then sees a 504 while this keeps
      // running, and the customer taps pay again). Token fetch (10 s cap) + this must fit under that, so
      // give Daraja 12 s - it normally answers in 1-3 s. A slow answer is a clean 502 the customer can retry.
      timeout: Number(process.env.MPESA_STK_TIMEOUT_MS) || 12000
    });
  } catch (err) {
    // Reset paymentStatus so the customer can retry
    await Payment.findByIdAndUpdate(payment._id, { status: PAYMENT_STATUSES.FAILED })
      .catch(resetErr => logger.error('[M-PESA] Failed to mark payment failed after STK error', { orderId, err: resetErr.message }));
    await Order.findByIdAndUpdate(orderId, { paymentStatus: PAYMENT_STATUSES.FAILED })
      .catch(resetErr => logger.error('[M-PESA] Failed to reset paymentStatus after STK error', { orderId, err: resetErr.message }));
    const msg = err.response?.data?.errorMessage || err.message;
    logger.error('[M-PESA] STK push failed', { orderId, msg });
    // Counter alert: one failure is a customer problem, three in ten minutes is an outage.
    alertService.sendAlert('MPESA_STK_FAILING', { Failures: 3, Reason: msg }, 'global')
      .catch(alertErr => logger.error('[M-PESA] Alert failed', { err: alertErr.message }));
    throw new AppError(`M-Pesa request failed: ${msg}`, 502, 'MPESA_REQUEST_FAILED');
  }

  const { CheckoutRequestID, MerchantRequestID, ResponseCode, ResponseDescription } = darajaResponse.data;

  if (ResponseCode !== '0') {
    await Payment.findByIdAndUpdate(payment._id, { status: PAYMENT_STATUSES.FAILED })
      .catch(resetErr => logger.error('[M-PESA] Failed to mark payment failed after rejection', { orderId, err: resetErr.message }));
    await Order.findByIdAndUpdate(orderId, { paymentStatus: PAYMENT_STATUSES.FAILED })
      .catch(resetErr => logger.error('[M-PESA] Failed to reset paymentStatus after rejection', { orderId, err: resetErr.message }));
    throw new AppError(`M-Pesa rejected the request: ${ResponseDescription}`, 502, 'MPESA_REJECTED');
  }

  await Payment.findByIdAndUpdate(payment._id, {
    checkoutRequestId: CheckoutRequestID,
    status:            PAYMENT_STATUSES.PENDING
  });

  return {
    checkoutRequestId: CheckoutRequestID,
    merchantRequestId: MerchantRequestID,
    paymentId:         payment._id
  };
};

// ── CHANGE PAYMENT METHOD ─────────────────────────────────────────────────────
// Lets a customer move an unpaid, still-pending order between M-Pesa, pay-on-pickup
// and pay-on-delivery. Without this, "Pay on Pickup Instead" after a failed STK push
// only changed what the screen said — the order stayed M-Pesa, and the approval gate
// (M-Pesa must be paid first) meant it could never be approved. Ownership is checked
// by the caller (payment.controller), the same way as for initiate.
const STK_IN_FLIGHT_MS = 90_000;

const changePaymentMethod = async (orderId, newMethod) => {
  if (!Object.values(PAYMENT_METHODS).includes(newMethod)) {
    throw new AppError('Invalid payment method', 400, 'INVALID_PAYMENT_METHOD');
  }
  const order = await Order.findById(orderId);
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  if (order.status !== 'pending') {
    throw new AppError('Payment can only be changed while the order is awaiting approval.', 400, 'ORDER_NOT_EDITABLE');
  }
  if (order.paymentStatus === PAYMENT_STATUSES.PAID) {
    throw new AppError('This order has already been paid', 400, 'ALREADY_PAID');
  }
  if (order.paymentMethod === newMethod) return order;

  const settings = await settingsService.getSettings(order.branchId);
  if (newMethod === PAYMENT_METHODS.MPESA && !settings.allowMpesa) {
    throw new AppError('M-Pesa payments are currently unavailable.', 400, 'PAYMENT_METHOD_DISABLED');
  }
  if (newMethod === PAYMENT_METHODS.PICKUP) {
    if (!settings.allowPayOnPickup) throw new AppError('Pay on pickup is currently unavailable.', 400, 'PAYMENT_METHOD_DISABLED');
    if (order.deliveryMethod !== 'pickup') throw new AppError('Pay on pickup is only available for pickup orders.', 400, 'INVALID_PAYMENT_METHOD');
  }
  if (newMethod === PAYMENT_METHODS.DELIVERY) {
    if (!settings.allowCashOnDelivery) throw new AppError('Cash on delivery is currently unavailable.', 400, 'PAYMENT_METHOD_DISABLED');
    if (order.deliveryMethod !== 'delivery') throw new AppError('Pay on delivery is only available for delivery orders.', 400, 'INVALID_PAYMENT_METHOD');
  }

  // Don't pull the rug out from under an STK prompt the customer may be answering.
  if (order.paymentStatus === PAYMENT_STATUSES.PENDING && order.paymentId) {
    const inflight = await Payment.findById(order.paymentId).select('createdAt status').lean();
    if (inflight?.status === PAYMENT_STATUSES.PENDING
        && Date.now() - new Date(inflight.createdAt).getTime() < STK_IN_FLIGHT_MS) {
      throw new AppError('A payment prompt was just sent. Please wait a minute before changing the payment method.', 400, 'PAYMENT_IN_PROGRESS');
    }
  }

  const previous = order.paymentMethod;
  const actorId = order.userId || order.guestId;
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, status: 'pending', paymentStatus: { $ne: PAYMENT_STATUSES.PAID } },
    {
      paymentMethod: newMethod,
      paymentStatus: PAYMENT_STATUSES.UNPAID,
      paymentId: null,
      $push: {
        statusHistory: {
          status: 'pending', changedAt: new Date(), changedBy: actorId,
          note: `Payment method changed from ${previous} to ${newMethod}`
        }
      }
    },
    { new: true }
  );
  if (!updated) throw new AppError('This order can no longer be changed', 409, 'ORDER_NOT_EDITABLE');

  // Any open attempt on the old method is dead — mark it so a late callback is
  // reconciled (late-success alert) rather than silently flipping a pickup order to paid.
  if (order.paymentId) {
    await Payment.findOneAndUpdate(
      { _id: order.paymentId, status: PAYMENT_STATUSES.PENDING },
      { status: PAYMENT_STATUSES.FAILED }
    ).catch(err => logger.error('[payment] Failed to close old payment on method change', { orderId, err: err.message }));
  }

  await activityLogService.log({
    actorId,
    actorRole: order.userId ? 'customer' : 'guest',
    action: LOG_ACTIONS.PAYMENT_METHOD_CHANGED,
    branchId: order.branchId,
    targetId: order._id,
    targetType: 'Order',
    detail: { orderRef: order.orderRef, from: previous, to: newMethod }
  });

  return updated;
};

// ── A TYPED RECEIPT THAT SAFARICOM CONTRADICTS ────────────────────────────────
// A payment a person confirmed by hand carries the receipt they typed. If Safaricom's own callback then arrives with a
// DIFFERENT receipt number, one of the two is wrong (a typo, or worse). The typed one stays (it is what the order shows)
// and nothing is overwritten; the contradiction is recorded ONCE, logged and alerted, for someone to compare with the
// M-Pesa statement. Returns true when the callback's receipt differs from the typed one.
const flagReceiptMismatch = async (payment, seen) => {
  const safaricomReceipt = seen?.MpesaReceiptNumber;
  if (!safaricomReceipt || !payment.mpesaTransactionId || safaricomReceipt === payment.mpesaTransactionId) return false;
  const flagged = await Payment.findOneAndUpdate(
    { _id: payment._id, receiptMismatch: null },
    { receiptMismatch: { typedReceipt: payment.mpesaTransactionId, safaricomReceipt, amount: seen.Amount ?? null, detectedAt: new Date() } },
    { new: true }
  );
  if (flagged) {
    const mismatchOrder = await Order.findById(payment.orderId).select('branchId orderRef').lean();
    logger.error('[M-PESA] Callback receipt differs from the receipt typed at manual confirmation', {
      paymentId: payment._id, typed: payment.mpesaTransactionId, safaricom: safaricomReceipt,
    });
    await activityLogService.log({
      actorId:    payment.orderId,
      actorRole:  'customer',
      action:     LOG_ACTIONS.PAYMENT_RECEIPT_MISMATCH,
      branchId:   mismatchOrder?.branchId || null,
      targetId:   payment._id,
      targetType: 'Payment',
      detail:     { orderRef: mismatchOrder?.orderRef, typedReceipt: payment.mpesaTransactionId, safaricomReceipt, amount: seen.Amount ?? null },
    }).catch(err => logger.error('[M-PESA] Activity log failed on receipt mismatch', { err: err.message }));
    await alertService.sendAlert('MPESA_RECEIPT_MISMATCH', {
      'Order ref': mismatchOrder?.orderRef || 'unknown',
      'Typed receipt': payment.mpesaTransactionId,
      'Safaricom receipt': safaricomReceipt,
    }, String(payment._id)).catch(() => {});
  }
  return true;
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
    alertService.sendAlert('MPESA_CALLBACK_UNKNOWN', { 'Checkout request': CheckoutRequestID, 'Result code': ResultCode }, 'global')
      .catch(alertErr => logger.error('[M-PESA] Alert failed', { err: alertErr.message }));
    return { success: false, message: 'Payment record not found' };
  }

  // IDEMPOTENCY — if already in a terminal state (paid or failed), do nothing —
  // EXCEPT a success arriving for a payment already marked FAILED. That combination
  // means the money actually landed after this record was given up on (most often
  // the 90s stale-retry path in initiateStkPush already failed it and let the
  // customer start a fresh STK push). The original callback's receipt/amount must
  // not just vanish into an "already processed" no-op — capture it and alert loudly
  // so someone reconciles it, without touching this record's own status (a second
  // payment attempt may already be PAID for the same order).
  if (payment.status === PAYMENT_STATUSES.FAILED && ResultCode === 0) {
    const metadata = parseCallbackMetadata(CallbackMetadata?.Item || []);
    const mpesaTransactionId = metadata.MpesaReceiptNumber;
    const paidAmount = metadata.Amount;

    // Idempotent against duplicate deliveries of this same late callback.
    if (!payment.lateSuccessMeta) {
      await Payment.findByIdAndUpdate(payment._id, {
        lateSuccessMeta: { mpesaTransactionId, paidAmount, receivedAt: new Date() }
      });

      const staleOrder = await Order.findById(payment.orderId).select('branchId orderRef');
      logger.error('[M-PESA] Success callback for a payment already marked FAILED — money received but not reconciled', {
        CheckoutRequestID, paymentId: payment._id, orderId: payment.orderId, mpesaTransactionId, paidAmount
      });
      await activityLogService.log({
        actorId:    payment.orderId,
        actorRole:  'customer',
        action:     LOG_ACTIONS.PAYMENT_LATE_SUCCESS,
        branchId:   staleOrder?.branchId || null,
        targetId:   payment._id,
        targetType: 'Payment',
        detail:     { orderRef: staleOrder?.orderRef, mpesaTransactionId, paidAmount }
      }).catch(err => logger.error('[M-PESA] Activity log failed on late success', { err: err.message }));
      await alertService.sendAlert(
        'MPESA_LATE_SUCCESS_UNRECONCILED',
        {
          'Order ref':    staleOrder?.orderRef || 'unknown',
          'M-Pesa receipt': mpesaTransactionId || 'unknown',
          'Amount':       paidAmount,
          'Payment ID':   String(payment._id),
        },
        String(payment._id)
      ).catch(() => {});
    }
    return { success: false, status: 'late_success_unreconciled', mpesaTransactionId };
  }

  // A payment recovered by the status-query job was confirmed without a receipt number (the query
  // does not return one). If Safaricom's callback finally turns up, take the receipt from it -
  // nothing else about the payment changes. Only ever fills an empty field, so a replay is harmless.
  if (payment.status === PAYMENT_STATUSES.PAID && payment.reconciledViaQuery && !payment.mpesaTransactionId && ResultCode === 0) {
    const late = parseCallbackMetadata(CallbackMetadata?.Item || []);
    if (late.MpesaReceiptNumber) {
      await Payment.updateOne(
        { _id: payment._id, mpesaTransactionId: null },
        { $set: { mpesaTransactionId: late.MpesaReceiptNumber, safaricomTimestamp: parseSafaricomTimestamp(late.TransactionDate) } }
      ).catch(err => logger.error('[M-PESA] Could not record the late receipt number', { paymentId: payment._id, err: err.message }));
      logger.info('[M-PESA] Late callback supplied the receipt for a status-query payment', { CheckoutRequestID, mpesaTransactionId: late.MpesaReceiptNumber });
    }
    return { success: true, message: 'Receipt recorded' };
  }

  // A callback for a payment a person already confirmed by hand, carrying a DIFFERENT receipt number from the one they
  // typed. The typed one stays (it is what the order shows); but two receipts for one payment means one of them is wrong
  // (a typo, or worse), so say so once and let someone compare them with the M-Pesa statement.
  if (payment.status === PAYMENT_STATUSES.PAID && ResultCode === 0 && payment.mpesaTransactionId && !payment.receiptMismatch) {
    if (await flagReceiptMismatch(payment, parseCallbackMetadata(CallbackMetadata?.Item || []))) {
      return { success: true, message: 'Already processed', receiptMismatch: true };
    }
  }

  if (payment.status === PAYMENT_STATUSES.PAID || payment.status === PAYMENT_STATUSES.FAILED) {
    logger.info('[M-PESA] Duplicate callback ignored — already in terminal state', { CheckoutRequestID, status: payment.status });
    return { success: true, message: 'Already processed' };
  }

  if (ResultCode === 0) {
    // ── SUCCESS ──────────────────────────────────────────────────────────────
    const metadata = parseCallbackMetadata(CallbackMetadata?.Item || []);
    const mpesaTransactionId = metadata.MpesaReceiptNumber;
    const paidAmount         = metadata.Amount;

    // Parse Safaricom's TransactionDate (YYYYMMDDHHMMSS) into a JS Date
    const safaricomTimestamp = parseSafaricomTimestamp(metadata.TransactionDate);

    // Verify Safaricom paid the correct amount — reject underpayments
    if (!paidAmount || Math.ceil(paidAmount) < Math.ceil(payment.amount)) {
      // Atomic compare-and-swap on the status we read at the top of this function —
      // if a concurrent duplicate delivery of this same callback already moved the
      // payment out of that status, this is a no-op and we treat it as already handled.
      // The payment is not credited (the order is not paid), but the money DID leave the customer's phone: ResultCode 0
      // means Safaricom took it. So keep the receipt and amount where the cash-up and the integrity scan look for
      // "money that arrived but is not credited" (lateSuccessMeta), instead of letting it vanish into a log line.
      const claimed = await Payment.findOneAndUpdate(
        { _id: payment._id, status: payment.status },
        {
          status: PAYMENT_STATUSES.FAILED,
          receivedAmount: paidAmount || null,
          lateSuccessMeta: {
            mpesaTransactionId: mpesaTransactionId || null, paidAmount: paidAmount || null, expected: payment.amount,
            receivedAt: new Date(), reason: 'short_payment',
          },
        },
        { new: true }
      );
      if (!claimed) {
        logger.info('[M-PESA] Duplicate callback ignored (amount-mismatch path)', { CheckoutRequestID });
        return { success: true, message: 'Already processed' };
      }
      logger.warn('[M-PESA] Amount mismatch', {
        CheckoutRequestID,
        expected: payment.amount,
        received: paidAmount
      });
      const failedOrder = await Order.findByIdAndUpdate(payment.orderId, { paymentStatus: PAYMENT_STATUSES.FAILED }).select('branchId orderRef');
      await activityLogService.log({
        actorId:    payment.orderId,
        actorRole:  'customer',
        action:     LOG_ACTIONS.PAYMENT_FAILED,
        branchId:   failedOrder?.branchId || null,
        targetId:   payment._id,
        targetType: 'Payment',
        detail:     { reason: 'AMOUNT_MISMATCH', expected: payment.amount, received: paidAmount, mpesaTransactionId: mpesaTransactionId || null }
      }).catch(err => logger.error('[M-PESA] Activity log failed on amount mismatch', { err: err.message }));
      await alertService.sendAlert('MPESA_SHORT_PAYMENT', {
        'Order ref': failedOrder?.orderRef || 'unknown',
        'M-Pesa receipt': mpesaTransactionId || 'unknown',
        Received: paidAmount ?? 'unknown',
        Expected: payment.amount,
      }, String(payment._id)).catch(() => {});
      return { success: false, status: 'failed', resultCode: 'AMOUNT_MISMATCH' };
    }

    // Log overpayments for manual reconciliation — do not reject, but flag them
    if (Math.ceil(paidAmount) > Math.ceil(payment.amount)) {
      logger.warn('[M-PESA] Overpayment received — manual reconciliation required', {
        orderId:  payment.orderId,
        expected: payment.amount,
        received: paidAmount,
        surplus:  Math.ceil(paidAmount) - Math.ceil(payment.amount)
      });
    }

    // Decide AND apply the outcome in one transaction, reading the order's status INSIDE it.
    //
    // 2026-10 audit (F-04): the terminal-status check used to run outside the transaction that marks the
    // payment paid. A customer cancelling (or staff rejecting) in the gap left a cancelled order showing
    // `paymentStatus: paid`, a paid Payment, released stock and no refund flagged - money taken for nothing,
    // and nobody told. Both branches below write the order document, so a concurrent cancel/reject (which
    // writes it too) conflicts with this transaction; runTransaction re-runs it and the re-read sees the
    // new status. Whichever commits first, the other sees it: either the order is paid and the cancel
    // refunds it, or the order is closed and the payment is recorded as refunded here.
    const outcome = await runTransaction(async (session) => {
      const fresh = await Payment.findById(payment._id).session(session).select('status');
      if (!fresh || fresh.status !== payment.status) return { duplicate: true };

      const order = await Order.findById(payment.orderId).session(session).select('status branchId orderRef');
      if (order && ['cancelled', 'rejected'].includes(order.status)) {
        const refunded = await Payment.findOneAndUpdate(
          { _id: payment._id, status: payment.status },
          {
            status:             PAYMENT_STATUSES.REFUNDED,
            mpesaTransactionId,
            receivedAmount:     paidAmount,
            paidAt:             new Date(),
            safaricomTimestamp,
            refundedAt:         new Date(),
            refundReason:       `Order was ${order.status} before payment confirmed`
          },
          { new: true, session }
        );
        if (!refunded) return { duplicate: true };
        // Surface the refund-owed state on the order too, otherwise the admin list shows the closed
        // order's old paymentStatus with no hint that money arrived and must be returned.
        await Order.updateOne({ _id: payment.orderId }, { paymentStatus: PAYMENT_STATUSES.REFUNDED }, { session });
        return { closed: true, orderStatus: order.status, branchId: order.branchId, orderRef: order.orderRef };
      }

      // Payment and Order flip to PAID together. As two independent writes a crash between them left a
      // paid Payment on an order still showing unpaid (and the eTIMS/approval gates then never opened).
      const claimed = await Payment.findOneAndUpdate(
        { _id: payment._id, status: payment.status },
        {
          status:            PAYMENT_STATUSES.PAID,
          mpesaTransactionId,
          receivedAmount:    paidAmount,
          paidAt:            new Date(),
          safaricomTimestamp
        },
        { new: true, session }
      );
      if (!claimed) return { duplicate: true };
      await Order.updateOne({ _id: payment.orderId }, { paymentStatus: PAYMENT_STATUSES.PAID }, { session });
      return { paid: true, branchId: order?.branchId || null };
    });

    if (outcome.duplicate) {
      logger.info('[M-PESA] Duplicate callback ignored (success path)', { CheckoutRequestID });
      // Someone confirmed this payment by hand in the instant between this callback reading it and recording it. The
      // callback lost the race, but the receipt it carries is real: compare it with what was typed.
      const settled = await Payment.findById(payment._id);
      if (settled?.status === PAYMENT_STATUSES.PAID && settled.mpesaTransactionId && !settled.receiptMismatch
        && await flagReceiptMismatch(settled, metadata)) {
        return { success: true, message: 'Already processed', receiptMismatch: true };
      }
      return { success: true, message: 'Already processed' };
    }

    if (outcome.closed) {
      logger.warn('[M-PESA] Payment received for a closed order - marked refunded, money must be returned', {
        orderId: payment.orderId,
        orderStatus: outcome.orderStatus,
        mpesaTransactionId
      });
      await activityLogService.log({
        actorId:    payment.orderId,
        actorRole:  'customer',
        action:     LOG_ACTIONS.PAYMENT_CONFIRMED,
        branchId:   outcome.branchId || null,
        targetId:   payment._id,
        targetType: 'Payment',
        detail:     { mpesaTransactionId, amount: paidAmount, orderStatus: outcome.orderStatus, refundOwed: true }
      }).catch(err => logger.error('[M-PESA] Activity log failed on closed-order payment', { err: err.message }));
      alertService.sendAlert(
        'MPESA_PAYMENT_FOR_CLOSED_ORDER',
        {
          'Order ref': outcome.orderRef || 'unknown',
          'Order status': outcome.orderStatus,
          'M-Pesa receipt': mpesaTransactionId || 'unknown',
          Amount: paidAmount,
        },
        String(payment._id)
      ).catch(() => {});
      return { success: false, status: 'order_terminal', mpesaTransactionId };
    }

    const paidOrder = { branchId: outcome.branchId };

    // Overpayments are kept (never rejected) but must not just vanish into a log
    // line — someone has to return the surplus.
    if (Math.ceil(paidAmount) > Math.ceil(payment.amount)) {
      const surplus = Math.ceil(paidAmount) - Math.ceil(payment.amount);
      await activityLogService.log({
        actorId:    payment.orderId,
        actorRole:  'customer',
        action:     LOG_ACTIONS.PAYMENT_OVERPAID,
        branchId:   paidOrder?.branchId || null,
        targetId:   payment._id,
        targetType: 'Payment',
        detail:     { mpesaTransactionId, expected: payment.amount, received: paidAmount, surplus }
      });
      alertService.sendAlert(
        'MPESA_OVERPAYMENT',
        { 'M-Pesa receipt': mpesaTransactionId || 'unknown', Expected: payment.amount, Received: paidAmount, 'Surplus to return': surplus },
        String(payment._id)
      ).catch(() => {});
    }

    await activityLogService.log({
      actorId:    payment.orderId,
      actorRole:  'customer',
      action:     LOG_ACTIONS.PAYMENT_CONFIRMED,
      branchId:   paidOrder?.branchId || null,
      targetId:   payment._id,
      targetType: 'Payment',
      detail:     { mpesaTransactionId, amount: paidAmount }
    }).catch(err => logger.error('[M-PESA] Activity log failed on payment confirmed', { err: err.message }));

    logger.info('[M-PESA] Payment confirmed', { mpesaTransactionId, orderId: payment.orderId });

    etimsService.submitInvoice(payment.orderId).catch(err =>
      logger.error('[eTIMS] Invoice submission failed after M-Pesa callback', { orderId: payment.orderId, err: err.message })
    );
    emitOrderPaid(payment.orderId);

    return { success: true, status: 'paid', mpesaTransactionId };

  } else {
    // ── FAILURE ───────────────────────────────────────────────────────────────
    // Common result codes:
    // 1032 — cancelled by user
    // 1037 — timeout waiting for user
    // 1    — insufficient funds
    // 2001 — wrong PIN

    const claimed = await Payment.findOneAndUpdate(
      { _id: payment._id, status: payment.status },
      { status: PAYMENT_STATUSES.FAILED },
      { new: true }
    );
    if (!claimed) {
      logger.info('[M-PESA] Duplicate callback ignored (failure path)', { CheckoutRequestID });
      return { success: true, message: 'Already processed' };
    }

    const failedOrder = await Order.findByIdAndUpdate(payment.orderId, {
      paymentStatus: PAYMENT_STATUSES.FAILED
    }).select('branchId');

    await activityLogService.log({
      actorId:    payment.orderId,
      actorRole:  'customer',
      action:     LOG_ACTIONS.PAYMENT_FAILED,
      branchId:   failedOrder?.branchId || null,
      targetId:   payment._id,
      targetType: 'Payment',
      detail:     { resultCode: ResultCode, resultDesc: ResultDesc }
    }).catch(err => logger.error('[M-PESA] Activity log failed on payment failed', { err: err.message }));

    logger.info('[M-PESA] Payment failed', { resultCode: ResultCode, resultDesc: ResultDesc, orderId: payment.orderId });
    return { success: false, status: 'failed', resultCode: ResultCode, resultDesc: ResultDesc };
  }
};

// ── STK QUERY (ask Daraja what happened to a prompt) ──────────────────────────
// Safaricom's callback is the normal way to learn the outcome, but it can fail to arrive (a dropped
// request, a callback URL that was briefly unreachable, an IP the allow-list does not recognise).
// Without a fallback the customer has paid, the order stays "unpaid", and an M-Pesa order cannot be
// approved until it is paid - staff had to spot it in the cash-up report and confirm it by hand.
//
// Daraja's answer for a prompt that is still being worked on is an HTTP *error* with this code.
const STK_STILL_PROCESSING_CODE = '500.001.1001';

/**
 * Resolves { state: 'paid' | 'failed' | 'processing' | 'unknown', resultCode?, resultDesc? }.
 * 'paid' / 'failed' are returned ONLY for an unmistakable answer about this exact request
 * (ResponseCode 0, matching CheckoutRequestID, a purely numeric ResultCode). Anything else is
 * 'unknown' and changes nothing - a misread here would mark an order paid that is not.
 * Throws on network/auth errors so the caller can leave the payment for the next run.
 */
const queryStkStatus = async (checkoutRequestId) => {
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey   = process.env.MPESA_PASSKEY;
  if (!shortcode || !passkey) {
    throw new AppError('M-Pesa is not configured', 503, 'MPESA_NOT_CONFIGURED');
  }

  const token = await getDarajaToken();
  const timestamp = generateTimestamp();

  let data;
  try {
    const response = await axios.post(getUrls().stkquery, {
      BusinessShortCode: shortcode,
      Password:          generatePassword(shortcode, passkey, timestamp),
      Timestamp:         timestamp,
      CheckoutRequestID: checkoutRequestId
    }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    data = response.data;
  } catch (err) {
    if (err.response?.data?.errorCode === STK_STILL_PROCESSING_CODE) return { state: 'processing' };
    throw new Error(`STK query failed: ${err.response?.data?.errorMessage || err.message}`);
  }

  if (!data || String(data.ResponseCode) !== '0') return { state: 'unknown' };
  if (data.CheckoutRequestID && data.CheckoutRequestID !== checkoutRequestId) return { state: 'unknown' };

  // Never Number(): an empty string would become 0 and read as "paid".
  const rawResult = String(data.ResultCode ?? '').trim();
  if (!/^\d+$/.test(rawResult)) return { state: 'unknown' };

  const resultCode = Number(rawResult);
  return { state: resultCode === 0 ? 'paid' : 'failed', resultCode, resultDesc: data.ResultDesc || null };
};

// A prompt normally resolves within about a minute. Wait a little longer than that before asking, so
// the callback gets first go, and stop asking after a few hours - past that it is a human's job (the
// cash-up report lists anything still pending).
const RECONCILE_MIN_AGE_MS = 3 * 60 * 1000;
const RECONCILE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const RECONCILE_BATCH_SIZE = 20;

/**
 * Resolve M-Pesa payments stuck at "pending" because no callback arrived, by asking Daraja.
 *
 * The outcome is applied by feeding a synthetic callback through handleCallback, so a recovered
 * payment gets exactly the same treatment as a real one (atomic claim, order flipped to paid together
 * with the payment, cancelled-order refund bookkeeping, eTIMS, customer notification) and a real
 * callback arriving at the same moment cannot double-apply it. The one difference: the query returns
 * no receipt number, so a recovered payment is flagged `reconciledViaQuery` and carries none unless a
 * late callback eventually supplies it.
 *
 * `query` is injectable for tests. Never throws for a single payment - one bad lookup must not stop
 * the rest of the batch.
 */
const reconcilePendingPayments = async ({
  query = queryStkStatus,
  now = Date.now(),
  minAgeMs = RECONCILE_MIN_AGE_MS,
  maxAgeMs = RECONCILE_MAX_AGE_MS,
  batchSize = RECONCILE_BATCH_SIZE
} = {}) => {
  const candidates = await Payment.find({
    method: PAYMENT_METHODS.MPESA,
    status: PAYMENT_STATUSES.PENDING,
    checkoutRequestId: { $type: 'string' },
    createdAt: { $lte: new Date(now - minAgeMs), $gte: new Date(now - maxAgeMs) }
  }).sort({ createdAt: 1 }).limit(batchSize).lean();

  const summary = { checked: candidates.length, recovered: 0, failed: 0, stillProcessing: 0, errors: 0 };
  const recoveredRefs = [];

  for (const payment of candidates) {
    try {
      const result = await query(payment.checkoutRequestId);

      if (result.state !== 'paid' && result.state !== 'failed') {
        summary.stillProcessing += 1;
        continue;
      }

      const outcome = await handleCallback({
        Body: {
          stkCallback: {
            CheckoutRequestID: payment.checkoutRequestId,
            ResultCode: result.state === 'paid' ? 0 : result.resultCode,
            ResultDesc: result.resultDesc || (result.state === 'paid' ? 'Confirmed by status query' : 'Failed per status query'),
            // The amount of an STK push is fixed by the request we sent, so a successful result
            // means exactly payment.amount moved.
            ...(result.state === 'paid' && { CallbackMetadata: { Item: [{ Name: 'Amount', Value: payment.amount }] } })
          }
        }
      });

      if (result.state === 'failed') {
        summary.failed += 1;
        continue;
      }

      // 'Already processed' means a real callback beat us to it - nothing left to do or flag.
      if (outcome.status !== 'paid' && outcome.status !== 'order_terminal') continue;

      summary.recovered += 1;
      await Payment.updateOne(
        { _id: payment._id },
        { $set: { reconciledViaQuery: true, reconciledAt: new Date() } }
      );
      const order = await Order.findById(payment.orderId).select('orderRef branchId').lean();
      recoveredRefs.push(order?.orderRef || String(payment.orderId));
      await activityLogService.log({
        actorId:    payment.orderId,
        actorRole:  'system',
        action:     LOG_ACTIONS.PAYMENT_RECONCILED,
        branchId:   order?.branchId || null,
        targetId:   payment._id,
        targetType: 'Payment',
        detail:     { orderRef: order?.orderRef, amount: payment.amount, outcome: outcome.status, note: 'Confirmed by asking Daraja — no callback arrived, so no receipt code is recorded. Match it on the M-Pesa statement.' }
      });
    } catch (err) {
      summary.errors += 1;
      logger.warn('[M-PESA] Status query failed — will retry next run', { paymentId: payment._id, err: err.message });
    }
  }

  if (recoveredRefs.length > 0) {
    alertService.sendAlert('MPESA_RECONCILED', {
      'Payments recovered': recoveredRefs.length,
      'Order refs': recoveredRefs.join(', ')
    }, 'global').catch(alertErr => logger.error('[M-PESA] Alert failed', { err: alertErr.message }));
  }

  return summary;
};

// ── CHECK PAYMENT STATUS ──────────────────────────────────────────────────────
// Used by frontend polling every 5 seconds after STK push
const ADMIN_ROLES = [ROLES.STAFF, ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.SUPERADMIN];

const checkPaymentStatus = async (orderId, requestingUser, guestPhone = null) => {
  const order = await Order.findById(orderId)
    .select('paymentStatus paymentId orderRef total userId guestId branchId')
    .populate('guestId', 'phone');
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');

  // Ownership check — only the order owner or admin-tier roles may poll payment status.
  // Return 404 (not 403) to avoid leaking whether the order ID exists at all.
  if (requestingUser) {
    if (ADMIN_ROLES.includes(requestingUser.role)) {
      // Branch isolation, same as every other admin surface: a branch-scoped
      // staff token only sees its own branch's orders. Superadmin tokens carry
      // branchId null and keep the global view.
      if (requestingUser.branchId && order.branchId?.toString() !== requestingUser.branchId.toString()) {
        throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
      }
    } else {
      if (!order.userId || order.userId.toString() !== requestingUser.id.toString()) {
        throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
      }
    }
  } else {
    let normalizedRequestPhone, normalizedOrderPhone;
    try {
      normalizedRequestPhone = guestPhone ? formatPhone(guestPhone) : null;
      normalizedOrderPhone   = order.guestId?.phone ? formatPhone(order.guestId.phone) : null;
    } catch {
      throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
    }
    if (!normalizedRequestPhone || normalizedRequestPhone !== normalizedOrderPhone) {
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

const manualConfirmPayment = async (orderId, adminId, transactionRef, actorRole = 'supervisor', branchId = null, receivedAmount = null) => {
  const query = { _id: orderId };
  if (branchId) query.branchId = branchId;
  const order = await Order.findOne(query);
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  if (order.paymentStatus === PAYMENT_STATUSES.PAID) {
    throw new AppError('Payment is already confirmed', 400, 'ALREADY_PAID');
  }
  // A cancelled/rejected order has had its stock released and, if it was paid, its
  // refund recorded — confirming a payment on it would leave a cancelled order
  // marked PAID with nothing owed back. If real money arrived for it, that is a
  // refund case, not a confirmation.
  if (['cancelled', 'rejected'].includes(order.status)) {
    throw new AppError(
      `This order was ${order.status}, so a payment cannot be confirmed on it. If money was received, record a refund instead.`,
      400,
      'ORDER_NOT_PAYABLE'
    );
  }

  const isMpesa = order.paymentMethod === PAYMENT_METHODS.MPESA;
  let ref = null;

  if (isMpesa) {
    // M-Pesa manual confirm requires a real receipt number
    if (!transactionRef || typeof transactionRef !== 'string' || !transactionRef.trim()) {
      throw new AppError(
        'M-Pesa transaction reference is required for manual confirmation',
        400,
        'TRANSACTION_REF_REQUIRED'
      );
    }
    ref = transactionRef.trim().toUpperCase();
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
  }

  // Require and cross-check the received amount for BOTH payment methods — a
  // manual confirmation must reconcile against a real amount, not just a receipt
  // code. Previously this check only ran for cash (!isMpesa), so an admin could
  // mark any M-Pesa order fully PAID by supplying just a well-formatted, unused
  // receipt string with zero cross-check against order.total.
  if (receivedAmount == null) {
    throw new AppError(
      'The amount received must be provided to confirm this payment',
      400,
      'RECEIVED_AMOUNT_REQUIRED'
    );
  }
  // Ceil, not round, to match the amount actually demanded on the M-Pesa side
  // (Payment.amount is stored via Math.ceil(order.total) at STK-push time, and the
  // callback checks paidAmount against that same ceiling) — using a looser rounding
  // rule here could let a manual confirmation accept 1 KES less than M-Pesa would.
  const expectedAmount = Math.ceil(order.total);
  if (Math.round(receivedAmount) < expectedAmount) {
    throw new AppError(
      `Received amount (KES ${Math.round(receivedAmount)}) is less than the order total (KES ${expectedAmount}). Correct the amount or contact a supervisor.`,
      400,
      isMpesa ? 'MPESA_AMOUNT_MISMATCH' : 'CASH_UNDERPAYMENT'
    );
  }
  const receivedWhole = Math.round(receivedAmount);
  const surplus = receivedWhole - expectedAmount;

  const paymentUpdate = {
    status:      PAYMENT_STATUSES.PAID,
    confirmedBy: adminId,
    paidAt:      new Date(),
    // What was actually taken. It used to be checked here and then thrown away, so an over-payment left no trace and
    // the cash-up could only ever show what had been ASKED for.
    receivedAmount: receivedWhole,
    ...(ref && { mpesaTransactionId: ref })
  };

  // Claim the order FIRST, atomically — this is the actual race guard. Only the
  // request that wins this conditional update goes on to create/update a Payment
  // record; a concurrent loser exits here, before ever writing one. Previously the
  // atomic order-claim ran AFTER creating/updating the Payment, so two racing
  // confirmations on a COD order with no Payment yet could both pass the earlier
  // read and both create their own orphaned duplicate PAID Payment document.
  const claimedOrder = await Order.findOneAndUpdate(
    { _id: orderId, paymentStatus: { $ne: PAYMENT_STATUSES.PAID } },
    { paymentStatus: PAYMENT_STATUSES.PAID }
  );
  if (!claimedOrder) {
    throw new AppError('Payment is already confirmed', 400, 'ALREADY_PAID');
  }

  let payment = claimedOrder.paymentId
    ? await Payment.findById(claimedOrder.paymentId)
    : null;

  if (payment) {
    await Payment.findByIdAndUpdate(payment._id, paymentUpdate);
  } else {
    payment = await Payment.create({
      orderId:  order._id,
      branchId: order.branchId,
      method:   order.paymentMethod,
      // The same rule as an M-Pesa prompt (the total rounded up to a whole shilling). Cash used to be stored with
      // cents and M-Pesa without, so the two methods could not be added up on one scale.
      amount:   expectedAmount,
      currency: 'KES',
      ...paymentUpdate
    });
    await Order.findByIdAndUpdate(orderId, { paymentId: payment._id });
  }

  await activityLogService.log({
    actorId:    adminId,
    actorRole,
    action:     LOG_ACTIONS.PAYMENT_MANUALLY_CONFIRMED,
    branchId:   claimedOrder.branchId || null,
    targetId:   payment._id,
    targetType: 'Payment',
    detail:     { orderId, transactionRef: ref || 'cash', receivedAmount: receivedWhole, expected: expectedAmount }
  });

  // Over-payment: the surplus belongs to the customer. The M-Pesa callback path has always logged and alerted on this;
  // the manual path now does too, so it can be found and handed back.
  if (surplus > 0) {
    logger.warn('[MANUAL CONFIRM] Overpayment on manual confirmation — surplus to return', {
      orderId: order._id, method: order.paymentMethod, expected: expectedAmount, received: receivedWhole, surplus,
    });
    await activityLogService.log({
      actorId:    adminId,
      actorRole,
      action:     LOG_ACTIONS.PAYMENT_OVERPAID,
      branchId:   claimedOrder.branchId || null,
      targetId:   payment._id,
      targetType: 'Payment',
      detail:     { orderRef: order.orderRef, mode: 'manual', method: order.paymentMethod, expected: expectedAmount, received: receivedWhole, surplus },
    }).catch(err => logger.error('[MANUAL CONFIRM] Activity log failed on overpayment', { err: err.message }));
    alertService.sendAlert('PAYMENT_OVERPAID_MANUAL', {
      'Order ref': order.orderRef, Method: order.paymentMethod, Expected: expectedAmount, Received: receivedWhole, Surplus: surplus,
    }, String(payment._id)).catch(() => {});
  }

  etimsService.submitInvoice(orderId).catch(err =>
    logger.error('[eTIMS] Invoice submission failed after manual confirmation', { orderId, err: err.message })
  );
  emitOrderPaid(orderId);

  return payment;
};

// ── RECORD A REFUND AS SENT ───────────────────────────────────────────────────
// Cancelling or rejecting a paid order records that money is OWED back (Payment.status 'refunded'); the actual
// reversal is made by hand, outside the system, with M-Pesa or in cash. Until now nothing recorded that it had been
// done, so a refund looked "owed" for ever and money out could not be matched to the M-Pesa statement. This is the last step.
const REFUND_METHODS = ['mpesa', 'cash', 'bank', 'other'];

const recordRefundSent = async (orderId, actorId, actorRole, branchId, { method, reference, amount, note } = {}) => {
  if (!REFUND_METHODS.includes(method)) {
    throw new AppError('Choose how the refund was sent: M-Pesa, cash, bank or other', 400, 'INVALID_REFUND_METHOD');
  }
  const query = { _id: orderId };
  if (branchId) query.branchId = branchId;
  const order = await Order.findOne(query).select('orderRef branchId paymentId paymentStatus').lean();
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  const payment = order.paymentId ? await Payment.findById(order.paymentId) : null;
  if (!payment || payment.status !== PAYMENT_STATUSES.REFUNDED) {
    throw new AppError('There is no refund owed on this order', 400, 'NO_REFUND_OWED');
  }
  if (payment.refundSentAt) {
    throw new AppError('This refund has already been recorded as sent', 409, 'REFUND_ALREADY_SENT');
  }

  const owed = payment.receivedAmount ?? payment.amount;
  const sent = amount == null || amount === '' ? owed : Math.round(Number(amount));
  if (!Number.isFinite(sent) || sent <= 0 || sent > owed) {
    throw new AppError(`The refund must be between KES 1 and the KES ${owed} that was received`, 400, 'INVALID_REFUND_AMOUNT');
  }
  const cleanNote = typeof note === 'string' ? note.trim().slice(0, 300) : '';
  if (sent < owed && !cleanNote) {
    throw new AppError('A refund of less than the amount received needs a note saying why', 400, 'REFUND_NOTE_REQUIRED');
  }

  // An M-Pesa refund must quote the receipt of the reversal or transfer, and a receipt can settle exactly one refund.
  // Other methods may add a free-text reference; it goes into the note (a cash slip number is not unique across the shop).
  let refundReference = null;
  const refText = typeof reference === 'string' ? reference.trim() : '';
  if (method === 'mpesa') {
    refundReference = refText.toUpperCase();
    if (!MPESA_RECEIPT_REGEX.test(refundReference)) {
      throw new AppError('Enter the 10-character M-Pesa receipt of the refund (e.g. QDK14KSHD7)', 400, 'INVALID_TRANSACTION_REF');
    }
    if (await Payment.exists({ refundReference })) {
      throw new AppError('This M-Pesa receipt has already been used for another refund', 409, 'DUPLICATE_REFUND_REF');
    }
  }
  const fullNote = [method !== 'mpesa' && refText ? `Ref: ${refText.slice(0, 60)}` : '', cleanNote].filter(Boolean).join(' · ') || null;

  let claimed;
  try {
    claimed = await Payment.findOneAndUpdate(
      { _id: payment._id, status: PAYMENT_STATUSES.REFUNDED, refundSentAt: null },
      { $set: {
        refundSentAt: new Date(), refundSentAmount: sent, refundMethod: method,
        refundReference, refundSentBy: actorId, refundNote: fullNote,
      } },
      { new: true }
    );
  } catch (err) {
    if (err.code === 11000) throw new AppError('This M-Pesa receipt has already been used for another refund', 409, 'DUPLICATE_REFUND_REF');
    throw err;
  }
  if (!claimed) throw new AppError('This refund has already been recorded as sent', 409, 'REFUND_ALREADY_SENT');

  await Order.updateOne({ _id: order._id }, { refundSettledAt: claimed.refundSentAt });

  await activityLogService.log({
    actorId,
    actorRole,
    action:     LOG_ACTIONS.PAYMENT_REFUND_SENT,
    branchId:   order.branchId || null,
    targetId:   payment._id,
    targetType: 'Payment',
    detail:     { orderRef: order.orderRef, owed, sent, method, reference: refundReference || refText || null, note: cleanNote || null },
  });

  return claimed;
};

// ── CLOSE A PAYMENT EXCEPTION ─────────────────────────────────────────────────
// "M-Pesa money that arrived but was not credited" (a late success after the attempt was given up on, or a payment that
// came in short) and "typed receipt differs from Safaricom's" are flagged on the payment. Nothing could ever clear a flag,
// so the Control Center and the cash-up reported it for ever. A person who has dealt with it (refunded, topped up, matched
// it to an order, compared the receipts) records that here; it closes every flag that is open on the payment.
const resolvePaymentException = async (paymentId, actorId, actorRole, branchId, note) => {
  const cleanNote = typeof note === 'string' ? note.trim().slice(0, 300) : '';
  if (cleanNote.length < 3) {
    throw new AppError('Say what was done about it (a few words is enough)', 400, 'RESOLUTION_NOTE_REQUIRED');
  }
  const query = { _id: paymentId };
  if (branchId) query.branchId = branchId;
  const payment = await Payment.findOne(query).select('orderId branchId lateSuccessMeta receiptMismatch').lean();
  if (!payment) throw new AppError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
  const hadLate = Boolean(payment.lateSuccessMeta?.receivedAt);
  const hadMismatch = Boolean(payment.receiptMismatch?.detectedAt);
  if (!hadLate && !hadMismatch) {
    throw new AppError('This payment has no open M-Pesa exception', 400, 'NO_OPEN_EXCEPTION');
  }
  const openLate = hadLate && !payment.lateSuccessMeta.resolvedAt;
  const openMismatch = hadMismatch && !payment.receiptMismatch.resolvedAt;
  if (!openLate && !openMismatch) {
    throw new AppError('This exception has already been closed', 409, 'EXCEPTION_ALREADY_RESOLVED');
  }
  const now = new Date();
  const closed = await Payment.findOneAndUpdate(
    {
      _id: payment._id,
      ...(openLate && { 'lateSuccessMeta.resolvedAt': null }),
      ...(openMismatch && { 'receiptMismatch.resolvedAt': null }),
    },
    { $set: {
      ...(openLate && { 'lateSuccessMeta.resolvedAt': now, 'lateSuccessMeta.resolvedBy': actorId, 'lateSuccessMeta.resolutionNote': cleanNote }),
      ...(openMismatch && { 'receiptMismatch.resolvedAt': now, 'receiptMismatch.resolvedBy': actorId, 'receiptMismatch.resolutionNote': cleanNote }),
    } },
    { new: true }
  );
  if (!closed) throw new AppError('This exception has already been closed', 409, 'EXCEPTION_ALREADY_RESOLVED');

  const order = await Order.findById(payment.orderId).select('orderRef').lean();
  await activityLogService.log({
    actorId,
    actorRole,
    action:     LOG_ACTIONS.PAYMENT_EXCEPTION_RESOLVED,
    branchId:   payment.branchId || null,
    targetId:   payment._id,
    targetType: 'Payment',
    detail:     {
      orderRef: order?.orderRef, note: cleanNote,
      kind: [openLate && (payment.lateSuccessMeta.reason || 'late_success'), openMismatch && 'receipt_mismatch'].filter(Boolean).join('+'),
    },
  });
  return closed;
};

module.exports = {
  recordRefundSent,
  resolvePaymentException,
  initiateStkPush,
  handleCallback,
  queryStkStatus,
  reconcilePendingPayments,
  checkPaymentStatus,
  manualConfirmPayment,
  changePaymentMethod
};
