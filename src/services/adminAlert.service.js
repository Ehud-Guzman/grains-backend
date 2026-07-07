const mongoose = require('mongoose');
const Order = require('../models/Order');
const ActivityLog = require('../models/ActivityLog');
const Branch = require('../models/Branch');
const settingsService = require('./settings.service');
const stockService = require('./stock.service');
const notificationService = require('./notification.service');
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
const notifyNewOrder = async (order, branchId) => {
  const settings = await settingsService.getSettings(branchId);
  if (!settings.notifyAdminNewOrder) return;
  if (!settings.shopEmail && !settings.shopPhone) return;

  const subject = `New order ${order.orderRef} — KES ${order.total?.toLocaleString()}`;
  const html = `<p>New order placed.</p>
    <p><strong>Reference:</strong> ${order.orderRef}<br/>
    <strong>Total:</strong> KES ${order.total?.toLocaleString()}<br/>
    <strong>Delivery:</strong> ${order.deliveryMethod}<br/>
    <strong>Payment:</strong> ${order.paymentMethod}</p>`;

  if (settings.shopEmail) {
    await notificationService.sendEmail({ to: settings.shopEmail, subject, html }).catch(err =>
      logger.error('[adminAlert] new order email failed', { err: err.message }));
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

module.exports = { getDashboardAlerts, notifyNewOrder, sendLowStockDigests };
