const mongoose = require('mongoose');
const Order = require('../models/Order');
const ActivityLog = require('../models/ActivityLog');
const Branch = require('../models/Branch');
const settingsService = require('./settings.service');
const stockService = require('./stock.service');
const notificationService = require('./notification.service');
const reportService = require('./report.service');
const { escapeHtml } = require('../utils/escapeHtml');
const logger = require('../utils/logger');
const { startOfDayEAT } = require('../utils/businessTime');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const PAYMENT_FAILURE_WINDOW_MS = 24 * MS_PER_DAY;
const ORDER_SPIKE_MIN_BASELINE = 3; // don't flag a "spike" on a branch doing 1-2 orders/day normally
const ORDER_SPIKE_MULTIPLIER = 2;

// ── DORMANT CUSTOMERS (30/60/90+ day buckets) ─────────────────────────────────
const getDormantCustomers = async (branchId) => {
  const match = { status: 'completed', userId: { $ne: null } };
  if (branchId) match.branchId = new mongoose.Types.ObjectId(String(branchId));

  const lastOrders = await Order.aggregate([
    { $match: match },
    { $group: { _id: '$userId', lastOrderDate: { $max: '$createdAt' } } },
  ]);

  const now = Date.now();
  const buckets = { d30: 0, d60: 0, d90: 0 };
  for (const { lastOrderDate } of lastOrders) {
    const days = Math.floor((now - new Date(lastOrderDate)) / MS_PER_DAY);
    if (days >= 90) buckets.d90++;
    else if (days >= 60) buckets.d60++;
    else if (days >= 30) buckets.d30++;
  }
  return buckets;
};

// ── RECENT PAYMENT FAILURES ───────────────────────────────────────────────────
const getRecentPaymentFailures = async (branchId) => {
  const match = {
    action: 'PAYMENT_FAILED',
    timestamp: { $gte: new Date(Date.now() - PAYMENT_FAILURE_WINDOW_MS) },
  };
  if (branchId) match.branchId = new mongoose.Types.ObjectId(String(branchId));

  return ActivityLog.find(match)
    .sort({ timestamp: -1 })
    .limit(20)
    .select('detail targetId timestamp')
    .lean();
};

// ── RECENT ETIMS SUBMISSION FAILURES ──────────────────────────────────────────
// etimsRetry.job.js keeps retrying these in the background, but a submission
// that keeps failing was previously only visible by opening that one order's
// own detail page — surfaced here too, alongside the other pull-based alerts.
const getRecentEtimsFailures = async (branchId) => {
  const match = { etimsStatus: 'failed' };
  if (branchId) match.branchId = new mongoose.Types.ObjectId(String(branchId));

  return Order.find(match)
    .sort({ updatedAt: -1 })
    .limit(20)
    .select('orderRef total updatedAt')
    .lean();
};

// ── ORDER SPIKE DETECTION ─────────────────────────────────────────────────────
// Compares today's order count to the trailing 7-day daily average (excluding today).
const getOrderSpike = async (branchId) => {
  const match = {};
  if (branchId) match.branchId = new mongoose.Types.ObjectId(String(branchId));

  // EAT-aware, not server/UTC — matches getDashboardKPIs, so "today" here agrees
  // with what the dashboard's own KPI card calls today.
  const startOfToday = startOfDayEAT();
  const sevenDaysAgo = new Date(startOfToday.getTime() - 7 * MS_PER_DAY);

  const [todayCount, priorWeek] = await Promise.all([
    Order.countDocuments({ ...match, createdAt: { $gte: startOfToday } }),
    Order.countDocuments({ ...match, createdAt: { $gte: sevenDaysAgo, $lt: startOfToday } }),
  ]);

  const dailyAvg = priorWeek / 7;
  const isSpike = dailyAvg >= ORDER_SPIKE_MIN_BASELINE && todayCount >= dailyAvg * ORDER_SPIKE_MULTIPLIER;

  return { todayCount, dailyAvg: Math.round(dailyAvg * 10) / 10, isSpike };
};

// ── UNIFIED DASHBOARD (pull) ──────────────────────────────────────────────────
const getDashboardAlerts = async (branchId) => {
  const [lowStock, dormantCustomers, paymentFailures, orderSpike, etimsFailures] = await Promise.all([
    stockService.getLowStock(branchId),
    getDormantCustomers(branchId),
    getRecentPaymentFailures(branchId),
    getOrderSpike(branchId),
    getRecentEtimsFailures(branchId),
  ]);

  return {
    lowStock: { count: lowStock.length, items: lowStock.slice(0, 10) },
    dormantCustomers,
    paymentFailures: { count: paymentFailures.length, items: paymentFailures },
    orderSpike,
    etimsFailures: { count: etimsFailures.length, items: etimsFailures },
  };
};

// ── PUSH: NEW ORDER (fires on ORDER_EVENTS.PLACED, gated by notifyAdminNewOrder) ──
// A large order (total >= largeOrderThresholdKES, 0 = disabled) upgrades the
// alert and fires even when the routine new-order alert is switched off — a
// 40-bag wholesale order must not sit unnoticed in the pending queue.
const notifyNewOrder = async (order, branchId) => {
  const settings = await settingsService.getSettings(branchId);
  const threshold = Number(settings.largeOrderThresholdKES) || 0;
  const isLarge = threshold > 0 && order.total >= threshold;
  if (!settings.notifyAdminNewOrder && !isLarge) return;
  if (!settings.shopEmail && !settings.shopPhone) return;

  const totalBags = (order.orderItems || []).reduce((sum, i) => sum + (i.quantity || 0), 0);
  const preferredDate = order.preferredDeliveryDate
    ? new Date(order.preferredDeliveryDate).toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    : null;

  const subject = isLarge
    ? `⚠️ LARGE ORDER ${order.orderRef} — KES ${order.total?.toLocaleString()} (${totalBags} bags)`
    : `New order ${order.orderRef} — KES ${order.total?.toLocaleString()}`;
  const html = `<p>${isLarge ? `<strong>Large order</strong> placed (threshold KES ${threshold.toLocaleString()}) — review promptly.` : 'New order placed.'}</p>
    <p><strong>Reference:</strong> ${order.orderRef}<br/>
    <strong>Total:</strong> KES ${order.total?.toLocaleString()}<br/>
    <strong>Items:</strong> ${totalBags} bag${totalBags === 1 ? '' : 's'}<br/>
    <strong>Delivery:</strong> ${order.deliveryMethod}<br/>
    ${preferredDate ? `<strong>Requested date:</strong> ${preferredDate}<br/>` : ''}
    <strong>Payment:</strong> ${order.paymentMethod}</p>`;

  if (settings.shopEmail) {
    await notificationService.sendEmail({ to: settings.shopEmail, subject, html }).catch(err =>
      logger.error('[adminAlert] new order email failed', { err: err.message }));
  }

  if (settings.shopPhone) {
    await notificationService.sendSMS(
      settings.shopPhone,
      `${isLarge ? 'LARGE ORDER' : 'New order'} ${order.orderRef} — KES ${order.total?.toLocaleString()}, ${totalBags} bags (${order.deliveryMethod}, ${order.paymentMethod})${preferredDate ? ` for ${preferredDate}` : ''}`
    ).catch(err => logger.error('[adminAlert] new order SMS failed', { err: err.message }));
  }
};

// ── PUSH: LOW STOCK DIGEST (daily job, gated by notifyAdminLowStock) ─────────
const sendLowStockDigests = async () => {
  const branches = await Branch.find({ isActive: true }).select('_id').lean();

  for (const branch of branches) {
    try {
      const settings = await settingsService.getSettings(branch._id);
      if (!settings.notifyAdminLowStock || !settings.shopEmail) continue;

      const items = await stockService.getLowStock(branch._id);
      if (!items.length) continue;

      const rows = items.slice(0, 30).map(i =>
        `<tr><td style="padding:4px 8px">${i.productName} — ${i.varietyName} (${i.packagingSize})</td>
         <td style="padding:4px 8px">${i.stock} left</td></tr>`
      ).join('');

      await notificationService.sendEmail({
        to: settings.shopEmail,
        subject: `Low stock alert — ${items.length} item(s) need restocking`,
        html: `<p>${items.length} item(s) are low or out of stock:</p>
          <table>${rows}</table>`,
      });
    } catch (err) {
      logger.error('[adminAlert] low stock digest failed', { branchId: branch._id, err: err.message });
    }
  }
};

// ── PUSH: DAILY SALES REPORT (daily job, gated by notifyAdminDailySalesReport) ──
// Reports on the prior full EAT day — the job's own initial delay/interval is
// boot-relative (see jobs/dailySalesReport.job.js), so "today" would be a
// partial day depending on when the server last restarted; "yesterday" is
// always a complete, stable window regardless of when this actually runs.
const sendDailySalesReportEmail = async () => {
  const branches = await Branch.find({ isActive: true }).select('_id').lean();
  const yesterday = new Date(Date.now() - MS_PER_DAY);

  for (const branch of branches) {
    try {
      const settings = await settingsService.getSettings(branch._id);
      if (!settings.notifyAdminDailySalesReport || !settings.shopEmail) continue;

      const [sales, bestSellers] = await Promise.all([
        reportService.getSalesReport('custom', yesterday, yesterday, branch._id),
        reportService.getBestSellers('custom', yesterday, yesterday, 10, branch._id),
      ]);

      const { totalRevenue, totalOrders, avgOrderValue, totalItems } = sales.summary;
      const productRows = bestSellers.products.map(p =>
        `<tr><td style="padding:4px 8px">${escapeHtml(p.productName)} — ${escapeHtml(p.variety)} (${escapeHtml(p.packaging)})</td>
         <td style="padding:4px 8px">${p.unitsSold} sold</td>
         <td style="padding:4px 8px">KES ${p.revenue?.toLocaleString()}</td></tr>`
      ).join('');

      await notificationService.sendEmail({
        to: settings.shopEmail,
        subject: `Daily sales report — KES ${totalRevenue.toLocaleString()} (${totalOrders} order${totalOrders === 1 ? '' : 's'})`,
        html: `<p>Sales summary for ${yesterday.toDateString()}:</p>
          <p>Revenue: <strong>KES ${totalRevenue.toLocaleString()}</strong><br/>
          Orders: <strong>${totalOrders}</strong><br/>
          Avg order value: <strong>KES ${avgOrderValue.toLocaleString()}</strong><br/>
          Items sold: <strong>${totalItems}</strong></p>
          ${productRows ? `<p>Best sellers:</p><table>${productRows}</table>` : ''}`,
      });
    } catch (err) {
      logger.error('[adminAlert] daily sales report failed', { branchId: branch._id, err: err.message });
    }
  }
};

module.exports = { getDashboardAlerts, notifyNewOrder, sendLowStockDigests, sendDailySalesReportEmail };
