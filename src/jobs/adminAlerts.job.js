// ── ADMIN ALERTS JOB ──────────────────────────────────────────────────────────
// Runs once a day, from 07:00 Nairobi time. Sends a low-stock digest email per branch when
// notifyAdminLowStock is enabled in that branch's settings. Scheduled like dailySalesReport.job.js.

const adminAlertService = require('../services/adminAlert.service');
const { runDaily } = require('../services/jobControl.service');
const logger = require('../utils/logger');

const POLL_MS = 15 * 60 * 1000;
// Delay first check so startup I/O settles before hitting the DB
const INITIAL_DELAY_MS = 2 * 60 * 1000;

const runLowStockDigest = () => runDaily('low-stock-digest', 7, async () => {
  logger.info('[ADMIN ALERTS] Low stock digest starting...');
  await adminAlertService.sendLowStockDigests();
  logger.info('[ADMIN ALERTS] Low stock digest done.');
});

const startAdminAlertsJob = () => {
  setTimeout(() => {
    runLowStockDigest();
    setInterval(runLowStockDigest, POLL_MS).unref();
  }, INITIAL_DELAY_MS).unref();

  logger.info('[ADMIN ALERTS] Low stock digest job scheduled (daily from 07:00 Nairobi, checked every 15 min)');
};

module.exports = { startAdminAlertsJob };
