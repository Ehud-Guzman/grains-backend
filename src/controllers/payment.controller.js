// ── PAYMENT CONTROLLER ────────────────────────────────────────────────────────
const paymentService = require('../services/payment.service');
const { success, error } = require('../utils/apiResponse');
const logger = require('../utils/logger');
const Order = require('../models/Order');
const Guest = require('../models/Guest');
const { formatPhone } = require('../utils/mpesaHelpers');

// POST /api/payments/mpesa/initiate — guest or authenticated customer
const initiate = async (req, res, next) => {
  try {
    const { orderId, phone, contactPhone } = req.body;
    if (!orderId || !phone) {
      return error(res, 'orderId and phone are required', 'MISSING_FIELDS');
    }

    // Ownership check — prevents triggering STK push on someone else's order
    const order = await Order.findById(orderId).select('userId guestId').lean();
    if (!order) return error(res, 'Order not found', 'NOT_FOUND', 404);

    if (req.user) {
      // Authenticated customer — must own the order
      if (!order.userId || order.userId.toString() !== req.user.id) {
        return error(res, 'Order not found', 'NOT_FOUND', 404);
      }
    } else {
      // Guest — ownership is proven by knowing the CONTACT phone the order was
      // placed under. The STK target (`phone`) may legitimately be a different
      // number (paying from a spouse's or business line), so it must not be the
      // thing we verify — previously it was, and any guest paying with a
      // different M-Pesa number was dead-ended with a 404. `contactPhone` falls
      // back to `phone` for older clients that only send one number.
      if (!order.guestId) return error(res, 'Order not found', 'NOT_FOUND', 404);
      const guest = await Guest.findById(order.guestId).select('phone').lean();
      let ownershipPhone;
      try {
        ownershipPhone = formatPhone(contactPhone || phone);
      } catch {
        return error(res, 'Order not found', 'NOT_FOUND', 404);
      }
      if (!guest || formatPhone(guest.phone) !== ownershipPhone) {
        return error(res, 'Order not found', 'NOT_FOUND', 404);
      }
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
    const { transactionRef, receivedAmount } = req.body;
    const result = await paymentService.manualConfirmPayment(
      req.params.orderId,
      req.user.id,
      transactionRef,
      req.user.role,
      req.branchId || null,
      receivedAmount != null ? Number(receivedAmount) : null
    );
    return success(res, result, 'Payment confirmed manually');
  } catch (err) { next(err); }
};

module.exports = { initiate, callback, getStatus, manualConfirm };
