// ── ADMIN ALERTS JOB ──────────────────────────────────────────────────────────
// Runs daily. Sends a low-stock digest email per branch when notifyAdminLowStock
// is enabled in that branch's settings.

const adminAlertService = require('../services/adminAlert.service');
const logger = require('../utils/logger');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Delay first run so startup I/O settles before hitting the DB
const INITIAL_DELAY_MS = 5 * 60 * 1000;

const runLowStockDigest = async () => {
  logger.info('[ADMIN ALERTS] Low stock digest starting...');
  try {
    await adminAlertService.sendLowStockDigests();
    logger.info('[ADMIN ALERTS] Low stock digest done.');
  } catch (err) {
    logger.error('[ADMIN ALERTS] Low stock digest failed', { err: err.message });
  }
};

const startAdminAlertsJob = () => {
  setTimeout(() => {
    runLowStockDigest();
    setInterval(runLowStockDigest, MS_PER_DAY);
  }, INITIAL_DELAY_MS);

  logger.info('[ADMIN ALERTS] Low stock digest job scheduled (daily, first run in 5 min)');
};

module.exports = { startAdminAlertsJob };
