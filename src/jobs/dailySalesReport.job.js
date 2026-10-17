// ── DAILY SALES REPORT JOB ───────────────────────────────────────────────────
// Runs daily. Emails a sales summary for the prior day per branch when
// notifyAdminDailySalesReport is enabled in that branch's settings.
// Boot-relative, like adminAlerts.job.js — it drifts with server restarts, not
// tied to a fixed wall-clock time.

const adminAlertService = require('../services/adminAlert.service');
const { runGuarded } = require('../services/jobControl.service');
const logger = require('../utils/logger');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Delay first run so startup I/O settles before hitting the DB
const INITIAL_DELAY_MS = 5 * 60 * 1000;

const runDailySalesReport = () => runGuarded('daily-sales-report', async () => {
  logger.info('[DAILY SALES REPORT] Starting...');
  await adminAlertService.sendDailySalesReportEmail();
  logger.info('[DAILY SALES REPORT] Done.');
});

const startDailySalesReportJob = () => {
  setTimeout(() => {
    runDailySalesReport();
    setInterval(runDailySalesReport, MS_PER_DAY);
  }, INITIAL_DELAY_MS);

  logger.info('[DAILY SALES REPORT] Job scheduled (daily, first run in 5 min)');
};

module.exports = { startDailySalesReportJob };
