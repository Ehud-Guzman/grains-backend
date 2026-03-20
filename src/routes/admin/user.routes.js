const express = require('express');
const router = express.Router();
const userController = require('../../controllers/admin/user.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { validate } = require('../../middleware/validate.middleware');
const { body } = require('express-validator');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');

// ALL routes here are super-admin only - SRS 5.6 + 8.3
router.use(verifyToken, requireRole('superadmin'), adminLimiter);

// GET /api/admin/users
router.get('/', userController.getAll);

// POST /api/admin/users - create new admin/staff account
router.post('/',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('phone').trim().notEmpty().withMessage('Phone is required')
      .matches(/^(\+254|0)[17]\d{8}$/).withMessage('Invalid Kenyan phone number'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('role').isIn(['staff', 'supervisor', 'admin', 'superadmin'])
      .withMessage('Role must be staff, supervisor, admin, or superadmin'),
    body('email').optional({ nullable: true }).isEmail().withMessage('Invalid email')
  ],
  validate,
  userController.create
);

// PUT /api/admin/users/:id/role - change role
router.put('/:id/role',
  [
    body('role').isIn(['staff', 'supervisor', 'admin', 'superadmin'])
      .withMessage('Invalid role')
  ],
  validate,
  userController.changeRole
);

// PATCH /api/admin/users/:id/lock
router.patch('/:id/lock', userController.lockAccount);

// PATCH /api/admin/users/:id/unlock
router.patch('/:id/unlock', userController.unlockAccount);

// PATCH /api/admin/users/:id/reset-password
router.patch('/:id/reset-password',
  [
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
  ],
  validate,
  userController.resetPassword
);

module.exports = router;
