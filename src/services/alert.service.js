const nodemailer = require('nodemailer');
const AfricasTalking = require('africastalking');

// ── PROVIDER SETUP ────────────────────────────────────────────────────────────
// Standalone transporter — does NOT depend on settingsService so alerts work
// even if the DB is unavailable or settings are misconfigured.

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

// ── IN-MEMORY THROTTLE ────────────────────────────────────────────────────────
// Key: `TYPE:throttleKey` → { lastSentAt, count, windowStart }
const throttleState = new Map();

// ms between alerts per type+key (0 = no throttle, always fire)
const THROTTLE_MS = {
  NOSQL_INJECTION:    10 * 60 * 1000,   // 10 min per IP
  AUTH_RATE_LIMIT:     5 * 60 * 1000,   //  5 min per IP
  BRUTE_FORCE_LOGIN:   5 * 60 * 1000,   //  5 min per IP/account
  ACCOUNT_LOCKED:      0,               // always send
  ROLE_VIOLATION:     15 * 60 * 1000,   // 15 min per userId+route
  SERVER_ERROR:        5 * 60 * 1000,   //  5 min global counter window
  BACKUP_RESTORED:     0,               // always send
};

// SERVER_ERROR is counter-based: send the alert only after this many errors
// in the window (avoids noisy alerts on a single transient error)
const SERVER_ERROR_THRESHOLD = 3;

// ── ALERT CONFIG ──────────────────────────────────────────────────────────────
const ALERT_CONFIG = {
  NOSQL_INJECTION: {
    severity: 'high',
    title: 'NoSQL Injection Attempt Detected',
    sms: (d) => `[SECURITY] NoSQL injection attempt from IP ${d.IP} on ${d.Route}. Check server logs.`,
  },
  AUTH_RATE_LIMIT: {
    severity: 'high',
    title: 'Auth Rate Limit Triggered — Possible Brute Force',
    sms: (d) => `[SECURITY] Login rate limit hit from IP ${d.IP}. ${d.Attempts} requests in 1 min.`,
  },
  BRUTE_FORCE_LOGIN: {
    severity: 'high',
    title: 'Multiple Failed Login Attempts',
    sms: (d) => `[SECURITY] ${d['Failed attempts']} failed logins for ${d.Phone} from IP ${d.IP}.`,
  },
  ACCOUNT_LOCKED: {
    severity: 'medium',
    title: 'Account Automatically Locked',
    sms: (d) => `[ALERT] Account ${d.Phone} (${d.Role}) locked after too many failed logins.`,
  },
  ROLE_VIOLATION: {
    severity: 'medium',
    title: 'Unauthorized Route Access Attempt',
    sms: (d) => `[ALERT] User ${d['User ID']} (${d.Role}) tried to access ${d.Route} — denied.`,
  },
  SERVER_ERROR: {
    severity: 'medium',
    title: 'Repeated Server Errors Detected',
    sms: (d) => `[ALERT] ${d['Error count']} server errors in 5 min. Latest: ${d.Message}`,
  },
  BACKUP_RESTORED: {
    severity: 'high',
    title: 'System Backup Restore Executed',
    sms: (d) => `[SECURITY] DB backup restored by ${d['Actor role']} (${d['Actor ID']}). Database was fully reloaded.`,
  },
};

// ── SEVERITY BADGE COLOURS ────────────────────────────────────────────────────
const SEVERITY_STYLE = {
  high:   { badge: '#dc2626', bg: '#fef2f2', border: '#fca5a5' },
  medium: { badge: '#d97706', bg: '#fffbeb', border: '#fcd34d' },
  low:    { badge: '#2563eb', bg: '#eff6ff', border: '#93c5fd' },
};

// ── THROTTLE CHECK ────────────────────────────────────────────────────────────
const shouldAlert = (type, key) => {
  const window = THROTTLE_MS[type];
  const mapKey = `${type}:${key}`;
  const now = Date.now();
  const state = throttleState.get(mapKey);

  if (type === 'SERVER_ERROR') {
    // Counter-based: accumulate errors in window, fire when threshold reached
    if (!state || now - state.windowStart > window) {
      throttleState.set(mapKey, { count: 1, windowStart: now, lastSentAt: null });
      return false;
    }
    state.count++;
    if (state.count >= SERVER_ERROR_THRESHOLD &&
        (!state.lastSentAt || now - state.lastSentAt > window)) {
      state.lastSentAt = now;
      state.count = 0;
      state.windowStart = now;
      return true;
    }
    return false;
  }

  if (window === 0) return true; // always send
  if (!state || now - state.lastSentAt > window) {
    throttleState.set(mapKey, { lastSentAt: now });
    return true;
  }
  return false;
};

// ── EMAIL BUILDER ─────────────────────────────────────────────────────────────
const buildEmail = (type, data) => {
  const cfg   = ALERT_CONFIG[type];
  const style = SEVERITY_STYLE[cfg.severity];
  const ts    = new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });

  const rows = Object.entries(data)
    .map(([k, v]) =>
      `<tr>
         <td style="padding:5px 12px;font-weight:600;color:#555;white-space:nowrap;vertical-align:top">${k}</td>
         <td style="padding:5px 12px;color:#222;word-break:break-all">${String(v)}</td>
       </tr>`
    )
    .join('');

  return `<!DOCTYPE html><html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:0">
<div style="max-width:580px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">
  <div style="background:#1a5c38;color:#fff;padding:18px 28px">
    <p style="margin:0;font-size:11px;opacity:.75;letter-spacing:.05em;text-transform:uppercase">Vittorios Grains &amp; Cereals</p>
    <h1 style="margin:4px 0 0;font-size:17px;font-weight:700">Security Alert</h1>
  </div>
  <div style="padding:24px 28px">
    <div style="background:${style.bg};border:1px solid ${style.border};border-radius:6px;padding:14px 18px;margin-bottom:20px">
      <span style="background:${style.badge};color:#fff;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em">${cfg.severity}</span>
      <h2 style="margin:8px 0 0;font-size:15px;color:#111">${cfg.title}</h2>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fafafa;border:1px solid #eee;border-radius:4px">
      ${rows}
    </table>
    <p style="margin-top:18px;font-size:12px;color:#999">Detected at: <strong>${ts}</strong> (Nairobi time)</p>
  </div>
  <div style="background:#f0f0f0;padding:12px 28px;font-size:11px;color:#aaa">
    Automated security alert &mdash; do not reply. Review your Activity Logs for full details.
  </div>
</div>
</body></html>`;
};

// ── PHONE NORMALISER ──────────────────────────────────────────────────────────
const normalisePhone = (phone) => {
  if (!phone) return '';
  const cleaned = phone.replace(/[\s\-()]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('0'))   return '+254' + cleaned.slice(1);
  if (cleaned.startsWith('254')) return '+' + cleaned;
  return cleaned;
};

// ── PUBLIC API ────────────────────────────────────────────────────────────────
/**
 * Fire a security alert to the system admin.
 *
 * @param {string} type         - One of ALERT_CONFIG's keys (e.g. 'NOSQL_INJECTION')
 * @param {object} data         - Key-value pairs displayed in the email table
 * @param {string} throttleKey  - Unique key for throttle de-dup (e.g. the offending IP)
 *
 * Always fire-and-forget: call without await so it never blocks the main flow.
 * Errors are caught internally — they will never propagate to the caller.
 */
const sendAlert = async (type, data, throttleKey = 'global') => {
  // Silenced in test environment
  if (process.env.NODE_ENV === 'test') return;

  if (!ALERT_CONFIG[type]) {
    console.warn(`[alert] Unknown alert type: ${type}`);
    return;
  }

  if (!shouldAlert(type, throttleKey)) return;

  const adminEmail = process.env.ADMIN_ALERT_EMAIL;
  const adminPhone = process.env.ADMIN_ALERT_PHONE;

  if (!adminEmail && !adminPhone) {
    // Only warn once — avoid log spam on every alert call
    if (!sendAlert._warnedNoConfig) {
      console.warn('[alert] ADMIN_ALERT_EMAIL and ADMIN_ALERT_PHONE not set — security alerts disabled.');
      sendAlert._warnedNoConfig = true;
    }
    return;
  }

  const cfg = ALERT_CONFIG[type];

  // ── Email ─────────────────────────────────────────────────────────────────
  if (adminEmail && emailTransporter) {
    try {
      await emailTransporter.sendMail({
        from: `"Vittorios Grains Security" <${process.env.EMAIL_FROM || process.env.GMAIL_USER}>`,
        to: adminEmail,
        subject: `[${cfg.severity.toUpperCase()} ALERT] ${cfg.title}`,
        html: buildEmail(type, data),
      });
    } catch (err) {
      console.error('[alert] Email failed:', err.message);
    }
  }

  // ── SMS (optional — only if ADMIN_ALERT_PHONE is set) ────────────────────
  if (adminPhone && atSMS) {
    try {
      const phone   = normalisePhone(adminPhone);
      const message = cfg.sms(data);
      await atSMS.send({ to: [phone], message });
    } catch (err) {
      console.error('[alert] SMS failed:', err.message);
    }
  }

  console.warn(`[alert] ${type}`, data);
};

module.exports = { sendAlert };
