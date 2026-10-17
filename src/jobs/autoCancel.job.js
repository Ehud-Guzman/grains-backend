// ── AUTO-CANCEL JOB ───────────────────────────────────────────────────────────
// Runs every 5 minutes. Cancels pending orders that have been waiting longer
// than the branch's autoCancelHours setting. This is the only place
// autoCancelExpiredPendingOrders runs — order API calls no longer trigger it
// opportunistically (that per-request path was removed; see order.service.js).

const Branch = require('../models/Branch');
const { autoCancelExpiredPendingOrders } = require('../services/order.service');
const { runGuarded } = require('../services/jobControl.service');
const logger = require('../utils/logger');

const RUN_INTERVAL_MS = 5 * 60 * 1000;   // every 5 minutes
const INITIAL_DELAY_MS = 3 * 60 * 1000;  // first run 3 min after startup

// runGuarded honours the Control Center's pause switch, records the outcome, and
// logs-and-swallows any failure — a job failure must never crash the process.
const runAutoCancel = () => runGuarded('auto-cancel', async () => {
  const branches = await Branch.find({ isActive: true }).select('_id').lean();
  for (const { _id } of branches) {
    await autoCancelExpiredPendingOrders(_id);
  }
});

const startAutoCancelJob = () => {
  setTimeout(() => {
    runAutoCancel();
    setInterval(runAutoCancel, RUN_INTERVAL_MS);
  }, INITIAL_DELAY_MS);

  logger.info('[AUTO-CANCEL] Order expiry job scheduled (every 5 min, first run in 3 min)');
};

module.exports = { startAutoCancelJob };
