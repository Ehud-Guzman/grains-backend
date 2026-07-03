const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');
const cookieParser = require('cookie-parser');
const Sentry = require('@sentry/node');
require('dotenv').config();

const { errorHandler } = require('./middleware/errorHandler.middleware');
const { publicLimiter } = require('./middleware/rateLimit.middleware');
const { requestTiming } = require('./middleware/requestTiming.middleware');
const { isRestoreInProgress } = require('./services/backup.service');
const alertService = require('./services/alert.service');
const logger = require('./utils/logger');

// ── MODEL REGISTRATION ────────────────────────────────────────────────────────
require('./models/Branch');
require('./models/User');
require('./models/Guest');
require('./models/Product');
require('./models/Order');
require('./models/Payment');
require('./models/StockLog');
require('./models/StockIntake');
require('./models/ActivityLog');
require('./models/OrderCounter');
require('./models/Settings');
require('./models/TokenBlacklist');
require('./models/PriceLog');
require('./models/CustomerAlert');
require('./models/SavedList');
require('./models/Coupon');
require('./models/Promotion');
require('./models/GlobalSettings');

// ── PUBLIC ROUTES ─────────────────────────────────────────────────────────────
const authRoutes         = require('./routes/auth.routes');
const productRoutes      = require('./routes/product.routes');
const orderRoutes        = require('./routes/order.routes');
const settingsRoutes     = require('./routes/settings.routes');
const paymentRoutes      = require('./routes/payment.routes');
const driverRoutes       = require('./routes/driver.routes');
const customerAlertRoutes = require('./routes/customerAlert.routes');
const savedListRoutes    = require('./routes/savedList.routes');
const couponRoutes       = require('./routes/coupon.routes');
const promotionRoutes    = require('./routes/promotion.routes');
const branchRoutes       = require('./routes/branch.routes');

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
const adminDriverRoutes       = require('./routes/admin/driver.routes');
const adminStockIntakeRoutes  = require('./routes/admin/stockIntake.routes');
const adminCouponRoutes          = require('./routes/admin/coupon.routes');
const adminPromotionRoutes       = require('./routes/admin/promotion.routes');
const adminGlobalSettingsRoutes  = require('./routes/admin/globalSettings.routes');

const app = express();

// ── SENTRY ────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production' && process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    // Strip credentials and PII before events leave the server — tokens,
    // cookies, and request bodies (passwords, phone numbers) must never
    // reach Sentry
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies;
        delete event.request.data;
        if (event.request.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.Authorization;
          delete event.request.headers.cookie;
          delete event.request.headers.Cookie;
        }
      }
      if (event.user) {
        event.user = { id: event.user.id };
      }
      return event;
    }
  });
  app.use(Sentry.Handlers.requestHandler({
    request: ['method', 'url', 'query_string'],
    user: ['id']
  }));
}

// ── SECURITY HEADERS ──────────────────────────────────────────────────────────
app.use(helmet({
  hsts: {
    maxAge: 63072000,
    includeSubDomains: true,
    preload: true
  },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc:   ["'self'"],
      scriptSrc:  ["'self'"],
      imgSrc:     ["'self'", "data:", "res.cloudinary.com"],
      connectSrc: ["'self'"],
      fontSrc:    ["'self'"],
      objectSrc:  ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
      reportUri:  ['/api/csp-report']
    }
  },
  crossOriginEmbedderPolicy: false
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ── REQUEST ID + STRUCTURED ACCESS LOG ───────────────────────────────────────
// requestId is attached first so every downstream log (including errors) can
// reference it. The access log fires on response finish so it captures status.
app.use((req, res, next) => {
  req.requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  res.setHeader('X-Request-ID', req.requestId);

  if (process.env.NODE_ENV !== 'test') {
    res.on('finish', () => {
      logger.info('HTTP', {
        requestId: req.requestId,
        method:    req.method,
        url:       req.originalUrl,
        status:    res.statusCode,
        branchId:  req.branchId  || req.query?.branchId || null,
        userId:    req.user?.id  || null,
      });
    });
  }

  next();
});

app.use(requestTiming);

// ── COOKIE PARSING ────────────────────────────────────────────────────────────
app.use(cookieParser());

// ── BODY PARSING ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ── TRUST PROXY ───────────────────────────────────────────────────────────────
app.set('trust proxy', 1);

// ── HTTPS REDIRECT ────────────────────────────────────────────────────────────
// Render terminates TLS at the load balancer and forwards via HTTP internally.
// x-forwarded-proto carries the original scheme — redirect plain HTTP callers.
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

// ── NOSQL INJECTION PROTECTION ────────────────────────────────────────────────
app.use(mongoSanitize({
  replaceWith: '_',
  onSanitize: ({ req, key }) => {
    logger.warn('[SECURITY] Sanitized NoSQL injection attempt', { key, ip: req.ip });
    alertService.sendAlert(
      'NOSQL_INJECTION',
      { IP: req.ip, Key: key, Route: `${req.method} ${req.originalUrl}`, 'User ID': req.user?.id || 'unauthenticated' },
      req.ip
    ).catch(() => {});
  }
}));

// ── HTTP PARAMETER POLLUTION PROTECTION ──────────────────────────────────────
app.use(hpp({
  whitelist: ['category', 'status', 'packagingSize', 'period', 'type', 'from', 'to']
}));

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  const dbState = mongoose.connection.readyState; // 1 = connected
  if (dbState !== 1) {
    return res.status(503).json({
      success: false,
      message: 'Database unavailable',
      timestamp: new Date().toISOString()
    });
  }
  res.json({
    success: true,
    message: 'Grains & Cereals API is running',
    timestamp: new Date().toISOString()
  });
});

// ── CSP VIOLATION REPORTS ─────────────────────────────────────────────────────
app.post('/api/csp-report', express.json({ type: 'application/csp-report', limit: '4kb' }), (req, res) => {
  if (req.body?.['csp-report']) {
    logger.warn('CSP_VIOLATION', { report: req.body['csp-report'] });
  }
  res.status(204).end();
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
app.use('/api/driver',   driverRoutes);
app.use('/api/alerts',     customerAlertRoutes);
app.use('/api/lists',      savedListRoutes);
app.use('/api/coupons',    couponRoutes);
app.use('/api/promotions', promotionRoutes);
app.use('/api/branches',   branchRoutes);

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
app.use('/api/admin/drivers',       adminDriverRoutes);
app.use('/api/admin/stock-intake',  adminStockIntakeRoutes);
app.use('/api/admin/coupons',          adminCouponRoutes);
app.use('/api/admin/promotions',       adminPromotionRoutes);
app.use('/api/admin/global-settings',  adminGlobalSettingsRoutes);

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
