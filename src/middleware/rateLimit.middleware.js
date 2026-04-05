const rateLimit = require('express-rate-limit');

// Public routes - 100 req/min per IP
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many requests, please try again in a minute'
  }
});

// Auth routes (login/register) - stricter, 10 req/min per IP
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many login attempts, please try again in a minute'
  }
});

// Authenticated admin routes - 300 req/min per IP
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
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
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  // Always return 200 so Safaricom doesn't enter a retry loop on a rate-limit response
  handler: (req, res) => {
    console.warn(`[M-PESA] Callback rate limit hit from IP: ${req.ip}`);
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
});

module.exports = { publicLimiter, authLimiter, adminLimiter, callbackLimiter };
