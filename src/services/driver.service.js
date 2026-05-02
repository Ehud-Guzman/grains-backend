const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Order = require('../models/Order');
const { AppError } = require('../middleware/errorHandler.middleware');
const activityLogService = require('./activityLog.service');
const { ROLES, LOG_ACTIONS, ORDER_STATUSES } = require('../utils/constants');
const { paginate, buildPaginationMeta } = require('../utils/paginate');

const BCRYPT_WORK_FACTOR = 12;

// ── LIST DRIVERS (branch-scoped) ──────────────────────────────────────────────
const getAllDrivers = async (filters = {}, query = {}, branchId) => {
  const { page, limit, skip } = paginate(query);

  const match = { role: ROLES.DRIVER, branchId };

  if (filters.search) {
    const re = { $regex: filters.search, $options: 'i' };
    match.$or = [{ name: re }, { phone: re }];
  }
  if (typeof filters.available !== 'undefined') {
    match.isAvailableForDelivery = filters.available === 'true';
  }

  const [total, drivers] = await Promise.all([
    User.countDocuments(match),
    User.find(match)
      .select('-passwordHash -failedLoginCount -onboarding -orderHistory -addresses')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
  ]);

  return { drivers, pagination: buildPaginationMeta(page, limit, total) };
};

// ── GET SINGLE DRIVER ─────────────────────────────────────────────────────────
const getDriverById = async (driverId, branchId) => {
  const driver = await User.findOne({ _id: driverId, role: ROLES.DRIVER, branchId })
    .select('-passwordHash -failedLoginCount -onboarding -orderHistory -addresses')
    .lean();
  if (!driver) throw new AppError('Driver not found', 404, 'DRIVER_NOT_FOUND');
  return driver;
};

// ── CREATE DRIVER ACCOUNT ─────────────────────────────────────────────────────
const createDriver = async ({ name, phone, email, password, vehicleType, vehiclePlate }, adminId, branchId, actorRole = ROLES.ADMIN) => {
  const existing = await User.findOne({ phone });
  if (existing) throw new AppError('An account with this phone number already exists', 409, 'PHONE_TAKEN');

  if (email) {
    const emailTaken = await User.findOne({ email });
    if (emailTaken) throw new AppError('An account with this email already exists', 409, 'EMAIL_TAKEN');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_WORK_FACTOR);

  const driver = await User.create({
    name,
    phone,
    email: email || null,
    passwordHash,
    role: ROLES.DRIVER,
    branchId,
    isAvailableForDelivery: true,
    vehicleInfo: {
      type: vehicleType || null,
      plate: vehiclePlate || null
    }
  });

  await activityLogService.log({
    actorId: adminId,
    actorRole,
    action: LOG_ACTIONS.DRIVER_CREATED,
    branchId,
    targetId: driver._id,
    targetType: 'User',
    detail: { name, phone, vehicleType, vehiclePlate }
  });

  return {
    id: driver._id,
    name: driver.name,
    phone: driver.phone,
    email: driver.email,
    role: driver.role,
    vehicleInfo: driver.vehicleInfo,
    isAvailableForDelivery: driver.isAvailableForDelivery,
    branchId: driver.branchId,
    createdAt: driver.createdAt
  };
};

// ── GET DRIVER'S ORDERS ───────────────────────────────────────────────────────
const getDriverOrders = async (driverId, filters = {}, query = {}, branchId) => {
  const { page, limit, skip } = paginate(query);

  // Confirm driver exists in this branch
  const driver = await User.findOne({ _id: driverId, role: ROLES.DRIVER, branchId }).lean();
  if (!driver) throw new AppError('Driver not found', 404, 'DRIVER_NOT_FOUND');

  const match = { driverId, branchId };
  if (filters.status) match.status = filters.status;

  const [total, orders] = await Promise.all([
    Order.countDocuments(match),
    Order.find(match)
      .select('orderRef status deliveryMethod deliveryAddress total createdAt userId guestId deliveryFee')
      .populate('userId', 'name phone')
      .populate('guestId', 'name phone')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
  ]);

  return { orders, pagination: buildPaginationMeta(page, limit, total) };
};

// ── DRIVER STATS (for admin driver profile) ───────────────────────────────────
const getDriverStats = async (driverId, branchId) => {
  const driver = await User.findOne({ _id: driverId, role: ROLES.DRIVER, branchId }).lean();
  if (!driver) throw new AppError('Driver not found', 404, 'DRIVER_NOT_FOUND');

  const [total, completed, active] = await Promise.all([
    Order.countDocuments({ driverId, branchId }),
    Order.countDocuments({ driverId, branchId, status: ORDER_STATUSES.COMPLETED }),
    Order.countDocuments({ driverId, branchId, status: ORDER_STATUSES.OUT_FOR_DELIVERY })
  ]);

  return { total, completed, active, pending: total - completed - active };
};

// ── LOCK / UNLOCK ─────────────────────────────────────────────────────────────
const lockDriver = async (driverId, adminId, branchId, actorRole = ROLES.ADMIN) => {
  const driver = await User.findOne({ _id: driverId, role: ROLES.DRIVER, branchId });
  if (!driver) throw new AppError('Driver not found', 404, 'DRIVER_NOT_FOUND');

  driver.isLocked = true;
  await driver.save();

  await activityLogService.log({
    actorId: adminId, actorRole,
    action: LOG_ACTIONS.DRIVER_ACCOUNT_LOCKED,
    branchId, targetId: driverId, targetType: 'User',
    detail: { name: driver.name }
  });

  return { id: driver._id, name: driver.name, isLocked: true };
};

const unlockDriver = async (driverId, adminId, branchId, actorRole = ROLES.ADMIN) => {
  const driver = await User.findOneAndUpdate(
    { _id: driverId, role: ROLES.DRIVER, branchId },
    { isLocked: false, failedLoginCount: 0 },
    { new: true }
  );
  if (!driver) throw new AppError('Driver not found', 404, 'DRIVER_NOT_FOUND');

  await activityLogService.log({
    actorId: adminId, actorRole,
    action: LOG_ACTIONS.DRIVER_ACCOUNT_UNLOCKED,
    branchId, targetId: driverId, targetType: 'User',
    detail: { name: driver.name }
  });

  return { id: driver._id, name: driver.name, isLocked: false };
};

// ── RESET PASSWORD ────────────────────────────────────────────────────────────
const resetDriverPassword = async (driverId, newPassword, adminId, branchId, actorRole = ROLES.ADMIN) => {
  if (!newPassword || newPassword.length < 8) {
    throw new AppError('Password must be at least 8 characters', 400, 'INVALID_PASSWORD');
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_WORK_FACTOR);
  const driver = await User.findOneAndUpdate(
    { _id: driverId, role: ROLES.DRIVER, branchId },
    { passwordHash, failedLoginCount: 0, isLocked: false },
    { new: true }
  );
  if (!driver) throw new AppError('Driver not found', 404, 'DRIVER_NOT_FOUND');

  await activityLogService.log({
    actorId: adminId, actorRole,
    action: LOG_ACTIONS.DRIVER_PASSWORD_RESET,
    branchId, targetId: driverId, targetType: 'User',
    detail: { name: driver.name }
  });

  return { id: driver._id, name: driver.name };
};

// ── UPDATE VEHICLE INFO ───────────────────────────────────────────────────────
const updateVehicleInfo = async (driverId, { vehicleType, vehiclePlate }, branchId) => {
  const driver = await User.findOneAndUpdate(
    { _id: driverId, role: ROLES.DRIVER, branchId },
    { vehicleInfo: { type: vehicleType || null, plate: vehiclePlate || null } },
    { new: true }
  ).select('-passwordHash -failedLoginCount');

  if (!driver) throw new AppError('Driver not found', 404, 'DRIVER_NOT_FOUND');
  return driver;
};

// ── TOGGLE AVAILABILITY (driver updates their own status) ─────────────────────
const toggleAvailability = async (driverId, available) => {
  const driver = await User.findByIdAndUpdate(
    driverId,
    { isAvailableForDelivery: available },
    { new: true }
  ).select('name isAvailableForDelivery');

  if (!driver) throw new AppError('Driver not found', 404, 'DRIVER_NOT_FOUND');
  return driver;
};

// ── DRIVER'S OWN ORDERS (for driver portal) ───────────────────────────────────
const getMyOrders = async (driverId, filters = {}, query = {}) => {
  const { page, limit, skip } = paginate(query);

  const match = { driverId };
  if (filters.status) {
    match.status = filters.status;
  } else {
    // Default: active orders only (not completed/cancelled/rejected)
    match.status = { $in: [ORDER_STATUSES.OUT_FOR_DELIVERY, ORDER_STATUSES.PREPARING] };
  }

  const [total, orders] = await Promise.all([
    Order.countDocuments(match),
    Order.find(match)
      .select('orderRef status deliveryMethod deliveryAddress total deliveryFee createdAt orderItems userId guestId specialInstructions')
      .populate('userId', 'name phone')
      .populate('guestId', 'name phone')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
  ]);

  return { orders, pagination: buildPaginationMeta(page, limit, total) };
};

// ── DRIVER DASHBOARD STATS (own) ──────────────────────────────────────────────
const getMyStats = async (driverId) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [active, completedToday, totalCompleted] = await Promise.all([
    Order.countDocuments({ driverId, status: ORDER_STATUSES.OUT_FOR_DELIVERY }),
    Order.countDocuments({ driverId, status: ORDER_STATUSES.COMPLETED, updatedAt: { $gte: today } }),
    Order.countDocuments({ driverId, status: ORDER_STATUSES.COMPLETED })
  ]);

  return { active, completedToday, totalCompleted };
};

module.exports = {
  getAllDrivers,
  getDriverById,
  createDriver,
  getDriverOrders,
  getDriverStats,
  lockDriver,
  unlockDriver,
  resetDriverPassword,
  updateVehicleInfo,
  toggleAvailability,
  getMyOrders,
  getMyStats
};
