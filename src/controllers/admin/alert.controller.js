const adminAlertService = require('../../services/adminAlert.service');
const { success } = require('../../utils/apiResponse');

const getDashboardAlerts = async (req, res, next) => {
  try {
    const data = await adminAlertService.getDashboardAlerts(req.branchId);
    return success(res, data);
  } catch (err) { next(err); }
};

module.exports = { getDashboardAlerts };
