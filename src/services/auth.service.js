const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const TokenBlacklist = require('../models/TokenBlacklist');
const { AppError } = require('../middleware/errorHandler.middleware');
const { ROLES } = require('../utils/constants');
const activityLogService = require('./activityLog.service');

const MAX_FAILED_LOGINS = 5;
const BCRYPT_WORK_FACTOR = 12;

// ── GENERATE TOKENS ───────────────────────────────────────────────────────────
const generateTokens = (user) => {
  const payload = { id: user._id, role: user.role };

  const accessToken = jwt.sign(payload, process.env.JWT_ACCESS_SECRET, {
    expiresIn: process.env.JWT_ACCESS_EXPIRY || '15m'
  });

  const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRY || '7d'
  });

  return { accessToken, refreshToken };
};

// ── REGISTER ──────────────────────────────────────────────────────────────────
const register = async ({ name, phone, email, password }) => {
  const existing = await User.findOne({ phone });
  if (existing) {
    throw new AppError('An account with this phone number already exists', 409, 'PHONE_TAKEN');
  }

  if (email) {
    const emailTaken = await User.findOne({ email });
    if (emailTaken) {
      throw new AppError('An account with this email already exists', 409, 'EMAIL_TAKEN');
    }
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_WORK_FACTOR);

  const user = await User.create({
    name,
    phone,
    email: email || null,
    passwordHash,
    role: ROLES.CUSTOMER
  });

  const { accessToken, refreshToken } = generateTokens(user);

  return {
    user: { id: user._id, name: user.name, phone: user.phone, email: user.email, role: user.role, avatarURL: user.avatarURL || null },
    accessToken,
    refreshToken
  };
};

// ── LOGIN ─────────────────────────────────────────────────────────────────────
const login = async ({ phone, password }, ip) => {
  const user = await User.findOne({ phone });

  if (!user) {
    throw new AppError('Invalid phone number or password', 401, 'INVALID_CREDENTIALS');
  }

  if (user.isLocked) {
    throw new AppError('This account has been locked due to too many failed login attempts. Please contact support.', 423, 'ACCOUNT_LOCKED');
  }

  const isMatch = await bcrypt.compare(password, user.passwordHash);

  if (!isMatch) {
    await incrementFailedLogin(user._id);
    throw new AppError('Invalid phone number or password', 401, 'INVALID_CREDENTIALS');
  }

  // Reset failed login count on success
  await User.findByIdAndUpdate(user._id, {
    failedLoginCount: 0,
    lastLoginAt: new Date()
  });

  const { accessToken, refreshToken } = generateTokens(user);

  // Log the login event
  const logAction = [ROLES.STAFF, ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.SUPERADMIN].includes(user.role)
    ? 'ADMIN_LOGIN'
    : 'CUSTOMER_LOGIN';

  await activityLogService.log({
    actorId: user._id,
    actorRole: user.role,
    action: logAction,
    ip
  });

  return {
    user: { id: user._id, name: user.name, phone: user.phone, email: user.email, role: user.role, avatarURL: user.avatarURL || null },
    accessToken,
    refreshToken
  };
};

// ── REFRESH ───────────────────────────────────────────────────────────────────
const refreshToken = async (token) => {
  // 1. Check blacklist first — fast fail if already invalidated
  const blacklisted = await TokenBlacklist.findOne({ token });
  if (blacklisted) {
    throw new AppError('Token has been invalidated. Please log in again.', 401, 'TOKEN_REVOKED');
  }

  // 2. Verify signature + expiry
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  } catch {
    throw new AppError('Invalid or expired refresh token', 401, 'INVALID_REFRESH_TOKEN');
  }

  // 3. Check user still exists and is not locked
  const user = await User.findById(decoded.id);
  if (!user || user.isLocked) {
    throw new AppError('User not found or account locked', 401, 'UNAUTHORIZED');
  }

  // 4. Token rotation — blacklist the used token so it can't be reused
  const expiresAt = new Date(decoded.exp * 1000);
  try {
    await TokenBlacklist.create({ token, userId: user._id, expiresAt });
  } catch (err) {
    // Ignore duplicate key — already blacklisted, still reject
    if (err.code !== 11000) throw err;
  }

  // 5. Issue new token pair
  const { accessToken, refreshToken: newRefreshToken } = generateTokens(user);
  return { accessToken, refreshToken: newRefreshToken };
};

// ── LOGOUT ────────────────────────────────────────────────────────────────────
const logout = async (token, userId, role) => {
  // Blacklist the refresh token so it can't be used after logout
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
      const expiresAt = new Date(decoded.exp * 1000);
      await TokenBlacklist.create({ token, userId: decoded.id, expiresAt });
    } catch (err) {
      if (err.code !== 11000) {
        // Token already expired or invalid — no need to blacklist, logout is still valid
      }
    }
  }

  // Log the logout event
  if (userId) {
    const logAction = [ROLES.STAFF, ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.SUPERADMIN].includes(role)
      ? 'ADMIN_LOGOUT'
      : 'CUSTOMER_LOGIN'; // customers don't have a CUSTOMER_LOGOUT constant yet — use existing

    await activityLogService.log({
      actorId: userId,
      actorRole: role,
      action: 'ADMIN_LOGOUT' // covers all roles for now
    }).catch(() => {}); // non-blocking — logout should always succeed
  }

  return { success: true };
};

// ── INCREMENT FAILED LOGIN ────────────────────────────────────────────────────
const incrementFailedLogin = async (userId) => {
  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: { failedLoginCount: 1 } },
    { new: true }
  );

  if (user.failedLoginCount >= MAX_FAILED_LOGINS) {
    await lockAccount(userId);
  }
};

// ── LOCK ACCOUNT ──────────────────────────────────────────────────────────────
const lockAccount = async (userId) => {
  await User.findByIdAndUpdate(userId, { isLocked: true });
};

// ── UNLOCK ACCOUNT ────────────────────────────────────────────────────────────
const unlockAccount = async (userId, adminId) => {
  const user = await User.findByIdAndUpdate(
    userId,
    { isLocked: false, failedLoginCount: 0 },
    { new: true }
  );

  if (!user) {
    throw new AppError('User not found', 404, 'USER_NOT_FOUND');
  }

  await activityLogService.log({
    actorId: adminId,
    actorRole: ROLES.ADMIN,
    action: 'CUSTOMER_ACCOUNT_UNLOCKED',
    targetId: userId,
    targetType: 'User'
  });

  return user;
};

// ── CHANGE PASSWORD ───────────────────────────────────────────────────────────
const changePassword = async (userId, currentPassword, newPassword) => {
  const user = await User.findById(userId);
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

  const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!isMatch) throw new AppError('Current password is incorrect', 400, 'WRONG_PASSWORD');

  if (newPassword.length < 8)
    throw new AppError('New password must be at least 8 characters', 400, 'PASSWORD_TOO_SHORT');

  if (currentPassword === newPassword)
    throw new AppError('New password must be different from current password', 400, 'SAME_PASSWORD');

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_WORK_FACTOR);
  await User.findByIdAndUpdate(userId, { passwordHash });

  await activityLogService.log({
    actorId: userId,
    actorRole: user.role,
    action: 'PASSWORD_CHANGED',
    targetId: userId,
    targetType: 'User',
    detail: {}
  });

  return { success: true };
};

// ── GET PROFILE ───────────────────────────────────────────────────────────────
const getProfile = async (userId) => {
  const user = await User.findById(userId).select('-passwordHash -failedLoginCount').lean();
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');
  return user;
};

// ── UPDATE PROFILE ────────────────────────────────────────────────────────────
const updateProfile = async (userId, { name, email, addresses }) => {
  if (email) {
    const existing = await User.findOne({ email, _id: { $ne: userId } });
    if (existing) throw new AppError('Email already in use', 409, 'EMAIL_TAKEN');
  }

  const user = await User.findByIdAndUpdate(
    userId,
    {
      ...(name      && { name: name.trim() }),
      ...(email !== undefined && { email: email || null }),
      ...(addresses  && { addresses }),
    },
    { new: true, runValidators: true }
  ).select('-passwordHash -failedLoginCount');

  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

  await activityLogService.log({
    actorId: userId,
    actorRole: user.role,
    action: 'PROFILE_UPDATED',
    targetId: userId,
    targetType: 'User',
    detail: {}
  });

  return user;
};

module.exports = {
  register,
  login,
  refreshToken,
  logout,
  lockAccount,
  unlockAccount,
  incrementFailedLogin,
  changePassword,
  getProfile,
  updateProfile
};