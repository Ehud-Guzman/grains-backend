// ── DAILY SALES REPORT JOB ───────────────────────────────────────────────────
// Runs once a day, from 06:00 Nairobi time. Emails a sales summary for the prior day per branch when
// notifyAdminDailySalesReport is enabled in that branch's settings.
// A poller checks every 15 minutes whether today's run is due (jobControl.runDaily): the "last sent for"
// date is stored in the database, so restarts never re-send yesterday's report and a server that was
// asleep at 06:00 sends it as soon as it wakes.

const adminAlertService = require('../services/adminAlert.service');
const { runDaily } = require('../services/jobControl.service');
const logger = require('../utils/logger');

const POLL_MS = 15 * 60 * 1000;
// Delay first check so startup I/O settles before hitting the DB
const INITIAL_DELAY_MS = 2 * 60 * 1000;

const runDailySalesReport = () => runDaily('daily-sales-report', 6, async () => {
  logger.info('[DAILY SALES REPORT] Starting...');
  await adminAlertService.sendDailySalesReportEmail();
  logger.info('[DAILY SALES REPORT] Done.');
});

const startDailySalesReportJob = () => {
  setTimeout(() => {
    runDailySalesReport();
    setInterval(runDailySalesReport, POLL_MS).unref();
  }, INITIAL_DELAY_MS).unref();

  logger.info('[DAILY SALES REPORT] Job scheduled (daily from 06:00 Nairobi, checked every 15 min)');
};

module.exports = { startDailySalesReportJob };
