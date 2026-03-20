const express = require('express');
const router = express.Router();
const settingsController = require('../../controllers/admin/settings.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireMinRole } = require('../../middleware/role.middleware');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');

router.use(verifyToken, adminLimiter);

// GET /api/admin/settings
router.get('/', requireMinRole('admin'), settingsController.getAll);

// PUT /api/admin/settings
// Admin can update shop info + order/notification settings
// SuperAdmin can additionally update system settings (maintenanceMode etc)
router.put('/', requireMinRole('admin'), settingsController.update);

module.exports = router;