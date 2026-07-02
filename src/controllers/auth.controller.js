const authService = require('../services/auth.service');
const { success, error } = require('../utils/apiResponse');
const { AUTH_LIMITS } = require('../utils/constants');

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
    const result = await authService.login({ phone, password }, ip);

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

const refresh = async (req, res, next) => {
  try {
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
    await authService.changePassword(req.user.id, currentPassword, newPassword, req.ip);
    return success(res, null, 'Password changed successfully');
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
    const { name, email, addresses } = req.body;
    const profile = await authService.updateProfile(req.user.id, { name, email, addresses }, req.ip);
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
  selectBranch,
  switchBranch,
  refresh,
  logout,
  changePassword,
  getProfile,
  updateProfile,
  getOnboarding,
  updateOnboarding,
  uploadAvatar
};
