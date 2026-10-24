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
const { manualConfirmPaymentValidator, refundSentValidator, resolveExceptionValidator } = require('../../validators/payment.validator');

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

// POST /api/admin/payments/:orderId/refund-sent — admin (business only)
// Money going OUT is a stricter act than money coming in: an admin records that a refund was sent, with the M-Pesa
// receipt of the reversal. Superadmin is view-only, as for every other business write.
router.post(
  '/:orderId/refund-sent',
  requireBusinessRole('admin'),
  refundSentValidator,
  validate,
  paymentController.refundSent
);

// POST /api/admin/payments/:paymentId/resolve-exception — supervisor+ (business only)
// Closes an "M-Pesa money arrived but was not credited" flag once someone has dealt with it.
router.post(
  '/:paymentId/resolve-exception',
  requireBusinessRole('supervisor'),
  resolveExceptionValidator,
  validate,
  paymentController.resolveException
);

module.exports = router;
