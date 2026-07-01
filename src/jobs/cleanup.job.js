// ── CLEANUP JOB ───────────────────────────────────────────────────────────────
// Runs daily. Handles two tasks:
// 1. Deletes ActivityLog entries older than each branch's logRetentionDays setting.
// 2. Deletes Guest documents with no active orders older than GUEST_RETENTION_DAYS.

const ActivityLog = require('../models/ActivityLog');
const Settings    = require('../models/Settings');
const Guest       = require('../models/Guest');
const Order       = require('../models/Order');
const logger      = require('../utils/logger');

const MS_PER_DAY             = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const GUEST_RETENTION_DAYS   = 90;
const RUN_INTERVAL_MS        = MS_PER_DAY;
// Delay first run by 2 minutes so startup I/O settles before cleanup hits the DB
const INITIAL_DELAY_MS       = 2 * 60 * 1000;

const ACTIVE_ORDER_STATUSES = ['pending', 'approved', 'preparing', 'out_for_delivery'];

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

    const oldGuests = await Guest.find({ createdAt: { $lt: cutoff } }).select('_id').lean();
    if (!oldGuests.length) return;

    const guestIds = oldGuests.map(g => g._id);

    // Retain guests that still have at least one active (non-terminal) order
    const activeGuestIds = await Order.distinct('guestId', {
      guestId: { $in: guestIds },
      status: { $in: ACTIVE_ORDER_STATUSES }
    });

    const activeSet = new Set(activeGuestIds.map(id => id.toString()));
    const toDelete = guestIds.filter(id => !activeSet.has(id.toString()));

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
