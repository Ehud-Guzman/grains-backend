// ── PAYMENT CONTROLLER ────────────────────────────────────────────────────────
const paymentService = require('../services/payment.service');
const { success, error } = require('../utils/apiResponse');
const logger = require('../utils/logger');

// POST /api/payments/mpesa/initiate — customer auth
const initiate = async (req, res, next) => {
  try {
    const { orderId, phone } = req.body;
    if (!orderId || !phone) {
      return error(res, 'orderId and phone are required', 'MISSING_FIELDS');
    }
    const result = await paymentService.initiateStkPush(orderId, phone);
    return success(res, result, 'STK push sent to your phone');
  } catch (err) { next(err); }
};

// POST /api/payments/mpesa/callback — Safaricom calls this (public, IP-whitelisted)
const callback = async (req, res) => {
  // Always return 200 to Safaricom — even on error
  // If we return non-200, Safaricom retries up to 3 times
  try {
    await paymentService.handleCallback(req.body);
  } catch (err) {
    logger.error('[M-PESA] Callback processing error', { err: err.message });
  }
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
};

// GET /api/payments/status/:orderId — customer polls this after STK push
const getStatus = async (req, res, next) => {
  try {
    const result = await paymentService.checkPaymentStatus(req.params.orderId, req.user, req.query.phone);
    return success(res, result);
  } catch (err) { next(err); }
};

// POST /api/admin/payments/:orderId/confirm-manual — supervisor+
const manualConfirm = async (req, res, next) => {
  try {
    const { transactionRef } = req.body;
    const result = await paymentService.manualConfirmPayment(
      req.params.orderId,
      req.user.id,
      transactionRef,
      req.user.role,
      req.branchId || null
    );
    return success(res, result, 'Payment confirmed manually');
  } catch (err) { next(err); }
};

module.exports = { initiate, callback, getStatus, manualConfirm };
