const express = require('express');
const router = express.Router();
const settingsController = require('../../controllers/admin/settings.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireMinRole, requireRole } = require('../../middleware/role.middleware');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');
const { validate } = require('../../middleware/validate.middleware');
const { updateSettingsValidator } = require('../../validators/settings.validator');

router.use(verifyToken, adminLimiter);

// GET /api/admin/settings
router.get('/', requireMinRole('admin'), settingsController.getAll);

// POST /api/admin/settings/test-email — send a test email to verify Brevo config
router.post('/test-email', requireMinRole('admin'), settingsController.testEmail);

// PUT /api/admin/settings
router.put('/', requireMinRole('admin'), updateSettingsValidator, validate, settingsController.update);

// GET /api/admin/settings/branch/:branchId  — superadmin cross-branch read
router.get('/branch/:branchId', requireRole('superadmin'), settingsController.getForBranch);

// PUT /api/admin/settings/branch/:branchId  — superadmin cross-branch write
router.put('/branch/:branchId', requireRole('superadmin'), updateSettingsValidator, validate, settingsController.updateForBranch);

module.exports = router;