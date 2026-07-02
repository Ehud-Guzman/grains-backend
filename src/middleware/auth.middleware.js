const jwt = require('jsonwebtoken');
const TokenBlacklist = require('../models/TokenBlacklist');
const User = require('../models/User');
const { AppError } = require('./errorHandler.middleware');
const logger = require('../utils/logger');

// A valid signature alone is not enough: logout/branch-switch blacklists the
// access token, and locking an account must cut off live sessions immediately
// rather than after the token's natural expiry.
const checkRevocationAndAccount = async (token, decoded) => {
  const [revoked, user] = await Promise.all([
    TokenBlacklist.exists({ token }),
    User.findById(decoded.id).select('isLocked').lean()
  ]);
  if (revoked) return 'TOKEN_REVOKED';
  if (!user || user.isLocked) return 'ACCOUNT_LOCKED';
  return null;
};

// Validates JWT and attaches req.user = { id, role }
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new AppError('No token provided', 401, 'NO_TOKEN'));
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);

    const rejection = await checkRevocationAndAccount(token, decoded);
    if (rejection === 'TOKEN_REVOKED') {
      return next(new AppError('Token has been invalidated. Please log in again.', 401, 'TOKEN_REVOKED'));
    }
    if (rejection === 'ACCOUNT_LOCKED') {
      return next(new AppError('Account not found or locked', 401, 'ACCOUNT_LOCKED'));
    }

    req.user = { id: decoded.id, role: decoded.role, branchId: decoded.branchId || null, customPermissions: decoded.customPermissions || [] };
    req.branchId = decoded.branchId || null;
    next();
  } catch (err) {
    next(err); // passes to error handler (handles JWT errors)
  }
};

// Attaches user if token present, continues without error if not.
// Revoked tokens and locked accounts are treated as anonymous, not errors.
const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);

    const rejection = await checkRevocationAndAccount(token, decoded);
    if (rejection) {
      logger.debug('[auth] optionalAuth ignored token', { reason: rejection });
      req.user = null;
      req.branchId = null;
      return next();
    }

    req.user = { id: decoded.id, role: decoded.role, branchId: decoded.branchId || null, customPermissions: decoded.customPermissions || [] };
    req.branchId = decoded.branchId || null;
  } catch (err) {
    logger.debug('[auth] optionalAuth ignored invalid token', { err: err.message });
    req.user = null;
    req.branchId = null;
  }

  next();
};

module.exports = { verifyToken, optionalAuth };
