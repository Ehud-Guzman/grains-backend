const multer = require('multer');
const backupService = require('../../services/backup.service');
const activityLogService = require('../../services/activityLog.service');
const { LOG_ACTIONS } = require('../../utils/constants');
const { success } = require('../../utils/apiResponse');
const { AppError } = require('../../middleware/errorHandler.middleware');

const restoreUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 1,
  },
}).single('backup');

const uploadRestoreFile = (req, res, next) => {
  restoreUpload(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError('Backup file is too large. Maximum size is 50MB.', 400, 'FILE_TOO_LARGE'));
      }
      return next(new AppError(err.message, 400, 'UPLOAD_ERROR'));
    }
    if (err) return next(err);
    return next();
  });
};

const listBackups = async (req, res, next) => {
  try {
    const result = await backupService.getBackupStorageSummary();
    return success(res, result);
  } catch (err) {
    next(err);
  }
};

const createBackup = async (req, res, next) => {
  try {
    const backup = await backupService.createBackup({
      actorId: req.user.id,
      actorRole: req.user.role,
    });

    await activityLogService.log({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: LOG_ACTIONS.SYSTEM_BACKUP_CREATED,
      targetType: 'SystemBackup',
      detail: {
        backupId: backup.id,
        filename: backup.filename,
        counts: backup.counts,
      },
      ip: req.ip,
    });

    return success(res, backup, 'Backup created successfully', 201);
  } catch (err) {
    next(err);
  }
};

const downloadBackup = async (req, res, next) => {
  try {
    const { entry, buffer } = await backupService.getBackupDownload(req.params.id);

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}"`);
    return res.send(buffer);
  } catch (err) {
    next(err);
  }
};

const deleteBackup = async (req, res, next) => {
  try {
    const backup = await backupService.deleteBackup(req.params.id);

    await activityLogService.log({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: LOG_ACTIONS.SYSTEM_BACKUP_DELETED,
      targetType: 'SystemBackup',
      detail: {
        backupId: backup.id,
        filename: backup.filename,
      },
      ip: req.ip,
    });

    return success(res, backup, 'Backup deleted successfully');
  } catch (err) {
    next(err);
  }
};

const restoreBackup = async (req, res, next) => {
  try {
    const result = await backupService.restoreBackup({
      file: req.file,
      confirmation: req.body.confirmation,
      actorId: req.user.id,
      actorRole: req.user.role,
      ip: req.ip,
    });

    return success(res, result, 'Backup restored successfully');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  uploadRestoreFile,
  listBackups,
  createBackup,
  downloadBackup,
  deleteBackup,
  restoreBackup,
};
