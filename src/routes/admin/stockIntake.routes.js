const express = require('express');
const router = express.Router();
const stockIntakeController = require('../../controllers/admin/stockIntake.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireMinRole, requireBusinessRole } = require('../../middleware/role.middleware');
const { validate } = require('../../middleware/validate.middleware');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');
const { createIntakeValidator, processIntakeValidator } = require('../../validators/stockIntake.validator');

router.use(verifyToken, adminLimiter);

// GET /api/admin/stock-intake
// List all intake records — supervisor+ can read; superadmin can observe
router.get('/', requireMinRole('supervisor'), stockIntakeController.list);

// GET /api/admin/stock-intake/:id
router.get('/:id', requireMinRole('supervisor'), stockIntakeController.getOne);

// POST /api/admin/stock-intake
// Create a new intake record — business roles only (not superadmin standalone)
router.post('/', requireBusinessRole('supervisor'), createIntakeValidator, validate, stockIntakeController.create);

// PATCH /api/admin/stock-intake/:id/process
// Mark an intake as processed
router.patch('/:id/process', requireBusinessRole('supervisor'), processIntakeValidator, validate, stockIntakeController.markProcessed);

// DELETE /api/admin/stock-intake/:id
// Delete only if still pending
router.delete('/:id', requireBusinessRole('supervisor'), stockIntakeController.remove);

module.exports = router;
