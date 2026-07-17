const express = require('express');
const router = express.Router();
const broadcastController = require('../../controllers/admin/broadcast.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireMinRole } = require('../../middleware/role.middleware');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');
const { checkPlatformLock } = require('../../middleware/platformLock.middleware');

// Admin-only (not supervisor) — real SMS cost + spam risk, so this is deliberately
// gated tighter than most reporting/management endpoints.
router.use(verifyToken, requireMinRole('admin'), adminLimiter, checkPlatformLock);

router.get('/audience-count', broadcastController.getAudienceCount);
router.post('/sms', broadcastController.send);

module.exports = router;
