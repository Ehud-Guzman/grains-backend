const rateLimit = require('express-rate-limit');
const alertService = require('../services/alert.service');
const { RATE_LIMITS } = require('../utils/constants');

// Key by branchId + IP so branches don't throttle each other.
// branchId comes from the JWT (set by verifyToken as req.branchId) for
// authenticated routes, or from ?branchId query param for public routes.
const keyByBranchAndIp = (req) => {
  const branchId = req.branchId || req.query?.branchId || 'public';
  return `${branchId}:${req.ip}`;
};

// Public routes - 100 req/min per branch+IP
const publicLimiter = rateLimit({
  windowMs: RATE_LIMITS.WINDOW_MS,
  max: RATE_LIMITS.PUBLIC_MAX,
  keyGenerator: keyByBranchAndIp,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many requests, please try again in a minute'
  }
});

// Auth routes (login/register) - stricter, 10 req/min per branch+IP
const authLimiter = rateLimit({
  windowMs: RATE_LIMITS.WINDOW_MS,
  max: RATE_LIMITS.AUTH_MAX,
  keyGenerator: keyByBranchAndIp,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, _next, options) => {
    alertService.sendAlert(
      'AUTH_RATE_LIMIT',
      { IP: req.ip, Route: `${req.method} ${req.originalUrl}`, Attempts: `>${options.max} in 1 min`, 'User agent': req.headers['user-agent'] || 'unknown' },
      req.ip
    ).catch(() => {});
    res.status(options.statusCode).json({
      success: false,
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many login attempts, please try again in a minute'
    });
  }
});

// Authenticated admin routes - 300 req/min per branch+IP
const adminLimiter = rateLimit({
  windowMs: RATE_LIMITS.WINDOW_MS,
  max: RATE_LIMITS.ADMIN_MAX,
  keyGenerator: keyByBranchAndIp,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many requests, please slow down'
  }
});

// M-Pesa callback endpoint — tight limit; legitimate Safaricom retries are max 3/callback
// In production the IP whitelist is the primary guard; this is a second layer
const callbackLimiter = rateLimit({
  windowMs: RATE_LIMITS.WINDOW_MS,
  max: RATE_LIMITS.CALLBACK_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  // Always return 200 so Safaricom doesn't enter a retry loop on a rate-limit response
  handler: (req, res) => {
    console.warn(`[M-PESA] Callback rate limit hit from IP: ${req.ip}`);
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
});

// STK Push initiation — tighter than publicLimiter to prevent drain attacks
// (attacker triggering repeated STK pushes on a victim's phone number)
const stkLimiter = rateLimit({
  windowMs: RATE_LIMITS.WINDOW_MS,
  max: RATE_LIMITS.STK_MAX,
  keyGenerator: keyByBranchAndIp,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many payment requests, please try again in a minute'
  }
});

module.exports = { publicLimiter, authLimiter, adminLimiter, callbackLimiter, stkLimiter };
