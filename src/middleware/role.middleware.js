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

const requireBusinessRole = (minRole) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError('Authentication required', 401, 'UNAUTHORIZED'));
    }

    // Superadmin can do business ops only when they have selected a branch
    if (req.user.role === ROLES.SUPERADMIN) {
      if (!req.branchId) {
        return next(new AppError('Please select a branch to perform this action', 403, 'BRANCH_REQUIRED'));
      }
      return next(); // superadmin with branch context has full access
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
