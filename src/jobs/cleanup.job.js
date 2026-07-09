// ── CLEANUP JOB ───────────────────────────────────────────────────────────────
// Runs daily. Handles two tasks:
// 1. Deletes ActivityLog entries older than each branch's logRetentionDays setting.
// 2. Deletes Guest documents that have never placed an order, older than GUEST_RETENTION_DAYS.

const ActivityLog = require('../models/ActivityLog');
const Settings    = require('../models/Settings');
const Guest       = require('../models/Guest');
const logger      = require('../utils/logger');

const MS_PER_DAY             = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const GUEST_RETENTION_DAYS   = 90;
const RUN_INTERVAL_MS        = MS_PER_DAY;
// Delay first run by 2 minutes so startup I/O settles before cleanup hits the DB
const INITIAL_DELAY_MS       = 2 * 60 * 1000;

// ── ACTIVITY LOG CLEANUP ──────────────────────────────────────────────────────
const runActivityLogCleanup = async () => {
  logger.info('[CLEANUP] Activity log cleanup starting...');
  let totalDeleted = 0;

  try {
    const branchSettings = await Settings
      .find({ logRetentionDays: { $gt: 0 } })
      .select('branchId logRetentionDays')
      .lean();

    for (const { branchId, logRetentionDays } of branchSettings) {
      const cutoff = new Date(Date.now() - logRetentionDays * MS_PER_DAY);
      const { deletedCount } = await ActivityLog.deleteMany({
        branchId,
        timestamp: { $lt: cutoff }
      });

      if (deletedCount > 0) {
        logger.info(`[CLEANUP] Branch ${branchId}: removed ${deletedCount} log entries (>${logRetentionDays}d old)`);
        totalDeleted += deletedCount;
      }
    }

    const globalCutoff = new Date(Date.now() - DEFAULT_RETENTION_DAYS * MS_PER_DAY);
    const { deletedCount: globalDeleted } = await ActivityLog.deleteMany({
      branchId: null,
      timestamp: { $lt: globalCutoff }
    });

    if (globalDeleted > 0) {
      logger.info(`[CLEANUP] Global logs: removed ${globalDeleted} entries (>${DEFAULT_RETENTION_DAYS}d old)`);
      totalDeleted += globalDeleted;
    }

    logger.info(`[CLEANUP] Activity log done. Total removed: ${totalDeleted}`);
  } catch (err) {
    logger.error('[CLEANUP] Activity log cleanup failed', { err: err.message });
  }
};

// ── GUEST RECORD CLEANUP ──────────────────────────────────────────────────────
const runGuestCleanup = async () => {
  try {
    const cutoff = new Date(Date.now() - GUEST_RETENTION_DAYS * MS_PER_DAY);

    // "Orphaned" means never placed an order at all — a guest with any order
    // history (even a long-completed one) is a financial/KRA-relevant record
    // that Order.guestName/guestPhone snapshots depend on Guest still being
    // populate()-able where possible, and Guest.orders is the audit trail of
    // what this contact has bought. Previously this only checked for *active*
    // (non-terminal) orders, so a guest whose only order had already completed
    // was deleted — destroying the ability to look up their order history by
    // phone even though the order itself remains in the system.
    const oldGuests = await Guest.find({ createdAt: { $lt: cutoff } }).select('_id orders').lean();
    if (!oldGuests.length) return;

    const toDelete = oldGuests.filter(g => !g.orders || g.orders.length === 0).map(g => g._id);

    if (toDelete.length) {
      await Guest.deleteMany({ _id: { $in: toDelete } });
      logger.info(`[CLEANUP] Removed ${toDelete.length} orphaned guest records (>${GUEST_RETENTION_DAYS}d old)`);
    }
  } catch (err) {
    logger.error('[CLEANUP] Guest cleanup failed', { err: err.message });
  }
};

// ── SCHEDULER ─────────────────────────────────────────────────────────────────
const startCleanupJobs = () => {
  setTimeout(() => {
    runActivityLogCleanup();
    runGuestCleanup();
    setInterval(() => {
      runActivityLogCleanup();
      runGuestCleanup();
    }, RUN_INTERVAL_MS);
  }, INITIAL_DELAY_MS);

  logger.info('[CLEANUP] Cleanup jobs scheduled (daily, first run in 2 min)');
};

module.exports = { startCleanupJobs };
