// ── ETIMS RETRY JOB ───────────────────────────────────────────────────────────
// Runs periodically. Re-attempts orders stuck at etimsStatus:'failed' — a
// transient KRA/network failure previously had no automatic retry, so a failed
// submission just sat there until an admin happened to open that exact order
// and hit "resubmit" manually.

const Order = require('../models/Order');
const etimsService = require('../services/etims.service');
const logger = require('../utils/logger');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes
const INITIAL_DELAY_MS = 5 * 60 * 1000;   // let startup I/O settle first
// Don't retry forever — an invoice still failing after a week is almost
// certainly a data problem (bad KRA PIN, misconfigured credentials) that needs
// a human via the manual resubmit route, not another automatic attempt.
const MAX_AGE_MS = 7 * MS_PER_DAY;

const runEtimsRetry = async () => {
  const candidates = await Order.find({
    etimsStatus: 'failed',
    updatedAt: { $gte: new Date(Date.now() - MAX_AGE_MS) }
  }).select('_id orderRef').lean();

  if (candidates.length === 0) return;

  logger.info('[ETIMS RETRY] Retrying failed submissions', { count: candidates.length });

  for (const { _id, orderRef } of candidates) {
    try {
      await etimsService.submitInvoice(_id);
    } catch (err) {
      // submitInvoice already marks the order 'failed' again and logs internally —
      // just make sure one bad order can't stop the rest of this batch.
      logger.warn('[ETIMS RETRY] Retry failed, will try again next cycle', { orderId: _id, orderRef, err: err.message });
    }
  }
};

const startEtimsRetryJob = () => {
  setTimeout(() => {
    runEtimsRetry().catch(err => logger.error('[ETIMS RETRY] Job run failed', { err: err.message }));
    setInterval(() => {
      runEtimsRetry().catch(err => logger.error('[ETIMS RETRY] Job run failed', { err: err.message }));
    }, RETRY_INTERVAL_MS);
  }, INITIAL_DELAY_MS);

  logger.info('[ETIMS RETRY] Retry job scheduled (every 30 min, first run in 5 min)');
};

module.exports = { startEtimsRetryJob };
