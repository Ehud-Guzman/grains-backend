// ── PAYMENT ROUTES ────────────────────────────────────────────────────────────
// src/routes/payment.routes.js

const express = require('express');
const router = express.Router();
const { body, param } = require('express-validator');
const paymentController = require('../controllers/payment.controller');
const { optionalAuth } = require('../middleware/auth.middleware');
const { validateSafaricomIP, describeCallbackSource } = require('../utils/mpesaHelpers');
const { callbackLimiter, stkLimiter } = require('../middleware/rateLimit.middleware');
const { validate } = require('../middleware/validate.middleware');
const logger = require('../utils/logger');
const alertService = require('../services/alert.service');

// POST /api/payments/mpesa/initiate — open to guests and logged-in customers
// stkLimiter (5/min) is tighter than the global publicLimiter (100/min) to prevent drain attacks
router.post(
  '/mpesa/initiate',
  stkLimiter,
  optionalAuth,
  [
    body('orderId').trim().isMongoId().withMessage('Invalid order ID'),
    body('phone')
      .isString().withMessage('Phone number must be text').bail()
      .trim()
      .notEmpty().withMessage('Phone number is required')
      .matches(/^(\+254|0)[17]\d{8}$/).withMessage('Enter a valid Kenyan phone number'),
    // Guest ownership proof when the STK target differs from the order's
    // contact number — see payment.controller.js#initiate
    body('contactPhone')
      .optional({ nullable: true, checkFalsy: true })
      .isString().withMessage('Contact phone must be text').bail()
      .trim()
      .matches(/^(\+254|0)[17]\d{8}$/).withMessage('Enter a valid Kenyan contact phone number')
  ],
  validate,
  paymentController.initiate
);

// POST /api/payments/change-method — move an unpaid pending order to another payment
// method (e.g. "pay on pickup instead" after a failed STK push). Same ownership proof
// as initiate; stkLimiter keeps it from being used to hammer the order.
router.post(
  '/change-method',
  stkLimiter,
  optionalAuth,
  [
    body('orderId').trim().isMongoId().withMessage('Invalid order ID'),
    body('paymentMethod').isIn(['mpesa', 'pickup', 'delivery']).withMessage('Invalid payment method'),
    body('contactPhone')
      .optional({ nullable: true, checkFalsy: true })
      .isString().withMessage('Contact phone must be text').bail()
      .trim()
      .matches(/^(\+254|0)[17]\d{8}$/).withMessage('Enter a valid Kenyan contact phone number')
  ],
  validate,
  paymentController.changeMethod
);

// POST /api/payments/mpesa/callback — Safaricom calls this
// Guards: rate limit → IP whitelist (prod) → payload structure check → controller
router.post(
  '/mpesa/callback',
  callbackLimiter,
  (req, res, next) => {
    // Validate source IP in production
    if (!validateSafaricomIP(req)) {
      const source = describeCallbackSource(req);
      logger.warn('[M-PESA] Rejected callback from unauthorized IP', source);
      // Loud on purpose: if this fires for a real Safaricom callback (the proxy chain resolves to the
      // wrong address, or Safaricom added an IP), every payment confirmation is being dropped. The
      // alert carries what the server saw, and the stuck-payment reconciliation job keeps orders
      // moving in the meantime. Throttled, so a scanner hitting this URL cannot flood the inbox.
      alertService.sendAlert('MPESA_CALLBACK_REJECTED', source, 'global')
        .catch(err => logger.error('[M-PESA] Alert failed', { err: err.message }));
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
