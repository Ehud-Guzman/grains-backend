// ── PAYMENT ROUTES ────────────────────────────────────────────────────────────
// src/routes/payment.routes.js

const express = require('express');
const router = express.Router();
const { body, param } = require('express-validator');
const paymentController = require('../controllers/payment.controller');
const { optionalAuth } = require('../middleware/auth.middleware');
const { validateSafaricomIP } = require('../utils/mpesaHelpers');
const { callbackLimiter, stkLimiter } = require('../middleware/rateLimit.middleware');
const { validate } = require('../middleware/validate.middleware');
const logger = require('../utils/logger');

// POST /api/payments/mpesa/initiate — open to guests and logged-in customers
// stkLimiter (5/min) is tighter than the global publicLimiter (100/min) to prevent drain attacks
router.post(
  '/mpesa/initiate',
  stkLimiter,
  optionalAuth,
  [
    body('orderId').trim().isMongoId().withMessage('Invalid order ID'),
    body('phone')
      .trim()
      .notEmpty().withMessage('Phone number is required')
      .matches(/^(\+254|0)[17]\d{8}$/).withMessage('Enter a valid Kenyan phone number'),
    // Guest ownership proof when the STK target differs from the order's
    // contact number — see payment.controller.js#initiate
    body('contactPhone')
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .matches(/^(\+254|0)[17]\d{8}$/).withMessage('Enter a valid Kenyan contact phone number')
  ],
  validate,
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
      logger.warn('[M-PESA] Rejected callback from unauthorized IP', { ip: req.ip });
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
      logger.warn('[M-PESA] Malformed callback payload', { ip: req.ip });
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }
    next();
  },
  paymentController.callback
);

// GET /api/payments/status/:orderId — customer polls after STK push
router.get(
  '/status/:orderId',
  optionalAuth,
  [param('orderId').isMongoId().withMessage('Invalid order ID')],
  validate,
  paymentController.getStatus
);

module.exports = router;
