const CustomerAlert = require('../models/CustomerAlert');
const notificationService = require('./notification.service');
const settingsService = require('./settings.service');
const logger = require('../utils/logger');

// ── SUBSCRIBE ─────────────────────────────────────────────────────────────────
const subscribe = async ({ userId, branchId, type, productId, productName, varietyName, packaging, priceAtSubscription }) => {
  // Deduplicate: one active alert per user/product/variety/packaging/type
  const existing = await CustomerAlert.findOne({
    userId, branchId, type, productId, varietyName, packaging, isActive: true,
  });
  if (existing) return existing;

  return CustomerAlert.create({
    userId, branchId, type, productId, productName, varietyName, packaging,
    priceAtSubscription: type === 'price_drop' ? (priceAtSubscription || null) : null,
  });
};

// ── UNSUBSCRIBE ───────────────────────────────────────────────────────────────
const unsubscribe = async (alertId, userId) => {
  const alert = await CustomerAlert.findOne({ _id: alertId, userId });
  if (!alert) return null;
  alert.isActive = false;
  await alert.save();
  return alert;
};

// ── LIST MY ALERTS ────────────────────────────────────────────────────────────
const getMyAlerts = async (userId) => {
  return CustomerAlert.find({ userId, isActive: true })
    .populate('productId', 'name')
    .sort({ createdAt: -1 })
    .lean();
};

// ── TRIGGER: BACK-IN-STOCK ────────────────────────────────────────────────────
// Called from stock.listener.js when stock goes from 0 → >0
const triggerBackInStock = async ({ productId, branchId, varietyName, packaging }) => {
  const alerts = await CustomerAlert.find({
    type: 'back_in_stock', productId, branchId, varietyName, packaging, isActive: true,
  }).populate('userId', 'name phone email');

  if (!alerts.length) return;

  const settings = await settingsService.getSettings(branchId).catch(() => null);

  for (const alert of alerts) {
    const user = alert.userId;
    if (!user) continue;

    try {
      if (settings?.smsEnabled && user.phone) {
        await notificationService.sendSMS(
          user.phone,
          `Hi ${user.name?.split(' ')[0] || 'there'}! "${alert.productName}" (${alert.varietyName} ${alert.packaging}) is back in stock. Order now at Vittorios Grains.`
        );
      }
      if (settings?.emailEnabled && user.email) {
        await notificationService.sendEmail({
          to: user.email,
          subject: `Back in stock: ${alert.productName}`,
          text: `Good news! ${alert.productName} — ${alert.varietyName} ${alert.packaging} is back in stock. Visit our shop to order.`,
          html: `<p>Good news! <strong>${alert.productName} — ${alert.varietyName} ${alert.packaging}</strong> is back in stock.</p><p>Visit our shop to place your order.</p>`,
        });
      }

      alert.isActive = false;
      alert.lastTriggeredAt = new Date();
      await alert.save();
    } catch (err) {
      logger.error('[alert] back_in_stock trigger failed', { userId: user._id, err: err.message });
    }
  }
};

// ── TRIGGER: PRICE DROP ───────────────────────────────────────────────────────
// Called from price.listener.js when a price drops
const triggerPriceDrop = async ({ productId, branchId, varietyName, packaging, oldPrice, newPrice }) => {
  if (newPrice >= oldPrice) return; // not a drop

  const alerts = await CustomerAlert.find({
    type: 'price_drop', productId, branchId, varietyName, packaging, isActive: true,
  }).populate('userId', 'name phone email');

  if (!alerts.length) return;

  const settings = await settingsService.getSettings(branchId).catch(() => null);
  const dropPct = Math.round(((oldPrice - newPrice) / oldPrice) * 100);
  const thresholdPct = settings?.priceAlertThresholdPct ?? 5;

  // Global threshold: ignore minor fluctuations
  if (dropPct < thresholdPct) return;

  for (const alert of alerts) {
    // Only notify if price dropped below what it was when the customer subscribed
    if (alert.priceAtSubscription && newPrice >= alert.priceAtSubscription) continue;

    const user = alert.userId;
    if (!user) continue;

    try {
      if (settings?.smsEnabled && user.phone) {
        await notificationService.sendSMS(
          user.phone,
          `Price drop alert! "${alert.productName}" (${alert.varietyName} ${alert.packaging}) dropped ${dropPct}% to KES ${newPrice.toLocaleString()}. Order now at Vittorios Grains.`
        );
      }
      if (settings?.emailEnabled && user.email) {
        await notificationService.sendEmail({
          to: user.email,
          subject: `Price drop: ${alert.productName} is now KES ${newPrice.toLocaleString()}`,
          text: `Price drop! ${alert.productName} — ${alert.varietyName} ${alert.packaging} dropped ${dropPct}% from KES ${oldPrice.toLocaleString()} to KES ${newPrice.toLocaleString()}.`,
          html: `<p><strong>Price drop!</strong> ${alert.productName} — ${alert.varietyName} ${alert.packaging} dropped <strong>${dropPct}%</strong> from KES ${oldPrice.toLocaleString()} to <strong>KES ${newPrice.toLocaleString()}</strong>.</p>`,
        });
      }

      alert.lastTriggeredAt = new Date();
      await alert.save();
    } catch (err) {
      logger.error('[alert] price_drop trigger failed', { userId: user._id, err: err.message });
    }
  }
};

module.exports = { subscribe, unsubscribe, getMyAlerts, triggerBackInStock, triggerPriceDrop };
