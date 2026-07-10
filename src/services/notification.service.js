const nodemailer = require('nodemailer');
const AfricasTalking = require('africastalking');
const settingsService = require('./settings.service');
const User = require('../models/User');
const Guest = require('../models/Guest');
const logger = require('../utils/logger');
const { escapeHtml } = require('../utils/escapeHtml');

// ── INITIALISE PROVIDERS ──────────────────────────────────────────────────────

// Gmail SMTP transporter — created once, reused for all emails
let emailTransporter = null;
if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
  emailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

let atSMS = null;
if (process.env.AT_API_KEY && process.env.AT_USERNAME) {
  const at = AfricasTalking({
    apiKey: process.env.AT_API_KEY,
    username: process.env.AT_USERNAME,
  });
  atSMS = at.SMS;
}

// ── LOW-LEVEL SENDERS ─────────────────────────────────────────────────────────

// Normalise Kenyan phone numbers to E.164 format required by Africa's Talking
const normalisePhone = (phone) => {
  if (!phone) return '';
  const cleaned = phone.replace(/[\s\-()]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('0')) return '+254' + cleaned.slice(1);
  if (cleaned.startsWith('254')) return '+' + cleaned;
  return cleaned;
};

const sendSMS = async (to, message) => {
  if (!atSMS) {
    logger.warn('[SMS] Africa\'s Talking not configured — check AT_USERNAME and AT_API_KEY in .env');
    return;
  }
  const phone = normalisePhone(to);
  if (!phone) return;
  const opts = { to: [phone], message };
  if (process.env.AT_SENDER_ID) opts.from = process.env.AT_SENDER_ID;
  await atSMS.send(opts);
};

// Bulk send — one AT call per batch of recipients (chunked to keep each request
// a sane size). Returns { sent, failed } — never throws, since a broadcast to
// hundreds of numbers must not abort partway on one bad batch.
const BROADCAST_BATCH_SIZE = 100;

const sendBulkSMS = async (recipients, message) => {
  if (!atSMS) {
    logger.warn('[SMS] Africa\'s Talking not configured — check AT_USERNAME and AT_API_KEY in .env');
    return { sent: 0, failed: recipients.length };
  }
  const phones = [...new Set(recipients.map(normalisePhone).filter(Boolean))];
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < phones.length; i += BROADCAST_BATCH_SIZE) {
    const batch = phones.slice(i, i + BROADCAST_BATCH_SIZE);
    const opts = { to: batch, message };
    if (process.env.AT_SENDER_ID) opts.from = process.env.AT_SENDER_ID;
    try {
      await atSMS.send(opts);
      sent += batch.length;
    } catch (err) {
      logger.error('[SMS] Broadcast batch failed', { err: err.message, batchSize: batch.length });
      failed += batch.length;
    }
  }
  return { sent, failed };
};

const sendEmail = async ({ to, subject, html }) => {
  if (!emailTransporter) {
    logger.warn('[Email] Gmail not configured — check GMAIL_USER and GMAIL_APP_PASSWORD in .env');
    return;
  }
  if (!to) return;
  await emailTransporter.sendMail({
    from: `"${process.env.EMAIL_FROM_NAME || 'Vittorios Grains & Cereals'}" <${process.env.EMAIL_FROM || 'orders@grainscereals.co.ke'}>`,
    to,
    subject,
    html,
  });
};

// ── CONTACT RESOLVER ──────────────────────────────────────────────────────────

// Returns { name, phone, email } for the customer on the order (guest or registered).
const getOrderContact = async (order) => {
  if (order.userId) {
    const user = await User.findById(order.userId, 'name phone email').lean();
    if (!user) return null;
    return { name: user.name, phone: user.phone, email: user.email || null };
  }
  if (order.guestId) {
    const guest = await Guest.findById(order.guestId, 'name phone').lean();
    if (guest) return { name: guest.name, phone: guest.phone, email: null };
    // Guest doc missing (e.g. purged by cleanup.job.js's retention sweep) —
    // fall back to the name/phone snapshotted on the order itself at creation
    // rather than silently dropping the notification.
    if (order.guestName && order.guestPhone) {
      return { name: order.guestName, phone: order.guestPhone, email: null };
    }
    return null;
  }
  return null;
};

// ── EMAIL TEMPLATE ────────────────────────────────────────────────────────────

const emailShell = (shopName, shopLocation, body) => `
<!DOCTYPE html><html>
<head><meta charset="utf-8"><style>
  body{font-family:Arial,sans-serif;color:#333;background:#f4f4f4;margin:0;padding:0}
  .wrap{max-width:560px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)}
  .hd{background:#1a5c38;color:#fff;padding:22px 32px}
  .hd h1{margin:0;font-size:19px;font-weight:700}
  .bd{padding:28px 32px;line-height:1.6}
  .ft{background:#f0f0f0;padding:14px 32px;font-size:12px;color:#888}
  .ref{font-weight:700;color:#1a5c38}
  table.items{width:100%;border-collapse:collapse;margin:14px 0}
  table.items th{text-align:left;font-size:11px;color:#888;border-bottom:1px solid #eee;padding:5px 0}
  table.items td{padding:6px 0;font-size:13px;border-bottom:1px solid #f5f5f5}
  .total-row{font-weight:700;font-size:15px;margin-top:14px}
  .badge{display:inline-block;padding:3px 11px;border-radius:20px;font-size:12px;font-weight:700}
  .green{background:#d1fae5;color:#065f46}
  .red{background:#fee2e2;color:#991b1b}
  .blue{background:#dbeafe;color:#1e40af}
</style></head>
<body>
<div class="wrap">
  <div class="hd"><h1>${shopName}</h1></div>
  <div class="bd">${body}</div>
  <div class="ft">${shopName} &middot; ${shopLocation}</div>
</div>
</body></html>
`;

const itemsTable = (orderItems = []) => {
  if (!orderItems.length) return '';
  const rows = orderItems.map(i =>
    `<tr>
      <td>${escapeHtml(i.productName)} &mdash; ${escapeHtml(i.variety)} (${escapeHtml(i.packaging)})</td>
      <td style="text-align:center">${i.quantity}</td>
      <td style="text-align:right">KES ${(i.unitPrice * i.quantity).toLocaleString()}</td>
    </tr>`
  ).join('');
  return `
    <table class="items">
      <tr><th>Item</th><th style="text-align:center">Qty</th><th style="text-align:right">Price</th></tr>
      ${rows}
    </table>
  `;
};

// ── EVENT DISPATCHERS ─────────────────────────────────────────────────────────

// 1. Order placed — confirmation to customer
const dispatchOrderPlaced = async (order, branchId) => {
  try {
    const [settings, contact] = await Promise.all([
      settingsService.getSettings(branchId),
      getOrderContact(order),
    ]);
    if (!contact) return;

    const shop = settings.shopName || 'Vittorios Grains & Cereals';
    const loc  = settings.shopLocation || 'Kenya';
    const ref  = order.orderRef;
    const total = `KES ${Number(order.total || 0).toLocaleString()}`;

    if (settings.smsEnabled && contact.phone) {
      await sendSMS(contact.phone,
        `Hi ${contact.name}, your order ${ref} (${total}) has been received! We will confirm it shortly. – ${shop}`
      ).catch(err => logger.error('[notification] dispatchOrderPlaced SMS failed', { err: err.message }));
    }

    if (settings.emailEnabled && contact.email) {
      await sendEmail({
        to: contact.email,
        subject: `Order Received – ${ref}`,
        html: emailShell(shop, loc, `
          <p>Hi <strong>${escapeHtml(contact.name)}</strong>,</p>
          <p>We have received your order <span class="ref">${ref}</span> and it is pending confirmation.</p>
          ${itemsTable(order.orderItems)}
          <p class="total-row">Total: ${total}</p>
          <p>We will notify you as soon as it is confirmed. Thank you for shopping with us!</p>
        `),
      }).catch(err => logger.error('[notification] dispatchOrderPlaced email failed', { err: err.message }));
    }
  } catch (err) {
    logger.error('[notification] dispatchOrderPlaced failed', { err: err.message });
  }
};

// 2. Order approved
const dispatchOrderApproved = async (order, branchId) => {
  try {
    const [settings, contact] = await Promise.all([
      settingsService.getSettings(branchId),
      getOrderContact(order),
    ]);
    if (!contact || !settings.notifyCustomerOnApproval) return;

    const shop  = settings.shopName || 'Vittorios Grains & Cereals';
    const loc   = settings.shopLocation || 'Kenya';
    const ref   = order.orderRef;
    const total = `KES ${Number(order.total || 0).toLocaleString()}`;

    if (settings.smsEnabled && contact.phone) {
      await sendSMS(contact.phone,
        `Hi ${contact.name}, your order ${ref} (${total}) has been CONFIRMED! We are preparing it now. – ${shop}`
      ).catch(err => logger.error('[notification] dispatchOrderApproved SMS failed', { err: err.message }));
    }

    if (settings.emailEnabled && contact.email) {
      await sendEmail({
        to: contact.email,
        subject: `Order Confirmed – ${ref}`,
        html: emailShell(shop, loc, `
          <p>Hi <strong>${escapeHtml(contact.name)}</strong>,</p>
          <p>Your order <span class="ref">${ref}</span> has been <span class="badge green">Confirmed</span>.</p>
          ${itemsTable(order.orderItems)}
          <p class="total-row">Total: ${total}</p>
          <p>We are now preparing your order and will notify you when it is on its way.</p>
        `),
      }).catch(err => logger.error('[notification] dispatchOrderApproved email failed', { err: err.message }));
    }
  } catch (err) {
    logger.error('[notification] dispatchOrderApproved failed', { err: err.message });
  }
};

// 3. Order rejected
const dispatchOrderRejected = async (order, branchId) => {
  try {
    const [settings, contact] = await Promise.all([
      settingsService.getSettings(branchId),
      getOrderContact(order),
    ]);
    if (!contact || !settings.notifyCustomerOnRejection) return;

    const shop   = settings.shopName || 'Vittorios Grains & Cereals';
    const loc    = settings.shopLocation || 'Kenya';
    const ref    = order.orderRef;
    const reason = order.rejectionReason || 'Please contact us for more information.';
    const phone  = settings.shopPhone || '';

    if (settings.smsEnabled && contact.phone) {
      await sendSMS(contact.phone,
        `Hi ${contact.name}, your order ${ref} was not approved. Reason: ${reason}. Contact us on ${phone} for assistance. – ${shop}`
      ).catch(err => logger.error('[notification] dispatchOrderRejected SMS failed', { err: err.message }));
    }

    if (settings.emailEnabled && contact.email) {
      await sendEmail({
        to: contact.email,
        subject: `Order Update – ${ref}`,
        html: emailShell(shop, loc, `
          <p>Hi <strong>${escapeHtml(contact.name)}</strong>,</p>
          <p>We regret to inform you that your order <span class="ref">${ref}</span> has been <span class="badge red">Declined</span>.</p>
          <p><strong>Reason:</strong> ${escapeHtml(reason)}</p>
          ${phone ? `<p>If you have questions, please contact us on <strong>${phone}</strong>.</p>` : ''}
        `),
      }).catch(err => logger.error('[notification] dispatchOrderRejected email failed', { err: err.message }));
    }
  } catch (err) {
    logger.error('[notification] dispatchOrderRejected failed', { err: err.message });
  }
};

// 4. Order out for delivery
const dispatchOrderDispatched = async (order, branchId) => {
  try {
    const [settings, contact] = await Promise.all([
      settingsService.getSettings(branchId),
      getOrderContact(order),
    ]);
    if (!contact || !settings.notifyCustomerOnDelivery) return;

    const shop = settings.shopName || 'Vittorios Grains & Cereals';
    const loc  = settings.shopLocation || 'Kenya';
    const ref  = order.orderRef;

    if (settings.smsEnabled && contact.phone) {
      await sendSMS(contact.phone,
        `Hi ${contact.name}, your order ${ref} is OUT FOR DELIVERY! Please be available to receive it. – ${shop}`
      ).catch(err => logger.error('[notification] dispatchOrderDispatched SMS failed', { err: err.message }));
    }

    if (settings.emailEnabled && contact.email) {
      await sendEmail({
        to: contact.email,
        subject: `Your Order is On Its Way – ${ref}`,
        html: emailShell(shop, loc, `
          <p>Hi <strong>${escapeHtml(contact.name)}</strong>,</p>
          <p>Your order <span class="ref">${ref}</span> is now <span class="badge blue">Out for Delivery</span>!</p>
          <p>Please be available to receive your order. Thank you for choosing ${shop}!</p>
        `),
      }).catch(err => logger.error('[notification] dispatchOrderDispatched email failed', { err: err.message }));
    }
  } catch (err) {
    logger.error('[notification] dispatchOrderDispatched failed', { err: err.message });
  }
};

// 5. Password reset OTP — security-critical, so it always goes out on every
// channel the user has (unlike order notifications, it isn't gated by the
// per-branch smsEnabled/emailEnabled toggles, and customers have no branchId
// to look those up by anyway).
const dispatchPasswordResetOtp = async (user, otp) => {
  try {
    const shop = 'Vittorios Grains & Cereals';

    if (user.phone) {
      await sendSMS(user.phone,
        `Your ${shop} password reset code is ${otp}. It expires in 10 minutes. If you didn't request this, ignore this message.`
      ).catch(err => logger.error('[notification] dispatchPasswordResetOtp SMS failed', { err: err.message }));
    }

    if (user.email) {
      await sendEmail({
        to: user.email,
        subject: `Password Reset Code – ${shop}`,
        html: emailShell(shop, 'Kenya', `
          <p>Hi <strong>${escapeHtml(user.name)}</strong>,</p>
          <p>Use the code below to reset your password. It expires in 10 minutes.</p>
          <p style="font-size:28px;font-weight:700;letter-spacing:4px;color:#1a5c38;margin:20px 0">${otp}</p>
          <p>If you didn't request this, you can safely ignore this email.</p>
        `),
      }).catch(err => logger.error('[notification] dispatchPasswordResetOtp email failed', { err: err.message }));
    }
  } catch (err) {
    logger.error('[notification] dispatchPasswordResetOtp failed', { err: err.message });
  }
};

module.exports = {
  dispatchOrderPlaced,
  dispatchOrderApproved,
  dispatchOrderRejected,
  dispatchOrderDispatched,
  dispatchPasswordResetOtp,
  sendEmail,
  sendSMS,
  sendBulkSMS,
};
