const settingsService = require('../services/settings.service');
const { AppError } = require('./errorHandler.middleware');

// Enforces Settings.platformLocked — the superadmin "stop everything" switch —
// on mutating requests within a branch context. Mounted on the branch-scoped
// admin/driver routers AFTER verifyToken (so req.branchId is populated).
//
// Deliberately NOT mounted on: settings routes (superadmin must be able to flip
// the lock back off), backups, global-settings, users, and logs (global,
// non-branch operations), or the M-Pesa callback (Safaricom must never be
// blocked from confirming money that already moved). Public order placement is
// covered separately by assertShopCanAcceptOrders in order.service.js.
//
// Reads stay open — a locked branch is frozen, not invisible.
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const checkPlatformLock = async (req, res, next) => {
  try {
    if (!WRITE_METHODS.has(req.method)) return next();
    if (!req.branchId) return next(); // superadmin without branch context — global ops only

    const settings = await settingsService.getSettings(req.branchId);
    if (settings.platformLocked) {
      return next(new AppError(
        'This branch is locked by a superadmin. All changes are temporarily disabled.',
        423,
        'PLATFORM_LOCKED'
      ));
    }
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { checkPlatformLock };
