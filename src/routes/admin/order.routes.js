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
const Order                 = require('../../models/Order');
const etimsService          = require('../../services/etims.service');
const globalSettingsService = require('../../services/globalSettings.service');
const { success }           = require('../../utils/apiResponse');
const { AppError }          = require('../../middleware/errorHandler.middleware');

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

// PATCH /api/admin/orders/:id/assign-driver
router.patch(
  '/:id/assign-driver',
  requireBusinessRole('supervisor'),
  [require('express-validator').body('driverId').notEmpty().withMessage('driverId is required')],
  validate,
  orderController.assignDriver
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

// POST /api/admin/orders/:id/etims/resubmit
// Available to roles listed in globalSettings.etims.allowedRoles (set by superadmin)
router.post('/:id/etims/resubmit', requireMinRole('staff'), async (req, res, next) => {
  try {
    const globalSettings = await globalSettingsService.getSettings();
    const { enabled, allowedRoles = [] } = globalSettings.etims || {};

    if (!enabled) {
      return next(new AppError('eTIMS is not enabled', 400, 'ETIMS_DISABLED'));
    }
    if (!allowedRoles.includes(req.user.role)) {
      return next(new AppError('You do not have permission to resubmit eTIMS invoices', 403, 'FORBIDDEN'));
    }

    const query = { _id: req.params.id };
    if (req.branchId) query.branchId = req.branchId;
    const order = await Order.findOne(query).select('status paymentStatus').lean();

    if (!order) {
      return next(new AppError('Order not found', 404, 'ORDER_NOT_FOUND'));
    }
    if (order.status !== 'completed') {
      return next(new AppError('eTIMS invoices can only be resubmitted for completed orders', 400, 'INVALID_ORDER_STATUS'));
    }
    if (order.paymentStatus !== 'paid') {
      return next(new AppError('Cannot submit eTIMS invoice for an unpaid order', 400, 'PAYMENT_NOT_CONFIRMED'));
    }

    await etimsService.submitInvoice(req.params.id);
    return success(res, null, 'eTIMS invoice submitted');
  } catch (err) { next(err); }
});

module.exports = router;