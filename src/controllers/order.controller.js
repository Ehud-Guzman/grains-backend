const orderService = require('../services/order.service');
const { getDefaultBranchId } = require('../services/defaultBranch.service');
const { success } = require('../utils/apiResponse');

// POST /api/orders/guest
const createGuestOrder = async (req, res, next) => {
  try {
    // Use branchId from request body (frontend passes it), or fall back to default branch
    const branchId = req.body.branchId || await getDefaultBranchId();
    const order = await orderService.createGuestOrder(req.body, branchId);
    return success(res, { orderRef: order.orderRef, orderId: order._id, total: order.total }, 'Order placed successfully', 201);
  } catch (err) { next(err); }
};

// GET /api/orders/track?phone=&ref=
const trackOrder = async (req, res, next) => {
  try {
    const { phone, ref } = req.query;
    if (!phone || !ref) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAMS', message: 'phone and ref are required' });
    }
    const order = await orderService.trackByRef(phone, ref);
    return success(res, order);
  } catch (err) { next(err); }
};

// POST /api/orders - customer auth required
const createCustomerOrder = async (req, res, next) => {
  try {
    const branchId = req.body.branchId || req.branchId || await getDefaultBranchId();
    const order = await orderService.createCustomerOrder(req.body, req.user.id, branchId);
    return success(res, { orderRef: order.orderRef, orderId: order._id, total: order.total }, 'Order placed successfully', 201);
  } catch (err) { next(err); }
};

// GET /api/orders/my - customer auth required
const getMyOrders = async (req, res, next) => {
  try {
    const result = await orderService.getMyOrders(req.user.id, req.query, req.branchId);
    return success(res, result);
  } catch (err) { next(err); }
};

// PATCH /api/orders/:id/cancel - customer auth required
const cancelOrder = async (req, res, next) => {
  try {
    const order = await orderService.cancel(req.params.id, req.user.id, req.branchId);
    return success(res, order, 'Order cancelled');
  } catch (err) { next(err); }
};

module.exports = { createGuestOrder, trackOrder, createCustomerOrder, getMyOrders, cancelOrder };
