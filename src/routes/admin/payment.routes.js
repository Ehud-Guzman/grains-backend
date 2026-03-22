// ── ADMIN PAYMENT ROUTES ──────────────────────────────────────────────────────
// src/routes/admin/payment.routes.js

const express = require('express');
const router = express.Router();
const paymentController = require('../../controllers/payment.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireMinRole } = require('../../middleware/role.middleware');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');

router.use(verifyToken, adminLimiter);

// POST /api/admin/payments/:orderId/confirm-manual — supervisor+
router.post(
  '/:orderId/confirm-manual',
  requireMinRole('supervisor'),
  paymentController.manualConfirm
);

module.exports = router;