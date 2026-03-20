const settingsService = require('../../services/settings.service');
const { success } = require('../../utils/apiResponse');

// GET /api/settings  (public — shop info only)
const getPublic = async (req, res, next) => {
  try {
    const settings = await settingsService.getPublicSettings();
    return success(res, settings);
  } catch (err) { next(err); }
};

// GET /api/admin/settings  (admin+)
const getAll = async (req, res, next) => {
  try {
    const settings = await settingsService.getSettings();
    return success(res, settings);
  } catch (err) { next(err); }
};

// PUT /api/admin/settings  (admin+)
const update = async (req, res, next) => {
  try {
    const settings = await settingsService.updateSettings(
      req.body,
      req.user.id,
      req.user.role
    );
    return success(res, settings, 'Settings updated');
  } catch (err) { next(err); }
};

module.exports = { getPublic, getAll, update };