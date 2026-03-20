const express = require('express');
const router = express.Router();
const customerController = require('../../controllers/admin/customer.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireMinRole, requireBusinessRole } = require('../../middleware/role.middleware');
const { validate } = require('../../middleware/validate.middleware');
const { body } = require('express-validator');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');

router.use(verifyToken, adminLimiter);

// ── READ (superadmin CAN view — oversight) ────────────────────────────────────

// GET /api/admin/customers
router.get('/', requireMinRole('supervisor'), customerController.getAll);

// GET /api/admin/customers/segments
router.get('/segments', requireMinRole('supervisor'), customerController.getSegments);

// GET /api/admin/customers/:id
router.get('/:id', requireMinRole('supervisor'), customerController.getProfile);

// ── WRITE (superadmin CANNOT perform — business operations) ───────────────────

// POST /api/admin/customers/:id/notes
router.post(
  '/:id/notes',
  requireBusinessRole('supervisor'),
  [
    body('note')
      .trim()
      .notEmpty().withMessage('Note content is required')
      .isLength({ min: 2, max: 1000 }).withMessage('Note must be between 2 and 1000 characters')
  ],
  validate,
  customerController.addNote
);

module.exports = router;