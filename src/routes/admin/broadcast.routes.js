const express = require('express');
const router = express.Router();
const broadcastController = require('../../controllers/admin/broadcast.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireMinRole, requireBusinessRole } = require('../../middleware/role.middleware');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');
const { checkPlatformLock } = require('../../middleware/platformLock.middleware');

// Admin-only (not supervisor) — real SMS cost + spam risk, so this is deliberately
// gated tighter than most reporting/management endpoints.
// The read is an oversight concern (superadmin may inspect it); SENDING is a
// business operation, so it uses requireBusinessRole and excludes superadmin.
router.use(verifyToken, adminLimiter, checkPlatformLock);

router.get('/audience-count', requireMinRole('admin'), broadcastController.getAudienceCount);
router.post('/sms', requireBusinessRole('admin'), broadcastController.send);

module.exports = router;
