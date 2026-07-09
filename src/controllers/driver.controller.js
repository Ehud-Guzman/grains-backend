const driverService = require('../services/driver.service');
const orderService = require('../services/order.service');
const { success, paginated } = require('../utils/apiResponse');
const { AppError } = require('../middleware/errorHandler.middleware');
const { ORDER_STATUSES } = require('../utils/constants');
const { withGuestFallback } = require('../utils/orderGuestFallback');

// GET /api/driver/me — profile + stats
const getMe = async (req, res, next) => {
  try {
    const User = require('../models/User');
    const driver = await User.findById(req.user.id)
      .select('-passwordHash -failedLoginCount -onboarding -orderHistory -addresses')
      .lean();
    if (!driver) return next(new AppError('Not found', 404, 'NOT_FOUND'));
    const stats = await driverService.getMyStats(req.user.id);
    return success(res, { ...driver, stats });
  } catch (err) { next(err); }
};

// PATCH /api/driver/availability — toggle available/unavailable
const setAvailability = async (req, res, next) => {
  try {
    const { available } = req.body;
    if (typeof available !== 'boolean') {
      return next(new AppError('available must be a boolean', 400, 'INVALID_INPUT'));
    }
    const result = await driverService.toggleAvailability(req.user.id, available);
    return success(res, result, available ? 'You are now available' : 'You are now unavailable');
  } catch (err) { next(err); }
};

// GET /api/driver/orders — orders assigned to this driver
const getMyOrders = async (req, res, next) => {
  try {
    const pagination = { page: req.query.page, limit: req.query.limit };
    const result = await driverService.getMyOrders(req.user.id, req.query, pagination, req.branchId);
    return paginated(res, result.orders, result.pagination);
  } catch (err) { next(err); }
};

// GET /api/driver/orders/:id — single order detail
const getOrderDetail = async (req, res, next) => {
  try {
    const Order = require('../models/Order');
    const order = await Order.findOne({ _id: req.params.id, driverId: req.user.id })
      .populate('userId', 'name phone')
      .populate('guestId', 'name phone')
      .lean();
    if (!order) return next(new AppError('Order not found or not assigned to you', 404, 'ORDER_NOT_FOUND'));
    return success(res, withGuestFallback(order));
  } catch (err) { next(err); }
};

// PATCH /api/driver/orders/:id/complete — driver marks delivery as done
const completeDelivery = async (req, res, next) => {
  try {
    const Order = require('../models/Order');
    const order = await Order.findOne({ _id: req.params.id, driverId: req.user.id });
    if (!order) return next(new AppError('Order not found or not assigned to you', 404, 'ORDER_NOT_FOUND'));

    if (order.status !== ORDER_STATUSES.OUT_FOR_DELIVERY) {
      return next(new AppError('Only out-for-delivery orders can be completed', 400, 'INVALID_STATUS'));
    }

    const updated = await orderService.updateStatus(
      req.params.id,
      ORDER_STATUSES.COMPLETED,
      req.user.id,
      'Marked as delivered by driver',
      order.branchId
    );
    return success(res, updated, 'Delivery completed');
  } catch (err) { next(err); }
};

module.exports = { getMe, setAvailability, getMyOrders, getOrderDetail, completeDelivery };
