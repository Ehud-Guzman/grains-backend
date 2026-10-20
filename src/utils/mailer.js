const nodemailer = require('nodemailer');
const logger = require('./logger');
const { EAT_OFFSET_MS } = require('./businessTime');

// The one place email is sent from (notification.service and alert.service each used to build their own
// transport - 2026-10 audit, F-24). It adds what the bare transport lacked:
//   * a connection pool and short timeouts, so a stalled Gmail connection cannot hold a request or a job
//     for the default two minutes;
//   * a daily budget. A personal Gmail account allows roughly 500 recipients a day. Once the day's count
//     passes the soft limit, ordinary notifications (order updates) are dropped and what is left is kept for
//     CRITICAL mail - sign-in and password-reset codes and security alerts - which would otherwise fail
//     silently at the worst moment (SMS is on a sandbox, so email is often the only way a code arrives).
//     Moving to a transactional provider on the shop's own domain removes the limit; this keeps the shop
//     working until then. Tune with EMAIL_DAILY_LIMIT (default 480) and EMAIL_CRITICAL_RESERVE (default 80).
const DAILY_LIMIT = () => Number(process.env.EMAIL_DAILY_LIMIT) || 480;
const CRITICAL_RESERVE = () => {
  const v = Number(process.env.EMAIL_CRITICAL_RESERVE);
  return Number.isFinite(v) && v >= 0 && process.env.EMAIL_CRITICAL_RESERVE ? v : 80;
};

let transporter; // undefined = not built yet, null = not configured
const getTransporter = () => {
  if (transporter !== undefined) return transporter;
  if (!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)) {
    transporter = null;
    return null;
  }
  transporter = nodemailer.createTransport({
    service: 'gmail',
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    connectionTimeout: 10 * 1000,
    greetingTimeout: 10 * 1000,
    socketTimeout: 20 * 1000,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  return transporter;
};

const isConfigured = () => getTransporter() !== null;

// ── daily budget ──────────────────────────────────────────────────────────────
let budgetDay = null;
let sentToday = 0;
let warnedDay = null;
const todayEAT = () => new Date(Date.now() + EAT_OFFSET_MS).toISOString().slice(0, 10);
const roll = () => {
  const day = todayEAT();
  if (day !== budgetDay) { budgetDay = day; sentToday = 0; }
  return day;
};
const recipientCount = (to) => (Array.isArray(to) ? to.length : String(to || '').split(',').filter(Boolean).length) || 1;

/**
 * Send one email. Resolves { sent: true } or { sent: false, reason } - it throws only if the transport
 * itself fails, so callers keep their existing .catch handling.
 * `critical: true` marks mail that must get through (codes, security alerts).
 */
const sendMail = async (message, { critical = false } = {}) => {
  const t = getTransporter();
  if (!t) return { sent: false, reason: 'not_configured' };
  if (!message?.to) return { sent: false, reason: 'no_recipient' };

  const day = roll();
  const n = recipientCount(message.to);
  const limit = DAILY_LIMIT();
  const ceiling = critical ? limit : limit - CRITICAL_RESERVE();
  if (sentToday + n > ceiling) {
    if (warnedDay !== `${day}:${critical}`) {
      warnedDay = `${day}:${critical}`;
      logger.error(critical
        ? '[mailer] Daily email limit reached - even critical mail is being refused'
        : '[mailer] Daily email budget used up - order notification emails are paused for today (codes and security alerts still go out)',
      { sentToday, limit });
    }
    return { sent: false, reason: 'daily_limit' };
  }
  sentToday += n;
  try {
    await t.sendMail(message);
    return { sent: true };
  } catch (err) {
    sentToday -= n; // it did not go out - do not spend the budget on it
    throw err;
  }
};

module.exports = {
  sendMail,
  isConfigured,
  stats: () => { roll(); return { sentToday, limit: DAILY_LIMIT(), criticalReserve: CRITICAL_RESERVE() }; },
  // test seams
  _setTransporter: (t) => { transporter = t; },
  _resetBudget: () => { budgetDay = null; sentToday = 0; warnedDay = null; },
};
