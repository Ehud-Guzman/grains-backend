const settingsService = require('../services/settings.service');

const checkMaintenanceMode = async (req, res, next) => {
  try {
    const settings = await settingsService.getSettings();

    if (!settings.maintenanceMode) return next();

    return res.status(503).json({
      success: false,
      error: 'MAINTENANCE_MODE',
      message: settings.maintenanceMessage || 'We are currently undergoing maintenance. Please check back soon.'
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { checkMaintenanceMode };
