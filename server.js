require('dotenv').config();
const app = require('./src/app');
const connectDB = require('./src/config/db');

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
if (process.env.JWT_ACCESS_SECRET.length < 32) {
  console.error('[STARTUP ERROR] JWT_ACCESS_SECRET is too short. Minimum 32 characters required.');
  process.exit(1);
}

if (process.env.JWT_REFRESH_SECRET.length < 32) {
  console.error('[STARTUP ERROR] JWT_REFRESH_SECRET is too short. Minimum 32 characters required.');
  process.exit(1);
}

if (process.env.JWT_ACCESS_SECRET === process.env.JWT_REFRESH_SECRET) {
  console.error('[STARTUP ERROR] JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different.');
  process.exit(1);
}

// ── UNCAUGHT EXCEPTION HANDLER ────────────────────────────────────────────────
// Synchronous errors that were never caught anywhere
// PM2 will automatically restart the process after exit
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION] Shutting down...');
  console.error(`Error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

// ── UNHANDLED PROMISE REJECTION HANDLER ───────────────────────────────────────
// Async errors that were never caught with try/catch or .catch()
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION] Shutting down...');
  console.error('Promise:', promise);
  console.error('Reason:', reason);
  process.exit(1);
});

// ── START SERVER ──────────────────────────────────────────────────────────────
const startServer = async () => {
  try {
    // Connect to MongoDB first — fail fast if DB is unreachable
    await connectDB();

    const server = app.listen(PORT, () => {
      console.log(`
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
      console.log('[SIGTERM] Graceful shutdown initiated...');
      server.close(async () => {
        console.log('[SIGTERM] HTTP server closed. All connections drained.');
        // Give in-flight DB operations 5 seconds to complete
        setTimeout(() => {
          console.log('[SIGTERM] Shutdown complete.');
          process.exit(0);
        }, 5000);
      });
    });

    // SIGINT handles Ctrl+C in development
    process.on('SIGINT', () => {
      console.log('\n[SIGINT] Shutting down (Ctrl+C)...');
      server.close(() => {
        console.log('[SIGINT] Server closed.');
        process.exit(0);
      });
    });

  } catch (err) {
    console.error('[STARTUP ERROR] Failed to start server:', err.message);
    process.exit(1);
  }
};

startServer();