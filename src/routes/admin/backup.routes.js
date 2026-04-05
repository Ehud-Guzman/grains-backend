const express = require('express');
const router = express.Router();
const backupController = require('../../controllers/admin/backup.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');

router.use(verifyToken, requireRole('superadmin'), adminLimiter);

router.get('/', backupController.listBackups);
router.post('/', backupController.createBackup);
router.get('/:id/download', backupController.downloadBackup);
router.delete('/:id', backupController.deleteBackup);
router.post('/restore', backupController.uploadRestoreFile, backupController.restoreBackup);

module.exports = router;
