const branchService = require('../services/branch.service');
const driverService = require('../services/driver.service');
const { success } = require('../utils/apiResponse');
const { AppError } = require('../middleware/errorHandler.middleware');

// GET /api/branches — public list of active branches (storefront picker)
const getPublicBranches = async (req, res, next) => {
  try {
    const branches = await branchService.getPublicBranches();
    return success(res, branches);
  } catch (err) { next(err); }
};

// GET /api/branches/nearest?lat=X&lng=Y — resolve the branch that serves the
// customer's location (location-driven fulfilment)
const getNearestBranch = async (req, res, next) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);

    // Reject missing/garbage/out-of-range coordinates outright
    if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
        lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new AppError('Valid lat and lng query parameters are required', 400, 'INVALID_COORDS');
    }

    const result = await branchService.findNearestBranch(lat, lng);
    return success(res, result);
  } catch (err) { next(err); }
};

// GET /api/branches/:branchId/riders — available riders for checkout selection
const getAvailableRiders = async (req, res, next) => {
  try {
    const riders = await driverService.getAvailablePublic(req.params.branchId);
    return success(res, riders);
  } catch (err) { next(err); }
};

module.exports = { getPublicBranches, getNearestBranch, getAvailableRiders };
