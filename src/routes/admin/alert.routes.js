const express = require('express');
const router = express.Router();
const alertController = require('../../controllers/admin/alert.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireMinRole } = require('../../middleware/role.middleware');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');

router.use(verifyToken, adminLimiter);

// GET /api/admin/alerts — low stock, dormant customers, payment failures, order spike
router.get('/', requireMinRole('supervisor'), alertController.getDashboardAlerts);

module.exports = router;
