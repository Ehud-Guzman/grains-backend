const multer = require('multer');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const backupService = require('../../services/backup.service');
const backupJobs = require('../../services/backupJobs');
const activityLogService = require('../../services/activityLog.service');
const { LOG_ACTIONS } = require('../../utils/constants');
const { success } = require('../../utils/apiResponse');
const { AppError } = require('../../middleware/errorHandler.middleware');

// A restore file goes to a temp file on disk, not into memory: a year of orders gzips to many MB and the
// restore reads it back as a stream (2026-10 audit, F-09). Env BACKUP_UPLOAD_MAX_MB (default 200).
const MAX_UPLOAD_MB = Number(process.env.BACKUP_UPLOAD_MAX_MB) || 200;
const restoreUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, _file, cb) => cb(null, `grains-restore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.upload`),
  }),
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024,
    files: 1,
  },
}).single('backup');

const uploadRestoreFile = (req, res, next) => {
  restoreUpload(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError(`Backup file is too large. Maximum size is ${MAX_UPLOAD_MB}MB.`, 400, 'FILE_TOO_LARGE'));
      }
      return next(new AppError(err.message, 400, 'UPLOAD_ERROR'));
    }
    if (err) return next(err);
    return next();
  });
};

const removeUpload = (file) => (file?.path ? fs.unlink(file.path).catch(() => {}) : Promise.resolve());

const wantsAsync = (req) => req.query.async === 'true';

const listBackups = async (req, res, next) => {
  try {
    const result = await backupService.getBackupStorageSummary();
    return success(res, { ...result, runningJob: backupJobs.runningJob() });
  } catch (err) {
    next(err);
  }
};

const logBackupCreated = (req, backup) => activityLogService.log({
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

const createBackup = async (req, res, next) => {
  try {
    const actor = { actorId: req.user.id, actorRole: req.user.role };

    if (wantsAsync(req)) {
      const job = backupJobs.startJob('backup', async (report) => {
        const backup = await backupService.createBackup({ ...actor, onProgress: report });
        await logBackupCreated(req, backup);
        return backup;
      });
      return success(res, job, 'Backup started', 202);
    }

    const backup = await backupService.createBackup(actor);
    await logBackupCreated(req, backup);
    return success(res, backup, 'Backup created successfully', 201);
  } catch (err) {
    next(err);
  }
};

const downloadBackup = async (req, res, next) => {
  try {
    const { entry, stream } = await backupService.openBackupDownload(req.params.id);

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}"`);
    // Streamed: the file is never held in memory, and a tampered/corrupt encrypted file aborts the transfer.
    await pipeline(stream, res);
  } catch (err) {
    // After the headers are sent the only honest signal left is to cut the connection.
    if (res.headersSent) return res.destroy(err);
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
  const file = req.file;
  let handedToJob = false;   // once a background job owns the temp file, the job removes it
  try {
    const args = {
      file: file && { path: file.path, buffer: file.buffer, originalname: file.originalname },
      confirmation: req.body.confirmation,
      actorId: req.user.id,
      actorRole: req.user.role,
      ip: req.ip,
    };

    if (wantsAsync(req)) {
      const job = backupJobs.startJob('restore', async (report) => {
        try {
          return await backupService.restoreBackup({ ...args, onProgress: report });
        } finally {
          await removeUpload(file);
        }
      });
      handedToJob = true;
      return success(res, job, 'Restore started', 202);
    }

    const result = await backupService.restoreBackup(args);
    return success(res, result, 'Backup restored successfully');
  } catch (err) {
    next(err);
  } finally {
    if (!handedToJob) await removeUpload(file);
  }
};

const getJob = (req, res, next) => {
  try {
    return success(res, backupJobs.getJob(req.params.jobId));
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
  getJob,
};
