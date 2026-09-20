const express = require('express');
const router = express.Router();
const driverController = require('../../controllers/admin/driver.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireMinRole, requireBusinessRole } = require('../../middleware/role.middleware');
const { validate } = require('../../middleware/validate.middleware');
const { body, param } = require('express-validator');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');
const { checkPlatformLock } = require('../../middleware/platformLock.middleware');

const driverIdParamValidator = [
  param('id').isMongoId().withMessage('Invalid driver ID')
];

// All routes: authenticated + at least supervisor
router.use(verifyToken, adminLimiter, checkPlatformLock);

// ── READ (supervisor+ — superadmin CAN view, for oversight) ───────────────────
// These were requireBusinessRole, which was inconsistent with every other admin
// router (reads use requireMinRole so superadmin keeps read-only oversight) and
// only appeared to work because the old requireBusinessRole admitted superadmin.
router.get('/', requireMinRole('supervisor'), driverController.getAll);
router.get('/:id', requireMinRole('supervisor'), driverController.getById);
router.get('/:id/orders', requireMinRole('supervisor'), driverController.getOrders);
router.get('/:id/stats', requireMinRole('supervisor'), driverController.getStats);

// ── WRITE (admin+) ────────────────────────────────────────────────────────────
router.post('/',
  requireBusinessRole('admin'),
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('phone').trim().notEmpty().withMessage('Phone is required')
      .matches(/^(\+254|0)[17]\d{8}$/).withMessage('Invalid Kenyan phone number'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('email').optional({ nullable: true }).isEmail().withMessage('Invalid email'),
    body('vehicleType').optional({ nullable: true }).isString(),
    body('vehiclePlate').optional({ nullable: true }).isString()
  ],
  validate,
  driverController.create
);

router.patch('/:id/vehicle',
  requireBusinessRole('admin'),
  [
    body('vehicleType').optional({ nullable: true }).isString(),
    body('vehiclePlate').optional({ nullable: true }).isString()
  ],
  validate,
  driverController.updateVehicle
);

router.patch('/:id/lock', requireBusinessRole('admin'), driverIdParamValidator, validate, driverController.lockAccount);
router.patch('/:id/unlock', requireBusinessRole('admin'), driverIdParamValidator, validate, driverController.unlockAccount);

router.patch('/:id/reset-password',
  requireBusinessRole('admin'),
  [body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')],
  validate,
  driverController.resetPassword
);

module.exports = router;
