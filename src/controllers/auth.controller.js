const authService = require('../services/auth.service');
const { success } = require('../utils/apiResponse');

const register = async (req, res, next) => {
  try {
    const { name, phone, email, password } = req.body;
    const result = await authService.register({ name, phone, email, password });
    return success(res, result, 'Account created successfully', 201);
  } catch (err) {
    next(err);
  }
};

const login = async (req, res, next) => {
  try {
    const { phone, password } = req.body;
    const ip = req.ip || req.headers['x-forwarded-for'];
    const result = await authService.login({ phone, password }, ip);
    return success(res, result, 'Login successful');
  } catch (err) {
    next(err);
  }
};

const refresh = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ success: false, error: 'MISSING_TOKEN', message: 'Refresh token required' });
    }
    const result = await authService.refreshToken(refreshToken);
    return success(res, result, 'Token refreshed');
  } catch (err) {
    next(err);
  }
};

const logout = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    const userId = req.user?.id;
    const role   = req.user?.role;
    // Blacklist refresh token + log the event
    await authService.logout(refreshToken, userId, role);
    return success(res, null, 'Logged out successfully');
  } catch (err) {
    next(err);
  }
};

const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'MISSING_FIELDS',
        message: 'Current and new password are required'
      });
    }
    await authService.changePassword(req.user.id, currentPassword, newPassword);
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
    const profile = await authService.updateProfile(req.user.id, { name, email, addresses });
    return success(res, profile, 'Profile updated');
  } catch (err) { next(err); }
};

module.exports = { register, login, refresh, logout, changePassword, getProfile, updateProfile };