const express = require('express');
const router = express.Router();
const backupController = require('../../controllers/admin/backup.controller');
const { verifyToken, verifyTokenNoDb } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');

// Job progress must keep answering during a restore (which briefly empties the users collection) - see
// verifyTokenNoDb. Declared before the router-wide guard on purpose.
router.get('/jobs/:jobId', verifyTokenNoDb, requireRole('superadmin'), backupController.getJob);

router.use(verifyToken, requireRole('superadmin'), adminLimiter);

router.get('/', backupController.listBackups);
router.post('/', backupController.createBackup);
router.get('/:id/download', backupController.downloadBackup);
router.delete('/:id', backupController.deleteBackup);
router.post('/restore', backupController.uploadRestoreFile, backupController.restoreBackup);

module.exports = router;
