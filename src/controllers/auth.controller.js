const authService = require('../services/auth.service');
const { success, error } = require('../utils/apiResponse');
const { AUTH_LIMITS } = require('../utils/constants');
const { isValidImageBuffer } = require('../utils/validateImageBuffer');

// Refresh token cookie options — HttpOnly prevents JS access (XSS mitigation).
// SameSite=None + Secure for cross-origin prod; Lax for same-origin dev.
const refreshCookieOptions = () => ({
  httpOnly: true,
  secure:   process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  maxAge:   AUTH_LIMITS.REFRESH_COOKIE_MAX_AGE_MS,
  path:     '/api/auth',
});

const setRefreshCookie = (res, token) =>
  res.cookie('refreshToken', token, refreshCookieOptions());

const clearRefreshCookie = (res) =>
  res.clearCookie('refreshToken', { path: '/api/auth' });

// Read refresh token from cookie first, body as fallback (API clients / Postman)
const extractRefreshToken = (req) =>
  req.cookies?.refreshToken || req.body?.refreshToken || null;

const extractAccessToken = (req) => {
  const authHeader = req.headers.authorization;
  return authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
};

const register = async (req, res, next) => {
  try {
    const { name, phone, email, password } = req.body;
    const ip = req.ip;
    const result = await authService.register({ name, phone, email, password, ip });
    setRefreshCookie(res, result.refreshToken);
    const { refreshToken: _rt, ...data } = result;
    return success(res, data, 'Account created successfully', 201);
  } catch (err) {
    next(err);
  }
};

const login = async (req, res, next) => {
  try {
    const { phone, password } = req.body;
    const ip = req.ip;
    const userAgent = req.headers['user-agent'] || 'unknown';
    const result = await authService.login({ phone, password }, ip, userAgent);

    // Only set the cookie when full tokens are issued (customers/drivers, or
    // first-time superadmin). Admins requiring branch selection get a preAuthToken
    // in the body only — cookie is set after selectBranch completes.
    if (!result.requiresBranchSelection && result.refreshToken) {
      setRefreshCookie(res, result.refreshToken);
      const { refreshToken: _rt, ...data } = result;
      return success(res, data, 'Login successful');
    }

    return success(res, result, 'Login successful');
  } catch (err) {
    next(err);
  }
};

const verifyTwoFactor = async (req, res, next) => {
  try {
    const { twoFactorToken, otp } = req.body;
    if (!twoFactorToken || !otp) {
      return error(res, 'twoFactorToken and otp are required', 'MISSING_FIELDS');
    }
    const ip = req.ip;
    const result = await authService.verifyTwoFactor(twoFactorToken, otp, ip);

    // Same shape as login()'s result — only set the cookie when full tokens
    // are issued directly (first-time-superadmin shortcut); otherwise this
    // returns requiresBranchSelection+preAuthToken and the cookie is set once
    // /select-branch completes.
    if (!result.requiresBranchSelection && result.refreshToken) {
      setRefreshCookie(res, result.refreshToken);
      const { refreshToken: _rt, ...data } = result;
      return success(res, data, 'Verification successful');
    }

    return success(res, result, 'Verification successful');
  } catch (err) {
    next(err);
  }
};

const selectBranch = async (req, res, next) => {
  try {
    const { preAuthToken, branchId } = req.body;
    if (!preAuthToken || !branchId) {
      return error(res, 'preAuthToken and branchId are required', 'MISSING_FIELDS');
    }
    const ip = req.ip;
    const result = await authService.selectBranch(preAuthToken, branchId, ip);
    setRefreshCookie(res, result.refreshToken);
    const { refreshToken: _rt, ...data } = result;
    return success(res, data, 'Branch selected');
  } catch (err) {
    next(err);
  }
};

const switchBranch = async (req, res, next) => {
  try {
    const { branchId } = req.body;
    const oldToken = extractRefreshToken(req);
    const result = await authService.switchBranch(req.user.id, branchId || null, oldToken, extractAccessToken(req));
    setRefreshCookie(res, result.refreshToken);
    const { refreshToken: _rt, ...data } = result;
    return success(res, data, 'Branch switched');
  } catch (err) {
    next(err);
  }
};

// A malicious page can trigger a cross-site POST to this endpoint and the
// browser will still attach the refreshToken cookie (SameSite=None in prod,
// since frontend/backend are on different origins) — CORS blocks the attacker
// page from reading the JSON response, but not the request from firing, so an
// attacker can still force token rotation. Reject only on an explicit
// Origin/Referer mismatch; allow through when neither header is present
// (non-browser clients, e.g. Postman/curl in dev, can't be checked this way,
// and that's not the threat this closes — browsers don't let JS spoof Origin).
const isAllowedOrigin = (req) => {
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return true;
  return origin.startsWith(process.env.FRONTEND_URL);
};

const refresh = async (req, res, next) => {
  try {
    if (!isAllowedOrigin(req)) {
      return error(res, 'Request origin not allowed', 'CSRF_ORIGIN_MISMATCH', 403);
    }
    const refreshToken = extractRefreshToken(req);
    if (!refreshToken) {
      return error(res, 'Refresh token required', 'MISSING_TOKEN');
    }
    const ip = req.ip;
    const result = await authService.refreshToken(refreshToken, ip);
    setRefreshCookie(res, result.refreshToken);
    const { refreshToken: _rt, ...data } = result;
    return success(res, data, 'Token refreshed');
  } catch (err) {
    next(err);
  }
};

const logout = async (req, res, next) => {
  try {
    const refreshToken = extractRefreshToken(req);
    const userId = req.user?.id;
    const role   = req.user?.role;
    await authService.logout(refreshToken, extractAccessToken(req), userId, role);
    clearRefreshCookie(res);
    return success(res, null, 'Logged out successfully');
  } catch (err) {
    next(err);
  }
};

const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return error(res, 'Current and new password are required', 'MISSING_FIELDS');
    }
    const result = await authService.changePassword(req.user.id, currentPassword, newPassword, req.ip, req.branchId);
    // Password change invalidates every token issued before it (see
    // auth.service.js) — including the one on this very request. Reissue a
    // fresh pair immediately so the caller's own session isn't logged out by
    // the change they just made.
    setRefreshCookie(res, result.refreshToken);
    return success(res, { accessToken: result.accessToken }, 'Password changed successfully');
  } catch (err) {
    next(err);
  }
};

const forgotPassword = async (req, res, next) => {
  try {
    const { phone } = req.body;
    const result = await authService.forgotPassword(phone, req.ip);
    return success(res, null, result.message);
  } catch (err) {
    next(err);
  }
};

const resetPassword = async (req, res, next) => {
  try {
    const { phone, otp, newPassword } = req.body;
    await authService.resetPassword(phone, otp, newPassword, req.ip);
    return success(res, null, 'Password reset successfully. You can now log in.');
  } catch (err) {
    next(err);
  }
};

const getProfile = async (req, res, next) => {
  try {
    const profile = await authService.getProfile(req.user.id);
    return success(res, profile);
  } catch (err) { next(err); }
};

const updateProfile = async (req, res, next) => {
  try {
    const { name, email, addresses, kraPin, smsOptOut } = req.body;
    const profile = await authService.updateProfile(req.user.id, { name, email, addresses, kraPin, smsOptOut }, req.ip);
    return success(res, profile, 'Profile updated');
  } catch (err) { next(err); }
};

const getOnboarding = async (req, res, next) => {
  try {
    const data = await authService.getOnboarding(req.user.id);
    return success(res, data);
  } catch (err) { next(err); }
};

const updateOnboarding = async (req, res, next) => {
  try {
    const data = await authService.updateOnboarding(req.user.id, req.body || {});
    return success(res, data, 'Onboarding updated');
  } catch (err) { next(err); }
};

const uploadAvatar = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image provided' });
    }

    if (!isValidImageBuffer(req.file.buffer)) {
      return res.status(400).json({ success: false, message: 'File is not a valid JPEG, PNG, or WebP image' });
    }

    const cloudinary = require('cloudinary').v2;
    const url = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: 'grains-shop/avatars',
          public_id: `user-${req.user.id}`,
          overwrite: true,
          transformation: [
            { width: 400, height: 400, crop: 'fill', gravity: 'face', quality: 'auto', fetch_format: 'auto' }
          ]
        },
        (err, result) => err ? reject(err) : resolve(result.secure_url)
      );
      stream.end(req.file.buffer);
    });

    const User = require('../models/User');
    await User.findByIdAndUpdate(req.user.id, { avatarURL: url });

    const activityLogService = require('../services/activityLog.service');
    await activityLogService.log({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'PROFILE_UPDATED',
      targetId: req.user.id,
      targetType: 'User',
      detail: { updatedFields: ['avatarURL'] }
    });

    return res.json({ success: true, data: { avatarURL: url }, message: 'Avatar updated' });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  register,
  login,
  verifyTwoFactor,
  selectBranch,
  switchBranch,
  refresh,
  logout,
  changePassword,
  forgotPassword,
  resetPassword,
  getProfile,
  updateProfile,
  getOnboarding,
  updateOnboarding,
  uploadAvatar
};
