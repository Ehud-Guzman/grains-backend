// ── KEEP-ALIVE PINGER ─────────────────────────────────────────────────────────
// Render free tier spins down instances after 15 minutes of no incoming traffic.
// This job pings the server's own /api/health endpoint every 10 minutes to keep
// it awake — well within the 15-minute window.
//
// Only runs in production. In development there is no spin-down risk.
//
// Render automatically injects RENDER_EXTERNAL_URL (e.g.
// https://grains-backend-b3n0.onrender.com) — no manual URL config needed.
// If you self-host elsewhere, set SELF_URL in your environment instead.

const https = require('https');
const http  = require('http');

const PING_INTERVAL_MS = 10 * 60 * 1000;  // 10 minutes
const INITIAL_DELAY_MS =  2 * 60 * 1000;  // wait 2 min after startup before first ping

const ping = () => {
  const base = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
  if (!base) {
    // Nothing to ping — environment not configured
    return;
  }

  const url = `${base.replace(/\/$/, '')}/api/health`;
  const lib = url.startsWith('https') ? https : http;

  const req = lib.get(url, { timeout: 10000 }, (res) => {
    if (res.statusCode === 200) {
      console.log(`[KEEP-ALIVE] Pinged ${url} — ${res.statusCode} OK`);
    } else {
      console.warn(`[KEEP-ALIVE] Ping returned unexpected status ${res.statusCode}`);
    }
    // Drain response body so the socket closes cleanly
    res.resume();
  });

  req.on('error', (err) => {
    console.warn(`[KEEP-ALIVE] Ping failed: ${err.message}`);
  });

  req.on('timeout', () => {
    console.warn('[KEEP-ALIVE] Ping timed out after 10s');
    req.destroy();
  });
};

// ── SCHEDULER ─────────────────────────────────────────────────────────────────
const startKeepAlive = () => {
  // Skip entirely outside production
  if (process.env.NODE_ENV !== 'production') return;

  const base = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
  if (!base) {
    console.warn('[KEEP-ALIVE] RENDER_EXTERNAL_URL not set — keep-alive pinger disabled.');
    return;
  }

  setTimeout(() => {
    ping();
    setInterval(ping, PING_INTERVAL_MS);
  }, INITIAL_DELAY_MS);

  console.log(`[KEEP-ALIVE] Pinger scheduled every 10 min → ${base}/api/health`);
};

module.exports = { startKeepAlive };
