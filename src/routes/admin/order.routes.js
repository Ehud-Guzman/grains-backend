const express = require('express');
const router = express.Router();
const orderController = require('../../controllers/admin/order.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireMinRole, requireBusinessRole } = require('../../middleware/role.middleware');
const { validate } = require('../../middleware/validate.middleware');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');
const {
  rejectOrderValidator,
  updateStatusValidator,
  bulkActionValidator
} = require('../../validators/order.validator');

// All admin order routes require auth + staff minimum
router.use(verifyToken, adminLimiter);

// ── STAFF+ (read-only — superadmin CAN view) ──────────────────────────────────

// GET /api/admin/orders
router.get('/', requireMinRole('staff'), orderController.getAll);

// GET /api/admin/orders/:id
router.get('/:id', requireMinRole('staff'), orderController.getById);

// GET /api/admin/orders/:id/packing-slip
router.get('/:id/packing-slip', requireMinRole('staff'), orderController.getPackingSlip);

// ── STAFF+ WRITE (business operations — superadmin CANNOT perform) ─────────────

// PATCH /api/admin/orders/:id/status
router.patch(
  '/:id/status',
  requireBusinessRole('staff'),
  updateStatusValidator,
  validate,
  orderController.updateStatus
);

// ── SUPERVISOR+ WRITE (business operations — superadmin CANNOT perform) ────────

// PATCH /api/admin/orders/:id/approve
router.patch('/:id/approve', requireBusinessRole('supervisor'), orderController.approve);

// PATCH /api/admin/orders/:id/reject
router.patch(
  '/:id/reject',
  requireBusinessRole('supervisor'),
  rejectOrderValidator,
  validate,
  orderController.reject
);

// POST /api/admin/orders/bulk-approve
router.post(
  '/bulk-approve',
  requireBusinessRole('supervisor'),
  bulkActionValidator,
  validate,
  orderController.bulkApprove
);

// POST /api/admin/orders/bulk-reject
router.post(
  '/bulk-reject',
  requireBusinessRole('supervisor'),
  [...bulkActionValidator, require('express-validator').body('reason').trim().notEmpty().withMessage('Reason is required')],
  validate,
  orderController.bulkReject
);

module.exports = router;