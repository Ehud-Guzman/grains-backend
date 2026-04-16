const Sentry = require('@sentry/node');
const logger = require('../utils/logger');
const alertService = require('../services/alert.service');

const errorHandler = (err, req, res, next) => {
  const requestId = req.requestId || 'unknown';
  const branchId  = req.branchId || req.user?.branchId || null;
  const userId    = req.user?.id || null;

  // Always log full stack server-side — never exposed to client
  logger.error(err.message, { requestId, branchId, userId, err });

  // Also send to Sentry in production
  if (process.env.NODE_ENV === 'production' && process.env.SENTRY_DSN) {
    Sentry.withScope(scope => {
      scope.setTag('requestId', requestId);
      scope.setTag('branchId', branchId);
      Sentry.captureException(err);
    });
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map(e => e.message);
    return res.status(400).json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: messages.join(', ')
    });
  }

  // Mongoose duplicate key error — generic message prevents field-level enumeration
  if (err.code === 11000) {
    return res.status(409).json({
      success: false,
      error: 'DUPLICATE_ERROR',
      message: 'This value is already in use'
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      error: 'INVALID_TOKEN',
      message: 'Invalid or malformed token'
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      error: 'TOKEN_EXPIRED',
      message: 'Token has expired'
    });
  }

  // Custom app errors (thrown with statusCode)
  const statusCode = err.statusCode || 500;
  const errorCode = err.errorCode || 'SERVER_ERROR';
  const message = statusCode === 500 ? 'An unexpected error occurred' : err.message;

  // Alert on unexpected server errors (5xx) — counter-throttled to avoid noise
  if (statusCode >= 500) {
    alertService.sendAlert(
      'SERVER_ERROR',
      {
        Route: `${req.method} ${req.originalUrl}`,
        'Error code': errorCode,
        Message: err.message || 'No message',
        'Error count': `>=${3} in 5 min window`,
        'Request ID': requestId,
      },
      'global'
    ).catch(() => {});
  }

  return res.status(statusCode).json({
    success: false,
    error: errorCode,
    message
  });
};

// Custom error class for throwing structured errors from services
class AppError extends Error {
  constructor(message, statusCode = 400, errorCode = 'APP_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

module.exports = { errorHandler, AppError };
