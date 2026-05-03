// ── AUTO-CANCEL JOB ───────────────────────────────────────────────────────────
// Runs every 5 minutes. Cancels pending orders that have been waiting longer
// than the branch's autoCancelHours setting.
//
// The same logic also runs opportunistically during order API calls, but that
// only fires when someone is actively using the system. This job ensures orders
// are also cancelled overnight or during quiet periods with no traffic.

const Branch = require('../models/Branch');
const { autoCancelExpiredPendingOrders } = require('../services/order.service');
const logger = require('../utils/logger');

const RUN_INTERVAL_MS = 5 * 60 * 1000;   // every 5 minutes
const INITIAL_DELAY_MS = 3 * 60 * 1000;  // first run 3 min after startup

const runAutoCancel = async () => {
  try {
    const branches = await Branch.find({ isActive: true }).select('_id').lean();
    for (const { _id } of branches) {
      await autoCancelExpiredPendingOrders(_id);
    }
  } catch (err) {
    // Log and swallow — a job failure must never crash the process
    logger.error('[AUTO-CANCEL] Job failed', { err: err.message });
  }
};

const startAutoCancelJob = () => {
  setTimeout(() => {
    runAutoCancel();
    setInterval(runAutoCancel, RUN_INTERVAL_MS);
  }, INITIAL_DELAY_MS);

  logger.info('[AUTO-CANCEL] Order expiry job scheduled (every 5 min, first run in 3 min)');
};

module.exports = { startAutoCancelJob };
