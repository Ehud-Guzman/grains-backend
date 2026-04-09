const driverService = require('../../services/driver.service');
const { success, paginated } = require('../../utils/apiResponse');

const getAll = async (req, res, next) => {
  try {
    const result = await driverService.getAllDrivers(req.query, req.query, req.branchId);
    return paginated(res, result.drivers, result.pagination);
  } catch (err) { next(err); }
};

const getById = async (req, res, next) => {
  try {
    const driver = await driverService.getDriverById(req.params.id, req.branchId);
    return success(res, driver);
  } catch (err) { next(err); }
};

const create = async (req, res, next) => {
  try {
    const { name, phone, email, password, vehicleType, vehiclePlate } = req.body;
    const driver = await driverService.createDriver(
      { name, phone, email, password, vehicleType, vehiclePlate },
      req.user.id,
      req.branchId
    );
    return success(res, driver, 'Driver account created', 201);
  } catch (err) { next(err); }
};

const getOrders = async (req, res, next) => {
  try {
    const result = await driverService.getDriverOrders(req.params.id, req.query, req.query, req.branchId);
    return paginated(res, result.orders, result.pagination);
  } catch (err) { next(err); }
};

const getStats = async (req, res, next) => {
  try {
    const stats = await driverService.getDriverStats(req.params.id, req.branchId);
    return success(res, stats);
  } catch (err) { next(err); }
};

const lockAccount = async (req, res, next) => {
  try {
    const result = await driverService.lockDriver(req.params.id, req.user.id, req.branchId);
    return success(res, result, 'Driver account locked');
  } catch (err) { next(err); }
};

const unlockAccount = async (req, res, next) => {
  try {
    const result = await driverService.unlockDriver(req.params.id, req.user.id, req.branchId);
    return success(res, result, 'Driver account unlocked');
  } catch (err) { next(err); }
};

const resetPassword = async (req, res, next) => {
  try {
    const result = await driverService.resetDriverPassword(req.params.id, req.body.password, req.user.id, req.branchId);
    return success(res, result, 'Password reset successfully');
  } catch (err) { next(err); }
};

const updateVehicle = async (req, res, next) => {
  try {
    const result = await driverService.updateVehicleInfo(req.params.id, req.body, req.branchId);
    return success(res, result, 'Vehicle info updated');
  } catch (err) { next(err); }
};

module.exports = { getAll, getById, create, getOrders, getStats, lockAccount, unlockAccount, resetPassword, updateVehicle };
