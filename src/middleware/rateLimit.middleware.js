const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
const alertService = require('../services/alert.service');
const { RATE_LIMITS } = require('../utils/constants');

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

// Key by branchId + IP so branches don't throttle each other.
// branchId comes from the JWT (set by verifyToken as req.branchId) for
// authenticated routes, or from ?branchId query param for public routes — the
// query param is validated as a plausible Mongo ObjectId first, since it's
// client-controlled on unauthenticated routes: without this check, an attacker
// could vary ?branchId= on every request to mint a fresh rate-limit bucket each
// time, completely defeating the per-branch+IP cap.
const keyByBranchAndIp = (req) => {
  const queryBranchId = typeof req.query?.branchId === 'string' && OBJECT_ID_RE.test(req.query.branchId)
    ? req.query.branchId
    : null;
  const branchId = req.branchId || queryBranchId || 'public';
  return `${branchId}:${req.ip}`;
};

// This limiter runs on every /api request, before verifyToken, so it cannot read req.user.
// It used to give the whole IP one 100/min bucket, which meant a shop's staff, its driver and
// a few customers on the same wifi (or mobile NAT) locked each other out and made the 300/min
// adminLimiter unreachable. A request carrying a VERIFIED access token is now counted per user;
// an unsigned or forged token falls back to the per-IP bucket, so it cannot mint fresh buckets.
const verifiedUserId = (req) => {
  if (req._rateLimitUserId !== undefined) return req._rateLimitUserId;
  let id = null;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ') && process.env.JWT_ACCESS_SECRET) {
    try { id = jwt.verify(header.slice(7), process.env.JWT_ACCESS_SECRET).id || null; } catch { id = null; }
  }
  req._rateLimitUserId = id;
  return id;
};

const tooManyRequests = {
  success: false,
  error: 'RATE_LIMIT_EXCEEDED',
  message: 'Too many requests, please try again in a minute'
};

// Anonymous traffic - per branch+IP
const anonymousLimiter = rateLimit({
  windowMs: RATE_LIMITS.WINDOW_MS,
  max: RATE_LIMITS.PUBLIC_MAX,
  keyGenerator: keyByBranchAndIp,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooManyRequests
});

// Signed-in traffic - per user
const signedInLimiter = rateLimit({
  windowMs: RATE_LIMITS.WINDOW_MS,
  max: RATE_LIMITS.USER_MAX,
  keyGenerator: (req) => `user:${verifiedUserId(req)}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooManyRequests
});

const publicLimiter = (req, res, next) =>
  (verifiedUserId(req) ? signedInLimiter : anonymousLimiter)(req, res, next);

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

// Session refresh - separate from login so page reloads never lock people out of their session
const refreshLimiter = rateLimit({
  windowMs: RATE_LIMITS.WINDOW_MS,
  max: RATE_LIMITS.REFRESH_MAX,
  keyGenerator: keyByBranchAndIp,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many requests, please try again in a minute'
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
    logger.warn('[M-PESA] Callback rate limit hit', { requestId: req.requestId, ip: req.ip });
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

// Guest order placement — tighter than publicLimiter. Every guest order reserves
// real stock immediately (see order.service.js#reserveOrderStock), so an
// unauthenticated bot varying items/phone across requests can lock up inventory
// for autoCancelHours; the exact-duplicate guard alone only blocks resubmissions
// of the identical cart.
const guestOrderLimiter = rateLimit({
  windowMs: RATE_LIMITS.WINDOW_MS,
  max: RATE_LIMITS.GUEST_ORDER_MAX,
  keyGenerator: keyByBranchAndIp,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many orders placed, please try again in a minute'
  }
});

// Guest order tracking (phone + order ref lookup) — unauthenticated and a prime
// enumeration target (sequential, guessable order refs), so it gets its own
// tighter cap keyed by IP alone rather than the shared, branch-keyed publicLimiter.
const trackLimiter = rateLimit({
  windowMs: RATE_LIMITS.WINDOW_MS,
  max: RATE_LIMITS.TRACK_MAX,
  keyGenerator: (req) => req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many tracking requests, please try again in a minute'
  }
});

module.exports = { publicLimiter, authLimiter, refreshLimiter, adminLimiter, callbackLimiter, stkLimiter, trackLimiter, guestOrderLimiter };
