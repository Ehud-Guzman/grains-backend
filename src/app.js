const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const hpp = require('hpp');
const Sentry = require('@sentry/node');
require('dotenv').config();

const { errorHandler } = require('./middleware/errorHandler.middleware');
const { publicLimiter } = require('./middleware/rateLimit.middleware');
const { requestTiming } = require('./middleware/requestTiming.middleware');
const { isRestoreInProgress } = require('./services/backup.service');

// ── MODEL REGISTRATION ────────────────────────────────────────────────────────
require('./models/Branch');
require('./models/User');
require('./models/Guest');
require('./models/Product');
require('./models/Order');
require('./models/Payment');
require('./models/StockLog');
require('./models/ActivityLog');
require('./models/OrderCounter');
require('./models/Settings');
require('./models/TokenBlacklist');

// ── PUBLIC ROUTES ─────────────────────────────────────────────────────────────
const authRoutes     = require('./routes/auth.routes');
const productRoutes  = require('./routes/product.routes');
const orderRoutes    = require('./routes/order.routes');
const settingsRoutes = require('./routes/settings.routes');
const paymentRoutes  = require('./routes/payment.routes');

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────
const adminProductRoutes  = require('./routes/admin/product.routes');
const adminOrderRoutes    = require('./routes/admin/order.routes');
const adminStockRoutes    = require('./routes/admin/stock.routes');
const adminCustomerRoutes = require('./routes/admin/customer.routes');
const adminReportRoutes   = require('./routes/admin/report.routes');
const adminUserRoutes     = require('./routes/admin/user.routes');
const adminLogRoutes      = require('./routes/admin/log.routes');
const adminSettingsRoutes = require('./routes/admin/settings.routes');
const adminPaymentRoutes  = require('./routes/admin/payment.routes');
const adminBranchRoutes   = require('./routes/admin/branch.routes');
const adminBackupRoutes   = require('./routes/admin/backup.routes');

const app = express();

// ── SENTRY ────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production' && process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN });
  app.use(Sentry.Handlers.requestHandler());
}

// ── SECURITY HEADERS ──────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      scriptSrc:  ["'self'"],
      imgSrc:     ["'self'", "data:", "res.cloudinary.com"],
      connectSrc: ["'self'"],
      fontSrc:    ["'self'"],
      objectSrc:  ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ── REQUEST LOGGING ───────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

app.use(requestTiming);

// ── BODY PARSING ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ── TRUST PROXY ───────────────────────────────────────────────────────────────
app.set('trust proxy', 1);

// ── NOSQL INJECTION PROTECTION ────────────────────────────────────────────────
app.use(mongoSanitize({
  replaceWith: '_',
  onSanitize: ({ req, key }) => {
    console.warn(`[SECURITY] Sanitized NoSQL injection attempt on key: ${key} from IP: ${req.ip}`);
  }
}));

// ── XSS PROTECTION ────────────────────────────────────────────────────────────
app.use(xss());

// ── HTTP PARAMETER POLLUTION PROTECTION ──────────────────────────────────────
app.use(hpp({
  whitelist: ['category', 'status', 'packagingSize']
}));

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'Grains & Cereals API is running',
    env: process.env.NODE_ENV,
    timestamp: new Date().toISOString()
  });
});

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
app.use('/api', publicLimiter);

// ── RESTORE LOCK ──────────────────────────────────────────────────────────────
// Block all API traffic while a backup restore is running. Checked before any
// DB query because the database is empty between Phase 1 (delete) and Phase 2
// (insert). The backup route itself is exempt so the admin can trigger recovery.
app.use('/api', (req, res, next) => {
  if (isRestoreInProgress() && !req.path.startsWith('/admin/backups')) {
    return res.status(503).json({
      success: false,
      error: 'RESTORE_IN_PROGRESS',
      message: 'A system restore is in progress. Please try again in a moment.',
    });
  }
  next();
});

// ── PUBLIC ROUTES ─────────────────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders',   orderRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/payments', paymentRoutes);

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────
app.use('/api/admin/products',  adminProductRoutes);
app.use('/api/admin/orders',    adminOrderRoutes);
app.use('/api/admin/stock',     adminStockRoutes);
app.use('/api/admin/customers', adminCustomerRoutes);
app.use('/api/admin/reports',   adminReportRoutes);
app.use('/api/admin/users',     adminUserRoutes);
app.use('/api/admin/logs',      adminLogRoutes);
app.use('/api/admin/settings',  adminSettingsRoutes);
app.use('/api/admin/payments',  adminPaymentRoutes);
app.use('/api/admin/branches',  adminBranchRoutes);
app.use('/api/admin/backups',   adminBackupRoutes);

// ── 404 HANDLER ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'NOT_FOUND',
    message: `Route ${req.method} ${req.originalUrl} not found`
  });
});

// ── SENTRY ERROR HANDLER ──────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production' && process.env.SENTRY_DSN) {
  app.use(Sentry.Handlers.errorHandler());
}

// ── GLOBAL ERROR HANDLER ──────────────────────────────────────────────────────
app.use(errorHandler);

module.exports = app;
