// ── CLEANUP JOB ───────────────────────────────────────────────────────────────
// Runs daily. Deletes ActivityLog entries older than each branch's
// logRetentionDays setting (Settings.logRetentionDays, default 90).
// Global/system logs (branchId: null) use a hardcoded 90-day fallback.
//
// No external cron library needed — a self-scheduling setInterval is enough
// for a once-a-day operation.

const ActivityLog = require('../models/ActivityLog');
const Settings    = require('../models/Settings');

const MS_PER_DAY             = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const RUN_INTERVAL_MS        = MS_PER_DAY;
// Delay first run by 2 minutes so startup I/O settles before cleanup hits the DB
const INITIAL_DELAY_MS       = 2 * 60 * 1000;

// ── CORE CLEANUP LOGIC ────────────────────────────────────────────────────────
const runActivityLogCleanup = async () => {
  console.log('[CLEANUP] Activity log cleanup starting...');
  let totalDeleted = 0;

  try {
    // Fetch every branch that has a positive retention window
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
        console.log(`[CLEANUP] Branch ${branchId}: removed ${deletedCount} log entries (>${logRetentionDays}d old)`);
        totalDeleted += deletedCount;
      }
    }

    // Global/system logs have no branchId — use the hardcoded default
    const globalCutoff = new Date(Date.now() - DEFAULT_RETENTION_DAYS * MS_PER_DAY);
    const { deletedCount: globalDeleted } = await ActivityLog.deleteMany({
      branchId: null,
      timestamp: { $lt: globalCutoff }
    });

    if (globalDeleted > 0) {
      console.log(`[CLEANUP] Global logs: removed ${globalDeleted} entries (>${DEFAULT_RETENTION_DAYS}d old)`);
      totalDeleted += globalDeleted;
    }

    console.log(`[CLEANUP] Done. Total removed: ${totalDeleted}`);
  } catch (err) {
    // Log and swallow — a cleanup failure must never crash the process
    console.error('[CLEANUP] Activity log cleanup failed:', err.message);
  }
};

// ── SCHEDULER ─────────────────────────────────────────────────────────────────
const startCleanupJobs = () => {
  setTimeout(() => {
    runActivityLogCleanup();
    setInterval(runActivityLogCleanup, RUN_INTERVAL_MS);
  }, INITIAL_DELAY_MS);

  console.log('[CLEANUP] Activity log cleanup job scheduled (daily, first run in 2 min)');
};

module.exports = { startCleanupJobs };
