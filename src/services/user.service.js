const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { AppError } = require('../middleware/errorHandler.middleware');
const activityLogService = require('./activityLog.service');
const { ROLES, LOG_ACTIONS } = require('../utils/constants');
const { paginate, buildPaginationMeta } = require('../utils/paginate');

const BCRYPT_WORK_FACTOR = 12;

// Roles that can be assigned to admin accounts
const ADMIN_ROLES = [ROLES.STAFF, ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.SUPERADMIN];

// ── GET ALL ADMIN/STAFF ACCOUNTS ──────────────────────────────────────────────
// Super-admin only - SRS 5.6
const getAllAdminUsers = async (filters = {}, query = {}) => {
  const { page, limit, skip } = paginate(query);

  const matchStage = {
    role: { $in: ADMIN_ROLES }
  };

  if (filters.role) matchStage.role = filters.role;
  if (filters.search) {
    const regex = { $regex: filters.search, $options: 'i' };
    matchStage.$or = [{ name: regex }, { phone: regex }, { email: regex }];
  }

  const [total, users] = await Promise.all([
    User.countDocuments(matchStage),
    User.find(matchStage)
      .select('-passwordHash -failedLoginCount')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
  ]);

  return { users, pagination: buildPaginationMeta(page, limit, total) };
};

// ── CREATE ADMIN ACCOUNT ──────────────────────────────────────────────────────
// Super-admin creates staff/supervisor/admin accounts - SRS 4.2
// Note: Role escalation requires Super-Admin approval per SRS
const createAdminUser = async ({ name, phone, email, password, role }, superAdminId) => {
  if (!ADMIN_ROLES.includes(role)) {
    throw new AppError(`Invalid role. Must be one of: ${ADMIN_ROLES.join(', ')}`, 400, 'INVALID_ROLE');
  }

  const existing = await User.findOne({ phone });
  if (existing) throw new AppError('An account with this phone number already exists', 409, 'PHONE_TAKEN');

  if (email) {
    const emailTaken = await User.findOne({ email });
    if (emailTaken) throw new AppError('An account with this email already exists', 409, 'EMAIL_TAKEN');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_WORK_FACTOR);

  const user = await User.create({
    name,
    phone,
    email: email || null,
    passwordHash,
    role
  });

  await activityLogService.log({
    actorId: superAdminId,
    actorRole: ROLES.SUPERADMIN,
    action: LOG_ACTIONS.ADMIN_CREATED,
    targetId: user._id,
    targetType: 'User',
    detail: { name, phone, role }
  });

  return {
    id: user._id,
    name: user.name,
    phone: user.phone,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt
  };
};

// ── CHANGE ROLE ───────────────────────────────────────────────────────────────
// Super-admin only - SRS 4.2 "Role escalation requires Super-Admin approval"
const changeRole = async (userId, newRole, superAdminId) => {
  if (!ADMIN_ROLES.includes(newRole)) {
    throw new AppError(`Invalid role. Must be one of: ${ADMIN_ROLES.join(', ')}`, 400, 'INVALID_ROLE');
  }

  const user = await User.findById(userId);
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

  // Prevent changing own role
  if (userId.toString() === superAdminId.toString()) {
    throw new AppError('You cannot change your own role', 400, 'CANNOT_CHANGE_OWN_ROLE');
  }

  const previousRole = user.role;
  user.role = newRole;
  await user.save();

  await activityLogService.log({
    actorId: superAdminId,
    actorRole: ROLES.SUPERADMIN,
    action: LOG_ACTIONS.ADMIN_ROLE_CHANGED,
    targetId: userId,
    targetType: 'User',
    detail: { name: user.name, previousRole, newRole }
  });

  return {
    id: user._id,
    name: user.name,
    role: user.role
  };
};

// ── LOCK / UNLOCK ACCOUNT ─────────────────────────────────────────────────────
// Super-admin only
const lockAdminAccount = async (userId, superAdminId) => {
  const user = await User.findById(userId);
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

  if (userId.toString() === superAdminId.toString()) {
    throw new AppError('You cannot lock your own account', 400, 'CANNOT_LOCK_OWN_ACCOUNT');
  }

  user.isLocked = true;
  await user.save();

  await activityLogService.log({
    actorId: superAdminId,
    actorRole: ROLES.SUPERADMIN,
    action: LOG_ACTIONS.CUSTOMER_ACCOUNT_LOCKED,
    targetId: userId,
    targetType: 'User',
    detail: { name: user.name, role: user.role }
  });

  return { id: user._id, name: user.name, isLocked: true };
};

const unlockAdminAccount = async (userId, superAdminId) => {
  const user = await User.findByIdAndUpdate(
    userId,
    { isLocked: false, failedLoginCount: 0 },
    { new: true }
  );

  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

  await activityLogService.log({
    actorId: superAdminId,
    actorRole: ROLES.SUPERADMIN,
    action: LOG_ACTIONS.CUSTOMER_ACCOUNT_UNLOCKED,
    targetId: userId,
    targetType: 'User',
    detail: { name: user.name, role: user.role }
  });

  return { id: user._id, name: user.name, isLocked: false };
};

// ── RESET PASSWORD ────────────────────────────────────────────────────────────
// Super-admin resets a staff member's password
const resetPassword = async (userId, newPassword, superAdminId) => {
  if (!newPassword || newPassword.length < 8) {
    throw new AppError('Password must be at least 8 characters', 400, 'INVALID_PASSWORD');
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_WORK_FACTOR);

  const user = await User.findByIdAndUpdate(
    userId,
    { passwordHash, failedLoginCount: 0, isLocked: false },
    { new: true }
  );

  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

  await activityLogService.log({
    actorId: superAdminId,
    actorRole: ROLES.SUPERADMIN,
    action: 'ADMIN_PASSWORD_RESET',
    targetId: userId,
    targetType: 'User',
    detail: { name: user.name }
  });

  return { id: user._id, name: user.name, message: 'Password reset successfully' };
};

module.exports = {
  getAllAdminUsers,
  createAdminUser,
  changeRole,
  lockAdminAccount,
  unlockAdminAccount,
  resetPassword
};
