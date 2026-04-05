const settingsService = require('../services/settings.service');
const { getDefaultBranchId } = require('../services/defaultBranch.service');

const checkMaintenanceMode = async (req, res, next) => {
  try {
    const branchId = req.branchId || req.body?.branchId || await getDefaultBranchId();
    if (!branchId) return next(); // no branch configured yet, skip check

    const settings = await settingsService.getSettings(branchId);

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
