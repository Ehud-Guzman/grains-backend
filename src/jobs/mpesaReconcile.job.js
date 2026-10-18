// ── M-PESA RECONCILIATION JOB ─────────────────────────────────────────────────
// Runs every 2 minutes. Finds M-Pesa payments still "pending" a few minutes after the STK prompt was
// sent - the sign that Safaricom's callback never reached us - and asks Daraja what happened to them
// (payment.service#reconcilePendingPayments). Without this a customer who paid could be left with an
// "unpaid" order that cannot be approved until a person noticed it in the cash-up report.
//
// Does nothing, and costs nothing, when M-Pesa is not configured or no payment is waiting.

const { reconcilePendingPayments } = require('../services/payment.service');
const { runGuarded } = require('../services/jobControl.service');
const logger = require('../utils/logger');

const RUN_INTERVAL_MS = 2 * 60 * 1000;   // every 2 minutes
const INITIAL_DELAY_MS = 2 * 60 * 1000;  // let startup settle first

const isMpesaConfigured = () => !!(
  process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_SECRET &&
  process.env.MPESA_SHORTCODE && process.env.MPESA_PASSKEY
);

// A run can outlast the interval when Daraja is slow (each lookup has its own timeout). Never let
// two overlap - they would query, and try to apply, the same payments twice.
let running = false;

const runReconcile = () => runGuarded('mpesa-reconcile', async () => {
  if (running || !isMpesaConfigured()) return;
  running = true;
  try {
    const summary = await reconcilePendingPayments();
    if (summary.checked > 0) logger.info('[M-PESA RECONCILE] Pending payments checked', summary);
  } finally {
    running = false;
  }
});

const startMpesaReconcileJob = () => {
  setTimeout(() => {
    runReconcile();
    setInterval(runReconcile, RUN_INTERVAL_MS);
  }, INITIAL_DELAY_MS);

  logger.info('[M-PESA RECONCILE] Stuck-payment check scheduled (every 2 min, first run in 2 min)');
};

module.exports = { startMpesaReconcileJob };
