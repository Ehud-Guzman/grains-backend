const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Branch = require('../models/Branch');
const TokenBlacklist = require('../models/TokenBlacklist');
const { AppError } = require('../middleware/errorHandler.middleware');
const { ROLES, LOG_ACTIONS, AUTH_LIMITS } = require('../utils/constants');
const activityLogService = require('./activityLog.service');
const alertService = require('./alert.service');
const notificationService = require('./notification.service');
const logger = require('../utils/logger');

const MAX_FAILED_LOGINS = AUTH_LIMITS.MAX_FAILED_LOGINS;
const BCRYPT_WORK_FACTOR = AUTH_LIMITS.BCRYPT_WORK_FACTOR;
const OTP_EXPIRY_MINUTES = AUTH_LIMITS.OTP_EXPIRY_MINUTES;
const OTP_MAX_ATTEMPTS = AUTH_LIMITS.OTP_MAX_ATTEMPTS;
const OTP_RESEND_COOLDOWN_MS = AUTH_LIMITS.OTP_RESEND_COOLDOWN_MS;

const GENERIC_RESET_ERROR = 'Invalid or expired code. Please request a new one.';

// ── GENERATE TOKENS ───────────────────────────────────────────────────────────
const generateTokens = (user, branchId = null) => {
  const payload = {
    id: user._id,
    role: user.role,
    branchId: branchId || null,
    customPermissions: user.customPermissions || []
  };

  const accessToken = jwt.sign(payload, process.env.JWT_ACCESS_SECRET, {
    expiresIn: process.env.JWT_ACCESS_EXPIRY || '15m'
  });

  const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRY || '7d'
  });

  return { accessToken, refreshToken };
};

// ── GENERATE PRE-AUTH TOKEN (short-lived, branch selection step) ──────────────
const generatePreAuthToken = (userId) => {
  return jwt.sign(
    { userId, step: 'branch_selection' },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: AUTH_LIMITS.PRE_AUTH_TOKEN_EXPIRY }
  );
};

const ADMIN_ROLES = [ROLES.STAFF, ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.SUPERADMIN];

// Blacklist a token until its natural expiry. Never throws — an expired/invalid
// token needs no blacklisting, and a duplicate key means it's already revoked.
const revokeToken = async (token, secret) => {
  if (!token) return;
  try {
    const decoded = jwt.verify(token, secret);
    await TokenBlacklist.create({
      token,
      userId: decoded.id,
      expiresAt: new Date(decoded.exp * 1000)
    });
  } catch (err) {
    if (err.code !== 11000 && !['TokenExpiredError', 'JsonWebTokenError'].includes(err.name)) {
      logger.error('[auth] Token revocation failed', { err: err.message });
    }
  }
};

const normalizeOnboarding = (onboarding = {}) => ({
  version: onboarding.version || 1,
  checklistProgress: onboarding.checklistProgress instanceof Map
    ? Object.fromEntries(onboarding.checklistProgress)
    : (onboarding.checklistProgress || {}),
  dismissedTips: Array.isArray(onboarding.dismissedTips) ? onboarding.dismissedTips : [],
  toursCompleted: Array.isArray(onboarding.toursCompleted) ? onboarding.toursCompleted : [],
  milestones: Array.isArray(onboarding.milestones) ? onboarding.milestones : [],
  helpCenterOpenedCount: onboarding.helpCenterOpenedCount || 0,
  lastMilestoneAt: onboarding.lastMilestoneAt || null,
  updatedAt: onboarding.updatedAt || null
});

// ── REGISTER ──────────────────────────────────────────────────────────────────
const register = async ({ name, phone, email, password, ip = null }) => {
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

  await activityLogService.log({
    actorId: user._id,
    actorRole: user.role,
    action: LOG_ACTIONS.CUSTOMER_REGISTERED,
    targetId: user._id,
    targetType: 'User',
    ip
  }).catch(err => logger.error('[auth] Activity log write failed', { err: err.message }));

  return {
    user: { id: user._id, name: user.name, phone: user.phone, email: user.email, role: user.role, avatarURL: user.avatarURL || null },
    accessToken,
    refreshToken
  };
};

// ── LOGIN ─────────────────────────────────────────────────────────────────────
// Customers get tokens immediately.
// Staff/Admin/Superadmin get a preAuthToken + branch list for step-2 branch selection.
const login = async ({ phone, password }, ip) => {
  const user = await User.findOne({ phone });

  if (!user) {
    throw new AppError('Invalid phone number or password', 401, 'INVALID_CREDENTIALS');
  }

  if (user.isLocked) {
    // Return a generic 401 to avoid confirming which phones are registered
    await activityLogService.log({
      actorId: user._id, actorRole: user.role,
      action: LOG_ACTIONS.FAILED_LOGIN, ip,
      detail: { phone: user.phone, reason: 'ACCOUNT_LOCKED' }
    }).catch(err => logger.error('[auth] Activity log write failed', { err: err.message }));
    throw new AppError('Invalid phone number or password', 401, 'INVALID_CREDENTIALS');
  }

  const isMatch = await bcrypt.compare(password, user.passwordHash);

  if (!isMatch) {
    await incrementFailedLogin(user._id, ip);
    await activityLogService.log({
      actorId: user._id,
      actorRole: user.role,
      action: LOG_ACTIONS.FAILED_LOGIN,
      ip,
      detail: { phone: user.phone }
    }).catch(err => logger.error('[auth] Activity log write failed', { err: err.message }));
    throw new AppError('Invalid phone number or password', 401, 'INVALID_CREDENTIALS');
  }

  // Reset failed login count on success
  await User.findByIdAndUpdate(user._id, {
    failedLoginCount: 0,
    lastLoginAt: new Date()
  });

  // ── CUSTOMER / DRIVER: immediate tokens, no branch selection needed ─────────
  if (!ADMIN_ROLES.includes(user.role)) {
    // Drivers are branch-scoped — embed their branchId so API middleware works
    const branchId = user.role === ROLES.DRIVER ? (user.branchId || null) : null;
    const { accessToken, refreshToken } = generateTokens(user, branchId);
    await activityLogService.log({ actorId: user._id, actorRole: user.role, action: 'CUSTOMER_LOGIN', ip });
    return {
      requiresBranchSelection: false,
      user: {
        id: user._id, name: user.name, phone: user.phone, email: user.email,
        role: user.role, avatarURL: user.avatarURL || null,
        ...(user.role === ROLES.DRIVER && {
          vehicleInfo: user.vehicleInfo,
          isAvailableForDelivery: user.isAvailableForDelivery
        })
      },
      accessToken,
      refreshToken
    };
  }

  // ── ADMIN / STAFF / SUPERVISOR: must select a branch ─────────────────────
  let branches;
  if (user.role === ROLES.SUPERADMIN) {
    // Superadmin sees all active branches
    branches = await Branch.find({ isActive: true }).select('name slug location phone').lean();

    // No branches yet (first-time setup) — let superadmin in without branch selection
    if (branches.length === 0) {
      const { accessToken, refreshToken } = generateTokens(user, null);
      await activityLogService.log({ actorId: user._id, actorRole: user.role, action: 'ADMIN_LOGIN', ip });
      return {
        requiresBranchSelection: false,
        firstTimeSetup: true,
        user: { id: user._id, name: user.name, phone: user.phone, email: user.email, role: user.role, avatarURL: user.avatarURL || null },
        accessToken,
        refreshToken
      };
    }
  } else {
    // Staff/Admin
    if (user.allowedBranchIds?.length > 0) {
      // Multi-branch user: show their explicitly allowed branches
      branches = await Branch.find({ _id: { $in: user.allowedBranchIds }, isActive: true })
        .select('name slug location phone').lean();
      if (branches.length === 0) {
        throw new AppError('None of your assigned branches are active. Contact your administrator.', 403, 'BRANCH_INACTIVE');
      }
    } else {
      // Single-branch user (legacy path)
      if (!user.branchId) {
        throw new AppError('Your account has no branch assigned. Contact your administrator.', 403, 'NO_BRANCH_ASSIGNED');
      }
      const branch = await Branch.findById(user.branchId).select('name slug location phone').lean();
      if (!branch) {
        throw new AppError('Your assigned branch is inactive. Contact your administrator.', 403, 'BRANCH_INACTIVE');
      }
      branches = [branch];
    }
  }

  const preAuthToken = generatePreAuthToken(user._id);

  await activityLogService.log({ actorId: user._id, actorRole: user.role, action: 'ADMIN_LOGIN', ip });

  return {
    requiresBranchSelection: true,
    preAuthToken,
    branches,
    user: { id: user._id, name: user.name, phone: user.phone, email: user.email, role: user.role, avatarURL: user.avatarURL || null }
  };
};

// ── SELECT BRANCH (step 2 for admin login) ────────────────────────────────────
const selectBranch = async (preAuthToken, branchId, ip = null) => {
  let decoded;
  try {
    decoded = jwt.verify(preAuthToken, process.env.JWT_ACCESS_SECRET);
  } catch {
    throw new AppError('Session expired. Please log in again.', 401, 'INVALID_PREAUTH_TOKEN');
  }

  if (decoded.step !== 'branch_selection') {
    throw new AppError('Invalid token for branch selection', 401, 'INVALID_PREAUTH_TOKEN');
  }

  // Prevent reuse — blacklist the preAuthToken immediately so it can't select a second branch
  try {
    const expiresAt = new Date(decoded.exp * 1000);
    await TokenBlacklist.create({ token: preAuthToken, userId: decoded.userId, expiresAt });
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate key = already consumed — reject to prevent replay
      throw new AppError('Session already used. Please log in again.', 401, 'INVALID_PREAUTH_TOKEN');
    }
    throw err;
  }

  const user = await User.findById(decoded.userId);
  if (!user || user.isLocked) {
    throw new AppError('User not found or account locked', 401, 'UNAUTHORIZED');
  }

  // Validate branch access
  let branch;
  if (user.role === ROLES.SUPERADMIN) {
    branch = await Branch.findOne({ _id: branchId, isActive: true });
    if (!branch) throw new AppError('Branch not found or inactive', 404, 'BRANCH_NOT_FOUND');
  } else {
    // Non-superadmin: validate against allowedBranchIds (multi-branch) or branchId (single-branch)
    const allowedIds = (user.allowedBranchIds || []).map(id => id.toString());
    if (allowedIds.length > 0) {
      if (!allowedIds.includes(branchId.toString())) {
        throw new AppError('You can only access your assigned branches', 403, 'FORBIDDEN');
      }
    } else {
      if (!user.branchId || user.branchId.toString() !== branchId.toString()) {
        throw new AppError('You can only access your assigned branch', 403, 'FORBIDDEN');
      }
    }
    branch = await Branch.findOne({ _id: branchId, isActive: true });
    if (!branch) throw new AppError('Your branch is currently inactive', 403, 'BRANCH_INACTIVE');
  }

  const { accessToken, refreshToken } = generateTokens(user, branch._id);

  await activityLogService.log({
    actorId: user._id,
    actorRole: user.role,
    action: LOG_ACTIONS.ADMIN_BRANCH_SELECTED,
    branchId: branch._id,
    ip,
    detail: { branchName: branch.name }
  }).catch(err => logger.error('[auth] Activity log write failed', { err: err.message }));

  return {
    user: { id: user._id, name: user.name, phone: user.phone, email: user.email, role: user.role, avatarURL: user.avatarURL || null },
    branch: { id: branch._id, name: branch.name, slug: branch.slug, location: branch.location },
    accessToken,
    refreshToken
  };
};

// ── SWITCH BRANCH (superadmin only, already logged in) ────────────────────────
const switchBranch = async (userId, branchId, oldRefreshToken = null, oldAccessToken = null) => {
  const user = await User.findById(userId);
  if (!user || user.role !== ROLES.SUPERADMIN) {
    throw new AppError('Only superadmin can switch branches', 403, 'FORBIDDEN');
  }

  let branch = null;
  if (branchId) {
    branch = await Branch.findOne({ _id: branchId, isActive: true });
    if (!branch) throw new AppError('Branch not found or inactive', 404, 'BRANCH_NOT_FOUND');
  }

  // Revoke the old token pair so the stale branch context can't be reused
  await revokeToken(oldRefreshToken, process.env.JWT_REFRESH_SECRET);
  await revokeToken(oldAccessToken, process.env.JWT_ACCESS_SECRET);

  const { accessToken, refreshToken } = generateTokens(user, branch?._id || null);

  return {
    branch: branch ? { id: branch._id, name: branch.name, slug: branch.slug, location: branch.location } : null,
    accessToken,
    refreshToken
  };
};

// ── REFRESH ───────────────────────────────────────────────────────────────────
const refreshToken = async (token, ip = null) => {
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

  // A role change or branch reassignment bumps tokenValidAfter (see
  // auth.middleware.js#checkRevocationAndAccount for the same check on access
  // tokens) — without this, refresh would keep handing out fresh access tokens
  // that carry the stale role/branchId forever, since it otherwise never
  // re-validates anything beyond "is this refresh token itself still valid".
  if (user.tokenValidAfter && decoded.iat * 1000 < new Date(user.tokenValidAfter).getTime()) {
    throw new AppError('Token has been invalidated. Please log in again.', 401, 'TOKEN_REVOKED');
  }

  // 4. Token rotation — blacklist the used token so it can't be reused
  const expiresAt = new Date(decoded.exp * 1000);
  try {
    await TokenBlacklist.create({ token, userId: user._id, expiresAt });
  } catch (err) {
    // Ignore duplicate key — already blacklisted, still reject
    if (err.code !== 11000) throw err;
  }

  // 5. Issue new token pair — preserve branchId from old token
  const { accessToken, refreshToken: newRefreshToken } = generateTokens(user, decoded.branchId || null);

  await activityLogService.log({
    actorId: user._id,
    actorRole: user.role,
    action: LOG_ACTIONS.TOKEN_REFRESHED,
    branchId: decoded.branchId || null,
    ip
  }).catch(err => logger.error('[auth] Activity log write failed', { err: err.message }));

  return {
    accessToken,
    refreshToken: newRefreshToken,
    user: { id: user._id, name: user.name, phone: user.phone, email: user.email, role: user.role, avatarURL: user.avatarURL || null }
  };
};

// ── LOGOUT ────────────────────────────────────────────────────────────────────
const logout = async (token, accessToken, userId, role) => {
  // Blacklist both tokens so neither survives the logout
  await revokeToken(token, process.env.JWT_REFRESH_SECRET);
  await revokeToken(accessToken, process.env.JWT_ACCESS_SECRET);

  // Log the logout event
  if (userId) {
    const logAction = ADMIN_ROLES.includes(role) ? LOG_ACTIONS.ADMIN_LOGOUT : LOG_ACTIONS.CUSTOMER_LOGOUT;
    await activityLogService.log({
      actorId: userId,
      actorRole: role,
      action: logAction
    }).catch(err => logger.error('[auth] Activity log failed on logout', { err: err.message })); // non-blocking — logout should always succeed
  }

  return { success: true };
};

// ── INCREMENT FAILED LOGIN ────────────────────────────────────────────────────
const incrementFailedLogin = async (userId, ip = null) => {
  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: { failedLoginCount: 1 } },
    { new: true }
  );

  // Alert after 3 failures (early warning — account hasn't locked yet)
  const ALERT_THRESHOLD = AUTH_LIMITS.ALERT_THRESHOLD;
  if (user.failedLoginCount === ALERT_THRESHOLD) {
    alertService.sendAlert(
      'BRUTE_FORCE_LOGIN',
      {
        Phone: user.phone,
        Role: user.role,
        'Failed attempts': `${user.failedLoginCount} (locks at ${MAX_FAILED_LOGINS})`,
        IP: ip || 'unknown',
      },
      `${ip || 'unknown'}:${user.phone}`
    ).catch(err => logger.error('[auth] Alert send failed', { err: err.message }));
  }

  if (user.failedLoginCount >= MAX_FAILED_LOGINS) {
    await lockAccount(userId);
  }
};

// ── LOCK ACCOUNT ──────────────────────────────────────────────────────────────
const lockAccount = async (userId) => {
  const user = await User.findByIdAndUpdate(userId, { isLocked: true }, { new: true });
  if (user) {
    const action = ADMIN_ROLES.includes(user.role)
      ? LOG_ACTIONS.ADMIN_ACCOUNT_LOCKED
      : user.role === ROLES.DRIVER
        ? LOG_ACTIONS.DRIVER_ACCOUNT_LOCKED
        : LOG_ACTIONS.CUSTOMER_ACCOUNT_LOCKED;
    await activityLogService.log({
      actorId: userId,
      actorRole: 'system',
      action,
      targetId: userId,
      targetType: 'User',
      detail: { reason: 'Too many failed login attempts' }
    }).catch(err => logger.error('[auth] Activity log write failed', { err: err.message }));

    alertService.sendAlert(
      'ACCOUNT_LOCKED',
      { Phone: user.phone, Role: user.role, Reason: 'Too many failed login attempts', 'User ID': String(userId) },
      String(userId)
    ).catch(err => logger.error('[auth] Alert send failed', { err: err.message }));
  }
};

// ── UNLOCK ACCOUNT ────────────────────────────────────────────────────────────
const unlockAccount = async (userId, adminId, actorRole = ROLES.ADMIN) => {
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
    actorRole,
    action: 'CUSTOMER_ACCOUNT_UNLOCKED',
    targetId: userId,
    targetType: 'User'
  });

  return user;
};

const PASSWORD_STRENGTH_RE = {
  minLength:  /.{8,}/,
  uppercase:  /[A-Z]/,
  digit:      /[0-9]/,
};

const validatePasswordStrength = (password) => {
  if (!PASSWORD_STRENGTH_RE.minLength.test(password))
    throw new AppError('Password must be at least 8 characters', 400, 'PASSWORD_TOO_SHORT');
  if (!PASSWORD_STRENGTH_RE.uppercase.test(password))
    throw new AppError('Password must contain at least one uppercase letter', 400, 'PASSWORD_TOO_WEAK');
  if (!PASSWORD_STRENGTH_RE.digit.test(password))
    throw new AppError('Password must contain at least one number', 400, 'PASSWORD_TOO_WEAK');
};

// ── CHANGE PASSWORD ───────────────────────────────────────────────────────────
// currentBranchId is the caller's own session branchId (req.branchId from their
// JWT) — reused so the reissued token keeps the same branch context rather than
// silently dropping an admin back to "no branch selected".
const changePassword = async (userId, currentPassword, newPassword, ip = null, currentBranchId = null) => {
  const user = await User.findById(userId);
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

  const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!isMatch) throw new AppError('Current password is incorrect', 400, 'WRONG_PASSWORD');

  validatePasswordStrength(newPassword);

  if (currentPassword === newPassword)
    throw new AppError('New password must be different from current password', 400, 'SAME_PASSWORD');

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_WORK_FACTOR);
  // Any access/refresh token issued before this instant must stop working —
  // otherwise a stolen token survives the very password change meant to kill it.
  // The caller's own current session is reissued fresh tokens right after this
  // (see auth.controller.js#changePassword), so this doesn't log the user out.
  const tokenValidAfter = new Date();
  await User.findByIdAndUpdate(userId, { passwordHash, tokenValidAfter });

  await activityLogService.log({
    actorId: userId,
    actorRole: user.role,
    action: LOG_ACTIONS.PASSWORD_CHANGED,
    targetId: userId,
    targetType: 'User',
    ip,
    detail: {}
  });

  user.passwordHash = passwordHash;
  const { accessToken, refreshToken } = generateTokens(user, currentBranchId);
  return { success: true, accessToken, refreshToken };
};

// ── FORGOT PASSWORD ───────────────────────────────────────────────────────────
// Always returns the same generic result regardless of whether the phone is
// registered, so the response can't be used to enumerate accounts.
const forgotPassword = async (phone, ip = null) => {
  const user = await User.findOne({ phone });

  // Locked accounts can still request a code — proving phone/email ownership
  // via OTP is exactly how a legitimately locked-out customer recovers, and
  // resetPassword() below unlocks the account on a successful reset.
  if (user) {
    // Per-phone resend cooldown — without this, only the shared IP-based rate
    // limiter gates this endpoint, so a phone number can be SMS-bombed with
    // reset codes (real cost once SMS leaves sandbox) and a user's in-flight
    // code gets silently invalidated by every repeat request. Derived from
    // passwordResetExpires rather than a new field: issuedAt = expiry - TTL.
    if (user.passwordResetExpires) {
      const issuedAt = user.passwordResetExpires.getTime() - OTP_EXPIRY_MINUTES * 60 * 1000;
      if (Date.now() - issuedAt < OTP_RESEND_COOLDOWN_MS) {
        // Same generic response as the success path — must not reveal that a
        // code was already sent recently, or this becomes an enumeration signal.
        return { success: true, message: 'If an account exists for this number, a reset code has been sent.' };
      }
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const passwordResetOtpHash = await bcrypt.hash(otp, BCRYPT_WORK_FACTOR);

    await User.findByIdAndUpdate(user._id, {
      passwordResetOtpHash,
      passwordResetExpires: new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000),
      passwordResetAttempts: 0
    });

    notificationService.dispatchPasswordResetOtp(user, otp)
      .catch(err => logger.error('[auth] Failed to dispatch reset OTP', { err: err.message }));

    await activityLogService.log({
      actorId: user._id,
      actorRole: user.role,
      action: LOG_ACTIONS.PASSWORD_RESET_REQUESTED,
      targetId: user._id,
      targetType: 'User',
      ip
    }).catch(err => logger.error('[auth] Activity log write failed', { err: err.message }));
  }

  return { success: true, message: 'If an account exists for this number, a reset code has been sent.' };
};

// ── RESET PASSWORD (via OTP) ──────────────────────────────────────────────────
const resetPassword = async (phone, otp, newPassword, ip = null) => {
  const user = await User.findOne({ phone });

  if (!user || !user.passwordResetOtpHash || !user.passwordResetExpires) {
    throw new AppError(GENERIC_RESET_ERROR, 400, 'INVALID_RESET_CODE');
  }

  if (user.passwordResetExpires < new Date()) {
    await User.findByIdAndUpdate(user._id, {
      passwordResetOtpHash: null, passwordResetExpires: null, passwordResetAttempts: 0
    });
    throw new AppError(GENERIC_RESET_ERROR, 400, 'INVALID_RESET_CODE');
  }

  if (user.passwordResetAttempts >= OTP_MAX_ATTEMPTS) {
    await User.findByIdAndUpdate(user._id, {
      passwordResetOtpHash: null, passwordResetExpires: null, passwordResetAttempts: 0
    });
    throw new AppError(GENERIC_RESET_ERROR, 400, 'INVALID_RESET_CODE');
  }

  const isMatch = await bcrypt.compare(otp, user.passwordResetOtpHash);
  if (!isMatch) {
    await User.findByIdAndUpdate(user._id, { $inc: { passwordResetAttempts: 1 } });
    throw new AppError(GENERIC_RESET_ERROR, 400, 'INVALID_RESET_CODE');
  }

  validatePasswordStrength(newPassword);

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_WORK_FACTOR);
  // Kill any tokens issued before this reset — a password reset is often a
  // direct response to a compromised account, so a stolen token must not
  // survive it. Unlike changePassword, this flow is unauthenticated (OTP-based)
  // so there's no caller session to reissue; the user simply logs in fresh.
  await User.findByIdAndUpdate(user._id, {
    passwordHash,
    isLocked: false,
    failedLoginCount: 0,
    passwordResetOtpHash: null,
    passwordResetExpires: null,
    passwordResetAttempts: 0,
    tokenValidAfter: new Date()
  });

  await activityLogService.log({
    actorId: user._id,
    actorRole: user.role,
    action: LOG_ACTIONS.PASSWORD_RESET_COMPLETED,
    targetId: user._id,
    targetType: 'User',
    ip
  }).catch(err => logger.error('[auth] Activity log write failed', { err: err.message }));

  return { success: true };
};

// ── GET PROFILE ───────────────────────────────────────────────────────────────
const getProfile = async (userId) => {
  const user = await User.findById(userId).select('-passwordHash -failedLoginCount').lean();
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');
  user.onboarding = normalizeOnboarding(user.onboarding);
  return user;
};

// ── UPDATE PROFILE ────────────────────────────────────────────────────────────
const updateProfile = async (userId, { name, email, addresses, kraPin, smsOptOut }, ip = null) => {
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
      ...(kraPin !== undefined && { kraPin: kraPin ? kraPin.trim().toUpperCase() : null }),
      ...(typeof smsOptOut === 'boolean' && { smsOptOut }),
    },
    { new: true, runValidators: true }
  ).select('-passwordHash -failedLoginCount');

  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

  await activityLogService.log({
    actorId: userId,
    actorRole: user.role,
    action: LOG_ACTIONS.PROFILE_UPDATED,
    targetId: userId,
    targetType: 'User',
    ip,
    detail: {}
  });

  return user;
};

const getOnboarding = async (userId) => {
  const user = await User.findById(userId).select('role onboarding');
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

  return {
    role: user.role,
    onboarding: normalizeOnboarding(user.onboarding)
  };
};

const updateOnboarding = async (userId, payload = {}) => {
  const user = await User.findById(userId).select('role onboarding');
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

  const next = normalizeOnboarding(user.onboarding);

  if (payload.checklistProgress && typeof payload.checklistProgress === 'object') {
    next.checklistProgress = payload.checklistProgress;
  }
  if (Array.isArray(payload.dismissedTips)) {
    next.dismissedTips = [...new Set(payload.dismissedTips)];
  }
  if (Array.isArray(payload.toursCompleted)) {
    next.toursCompleted = [...new Set(payload.toursCompleted)];
  }
  if (Array.isArray(payload.milestones)) {
    next.milestones = [...new Set(payload.milestones)];
    next.lastMilestoneAt = next.milestones.length ? new Date() : next.lastMilestoneAt;
  }
  if (payload.incrementHelpCenter === true) {
    next.helpCenterOpenedCount += 1;
  }

  next.updatedAt = new Date();

  user.onboarding = {
    version: 1,
    checklistProgress: next.checklistProgress,
    dismissedTips: next.dismissedTips,
    toursCompleted: next.toursCompleted,
    milestones: next.milestones,
    helpCenterOpenedCount: next.helpCenterOpenedCount,
    lastMilestoneAt: next.lastMilestoneAt,
    updatedAt: next.updatedAt
  };

  await user.save();

  return {
    role: user.role,
    onboarding: normalizeOnboarding(user.onboarding)
  };
};

module.exports = {
  register,
  login,
  selectBranch,
  switchBranch,
  refreshToken,
  logout,
  lockAccount,
  unlockAccount,
  incrementFailedLogin,
  changePassword,
  forgotPassword,
  resetPassword,
  getProfile,
  updateProfile,
  getOnboarding,
  updateOnboarding
};
