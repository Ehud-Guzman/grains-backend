const { AppError } = require('./errorHandler.middleware');
const { ROLES } = require('../utils/constants');
const alertService = require('../services/alert.service');

// Roles that should never be anywhere near admin routes
const LOW_PRIVILEGE_ROLES = [ROLES.CUSTOMER, ROLES.GUEST];

// Role hierarchy - higher index = more permissions
const ROLE_HIERARCHY = [
  ROLES.CUSTOMER,
  ROLES.DRIVER,
  ROLES.STAFF,
  ROLES.SUPERVISOR,
  ROLES.ADMIN,
  ROLES.SUPERADMIN
];



// requireRole('supervisor', 'admin', 'superadmin') - user must have one of these roles
const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError('Authentication required', 401, 'UNAUTHORIZED'));
    }

    if (!roles.includes(req.user.role)) {
      return next(new AppError('You do not have permission to perform this action', 403, 'FORBIDDEN'));
    }

    next();
  };
};

// requireMinRole('supervisor') - user must be supervisor or above
const requireMinRole = (minRole) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError('Authentication required', 401, 'UNAUTHORIZED'));
    }

    const userIndex = ROLE_HIERARCHY.indexOf(req.user.role);
    const minIndex = ROLE_HIERARCHY.indexOf(minRole);

    if (userIndex < minIndex) {
      // Alert when a customer or guest token is used against any protected route
      if (LOW_PRIVILEGE_ROLES.includes(req.user.role)) {
        alertService.sendAlert(
          'ROLE_VIOLATION',
          {
            'User ID': String(req.user.id),
            Role: req.user.role,
            Route: `${req.method} ${req.originalUrl}`,
            'Required min role': minRole,
            IP: req.ip || 'unknown',
          },
          `${req.user.id}:${req.originalUrl}`
        ).catch(() => {});
      }
      return next(new AppError('You do not have permission to perform this action', 403, 'FORBIDDEN'));
    }

    next();
  };
};

// requireBusinessRole('supervisor') — a BUSINESS operator at or above minRole.
//
// Superadmin is explicitly excluded. It is a platform/oversight role, not a
// trading one: the admin UI reflects that with a separate superadmin nav whose
// business sections are labelled "Observe (View Only)", a ViewOnlyBanner that
// tells the user they "cannot perform operations", and `viewOnly` flags that
// hide every action button on orders, products, stock, intake, customers,
// reports and alerts.
//
// This guard is what makes that boundary real rather than cosmetic. It
// previously *admitted* superadmin whenever a branch was selected — and since
// the login flow forces a superadmin to pick a branch before they get a token,
// the carve-out always applied, so every business write below was reachable
// with a superadmin token even though the UI hid the buttons. Route comments
// across ~15 files read "business operations — superadmin CANNOT perform",
// which is what this now actually enforces.
//
// Trade-off, accepted deliberately: an owner who is the only superadmin cannot
// run day-to-day trading with that account and must create a branch staff or
// admin account for it. That is the behaviour the UI already describes.
//
// Note the split of responsibility, so this does not read as an oversight:
//   • business operations (orders, products, stock, intake, customers,
//     coupons, promotions, broadcast, payment confirmation) → THIS guard
//   • platform/system concerns (branches, users, logs, backups, eTIMS
//     credentials, cross-branch settings) → requireRole('superadmin') or
//     requireSuperadminOrPermission(...), which superadmin passes
const requireBusinessRole = (minRole) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError('Authentication required', 401, 'UNAUTHORIZED'));
    }

    if (req.user.role === ROLES.SUPERADMIN) {
      return next(new AppError(
        'Superadmin is a view-only oversight role for business operations. Use a branch staff or admin account to perform them.',
        403,
        'SUPERADMIN_VIEW_ONLY'
      ));
    }

    const userIndex = ROLE_HIERARCHY.indexOf(req.user.role);
    const minIndex = ROLE_HIERARCHY.indexOf(minRole);

    if (userIndex < minIndex) {
      return next(new AppError('You do not have permission to perform this action', 403, 'FORBIDDEN'));
    }

    next();
  };
};

// Ensures a non-superadmin request has a branchId (auto-enforced via JWT)
const requireBranch = (req, res, next) => {
  if (!req.branchId) {
    return next(new AppError('Branch context required', 403, 'BRANCH_REQUIRED'));
  }
  next();
};

// requireSuperadminOrPermission('manage_branches') — superadmin OR a user explicitly granted the named permission
const requireSuperadminOrPermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError('Authentication required', 401, 'UNAUTHORIZED'));
    }
    if (req.user.role === ROLES.SUPERADMIN || req.user.customPermissions?.includes(permission)) {
      return next();
    }
    return next(new AppError('You do not have permission to perform this action', 403, 'FORBIDDEN'));
  };
};

module.exports = { requireRole, requireMinRole, requireBusinessRole, requireBranch, requireSuperadminOrPermission };
