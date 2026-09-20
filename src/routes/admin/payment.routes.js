// ── ADMIN PAYMENT ROUTES ──────────────────────────────────────────────────────
// src/routes/admin/payment.routes.js

const express = require('express');
const router = express.Router();
const paymentController = require('../../controllers/payment.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireBusinessRole } = require('../../middleware/role.middleware');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');
const { checkPlatformLock } = require('../../middleware/platformLock.middleware');
const { validate } = require('../../middleware/validate.middleware');
const { manualConfirmPaymentValidator } = require('../../validators/payment.validator');

router.use(verifyToken, adminLimiter, checkPlatformLock);

// POST /api/admin/payments/:orderId/confirm-manual — supervisor+ (business only)
// Manually marking an order as paid is a business operation — it releases goods
// and drives both the eTIMS invoice and the reports — so it uses
// requireBusinessRole and excludes superadmin. Was requireMinRole, which let
// superadmin through. See role.middleware.js.
router.post(
  '/:orderId/confirm-manual',
  requireBusinessRole('supervisor'),
  manualConfirmPaymentValidator,
  validate,
  paymentController.manualConfirm
);

module.exports = router;
