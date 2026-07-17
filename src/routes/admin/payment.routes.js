// ── ADMIN PAYMENT ROUTES ──────────────────────────────────────────────────────
// src/routes/admin/payment.routes.js

const express = require('express');
const router = express.Router();
const paymentController = require('../../controllers/payment.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireMinRole } = require('../../middleware/role.middleware');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');
const { checkPlatformLock } = require('../../middleware/platformLock.middleware');
const { validate } = require('../../middleware/validate.middleware');
const { manualConfirmPaymentValidator } = require('../../validators/payment.validator');

router.use(verifyToken, adminLimiter, checkPlatformLock);

// POST /api/admin/payments/:orderId/confirm-manual — supervisor+
router.post(
  '/:orderId/confirm-manual',
  requireMinRole('supervisor'),
  manualConfirmPaymentValidator,
  validate,
  paymentController.manualConfirm
);

module.exports = router;
