// ── PAYMENT ROUTES ────────────────────────────────────────────────────────────
// src/routes/payment.routes.js

const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');
const { verifyToken } = require('../middleware/auth.middleware');
const { validateSafaricomIP } = require('../utils/mpesaHelpers');
const { callbackLimiter, stkLimiter } = require('../middleware/rateLimit.middleware');

// POST /api/payments/mpesa/initiate — open to guests and logged-in customers
// stkLimiter (5/min) is tighter than the global publicLimiter (100/min) to prevent drain attacks
router.post(
  '/mpesa/initiate',
  stkLimiter,
  paymentController.initiate
);

// POST /api/payments/mpesa/callback — Safaricom calls this
// Guards: rate limit → IP whitelist (prod) → payload structure check → controller
router.post(
  '/mpesa/callback',
  callbackLimiter,
  (req, res, next) => {
    // Validate source IP in production
    if (!validateSafaricomIP(req)) {
      console.warn(`[M-PESA] Rejected callback from IP: ${req.ip}`);
      // Return 200 so Safaricom doesn't enter a retry loop
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }
    next();
  },
  (req, res, next) => {
    // Reject structurally invalid payloads before they reach the service layer
    const hasExpectedShape = (
      req.body &&
      typeof req.body === 'object' &&
      req.body.Body &&
      req.body.Body.stkCallback &&
      typeof req.body.Body.stkCallback.CheckoutRequestID === 'string'
    );
    if (!hasExpectedShape) {
      console.warn(`[M-PESA] Malformed callback payload from IP: ${req.ip}`);
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }
    next();
  },
  paymentController.callback
);

// GET /api/payments/status/:orderId — customer polls after STK push
router.get(
  '/status/:orderId',
  verifyToken,
  paymentController.getStatus
);

module.exports = router;