
require('dotenv').config();
const app = require('./src/app');
const connectDB = require('./src/config/db');
const logger = require('./src/utils/logger');
const { startCleanupJobs }   = require('./src/jobs/cleanup.job');
const { startKeepAlive }     = require('./src/jobs/keepAlive.job');
const { startAutoCancelJob } = require('./src/jobs/autoCancel.job');
const { startAdminAlertsJob } = require('./src/jobs/adminAlerts.job');
const { startEtimsRetryJob } = require('./src/jobs/etimsRetry.job');
const { register: registerOrderListeners } = require('./src/events/listeners/order.listener');
const { register: registerStockListeners } = require('./src/events/listeners/stock.listener');
const { register: registerPriceListeners } = require('./src/events/listeners/price.listener');

const PORT = process.env.PORT || 5000;

// ── VALIDATE REQUIRED ENV VARIABLES BEFORE STARTING ──────────────────────────
// Fail fast — better to crash on startup than fail silently in production
const REQUIRED_ENV = [
  'MONGODB_URI',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'JWT_ACCESS_EXPIRY',
  'JWT_REFRESH_EXPIRY',
  'FRONTEND_URL'
];

const missingEnv = REQUIRED_ENV.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
  console.error('[STARTUP ERROR] Missing required environment variables:');
  missingEnv.forEach(key => console.error(`  - ${key}`));
  console.error('Server will not start. Add these to your .env file.');
  process.exit(1);
}

// ── VALIDATE JWT SECRET STRENGTH ─────────────────────────────────────────────
if (process.env.JWT_ACCESS_SECRET.length < 64) {
  console.error('[STARTUP ERROR] JWT_ACCESS_SECRET is too short. Minimum 64 characters required.');
  process.exit(1);
}

if (process.env.JWT_REFRESH_SECRET.length < 64) {
  console.error('[STARTUP ERROR] JWT_REFRESH_SECRET is too short. Minimum 64 characters required.');
  process.exit(1);
}

if (process.env.JWT_ACCESS_SECRET === process.env.JWT_REFRESH_SECRET) {
  console.error('[STARTUP ERROR] JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different.');
  process.exit(1);
}

// ── PRODUCTION SAFETY WARNINGS ────────────────────────────────────────────────
// These do not crash the server — they warn loudly so you notice in the logs.
if (process.env.NODE_ENV === 'production') {
  if (process.env.MPESA_ENV !== 'production') {
    console.error('[STARTUP ERROR] MPESA_ENV must be "production" in a production environment. Refusing to start to prevent callback IP validation bypass.');
    process.exit(1);
  }

  if (process.env.AT_USERNAME === 'sandbox' || !process.env.AT_USERNAME) {
    console.warn('[STARTUP WARNING] AT_USERNAME is "sandbox" — SMS messages will NOT be delivered to real phones.');
  }

  const frontendUrl = process.env.FRONTEND_URL || '';
  if (!frontendUrl.startsWith('https://')) {
    console.error(`[STARTUP ERROR] FRONTEND_URL must start with "https://" in production. Current value: "${frontendUrl || '(empty)'}"`);
    process.exit(1);
  }

  if (!process.env.SENTRY_DSN) {
    console.warn('[STARTUP WARNING] SENTRY_DSN is not set — unhandled errors in production will not be tracked.');
  }

  // Warn if backup storage is pointing at a relative or default path.
  // Render and most PaaS platforms use ephemeral disks — backups written there
  // are lost on every deploy/restart. Set BACKUP_STORAGE_DIR to a mounted
  // persistent volume path (e.g. Render Disk at /var/data/backups).
  const backupDir = process.env.BACKUP_STORAGE_DIR || '';
  if (!backupDir || !require('path').isAbsolute(backupDir)) {
    console.warn(
      '[STARTUP WARNING] BACKUP_STORAGE_DIR is not set to an absolute path. ' +
      'Backups will be written to the default runtime-data/backups directory which ' +
      'is ephemeral on Render and similar platforms. Set BACKUP_STORAGE_DIR to a ' +
      'persistent mounted volume (e.g. /var/data/backups) to avoid data loss.'
    );
  }
}

// ── UNCAUGHT EXCEPTION HANDLER ────────────────────────────────────────────────
// Synchronous errors that were never caught anywhere
// PM2 will automatically restart the process after exit
process.on('uncaughtException', (err) => {
  logger.error('[UNCAUGHT EXCEPTION] Shutting down...', { err });
  process.exit(1);
});

// ── UNHANDLED PROMISE REJECTION HANDLER ───────────────────────────────────────
// Async errors that were never caught with try/catch or .catch()
process.on('unhandledRejection', (reason, promise) => {
  logger.error('[UNHANDLED REJECTION] Shutting down...', { promise, reason });
  process.exit(1);
});

// ── START SERVER ──────────────────────────────────────────────────────────────
const startServer = async () => {
  try {
    // Connect to MongoDB first — fail fast if DB is unreachable
    await connectDB();

    // Register event listeners (before jobs, no DB dependency)
    registerOrderListeners();
    registerStockListeners();
    registerPriceListeners();

    // Start background jobs (DB must be connected before jobs run)
    startCleanupJobs();
    startAutoCancelJob();
    startKeepAlive();
    startAdminAlertsJob();
    startEtimsRetryJob();

    const server = app.listen(PORT, () => {
      logger.info(`
====================================
  Grains & Cereals API
  Port:        ${PORT}
  Environment: ${process.env.NODE_ENV || 'development'}
  Database:    Connected
  Started:     ${new Date().toISOString()}
====================================
      `);
    });

    // ── GRACEFUL SHUTDOWN ─────────────────────────────────────────────────────
    // PM2 sends SIGTERM on restart — finish in-flight requests before closing
    process.on('SIGTERM', () => {
      logger.info('[SIGTERM] Graceful shutdown initiated...');
      server.close(async () => {
        logger.info('[SIGTERM] HTTP server closed. All connections drained.');
        // Give in-flight DB operations 5 seconds to complete
        setTimeout(() => {
          logger.info('[SIGTERM] Shutdown complete.');
          process.exit(0);
        }, 5000);
      });
    });

    // SIGINT handles Ctrl+C in development
    process.on('SIGINT', () => {
      logger.info('[SIGINT] Shutting down (Ctrl+C)...');
      server.close(() => {
        logger.info('[SIGINT] Server closed.');
        process.exit(0);
      });
    });

  } catch (err) {
    logger.error('[STARTUP ERROR] Failed to start server', { err });
    process.exit(1);
  }
};

startServer();
