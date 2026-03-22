// ── PAYMENT ROUTES ────────────────────────────────────────────────────────────
// src/routes/payment.routes.js

const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');
const { verifyToken } = require('../middleware/auth.middleware');
const { validateSafaricomIP } = require('../utils/mpesaHelpers');
const { publicLimiter } = require('../middleware/rateLimit.middleware');

// POST /api/payments/mpesa/initiate — customer must be logged in
router.post(
  '/mpesa/initiate',
  verifyToken,
  paymentController.initiate
);

// POST /api/payments/mpesa/callback — Safaricom calls this
// Public endpoint — IP validation applied inside
router.post(
  '/mpesa/callback',
  (req, res, next) => {
    // Validate source IP in production
    if (!validateSafaricomIP(req)) {
      console.warn(`[M-PESA] Rejected callback from IP: ${req.ip}`);
      // Still return 200 so Safaricom doesn't retry endlessly
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