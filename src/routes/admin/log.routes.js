const express = require('express');
const router = express.Router();
const logController = require('../../controllers/admin/log.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');

// Super-admin only - SRS 5.6
// Activity logs are read-only for ALL roles including Super-Admin - UX C6
router.use(verifyToken, requireRole('superadmin'), adminLimiter);

// GET /api/admin/logs?page=1&limit=20&action=ORDER_APPROVED&from=&to=
router.get('/', logController.getLogs);

module.exports = router;
