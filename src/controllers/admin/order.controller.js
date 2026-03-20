const orderService = require('../../services/order.service');
const { success, paginated } = require('../../utils/apiResponse');

const getAll = async (req, res, next) => {
  try {
    const { page, limit, status, paymentMethod, deliveryMethod, from, to, search } = req.query;
    const result = await orderService.getAll(
      { status, paymentMethod, deliveryMethod, from, to, search },
      { page, limit }
    );
    return paginated(res, result.orders, result.pagination);
  } catch (err) { next(err); }
};

const getById = async (req, res, next) => {
  try {
    const order = await orderService.getById(req.params.id);
    return success(res, order);
  } catch (err) { next(err); }
};

const approve = async (req, res, next) => {
  try {
    const order = await orderService.approve(req.params.id, req.user.id);
    return success(res, order, 'Order approved and stock deducted');
  } catch (err) { next(err); }
};

const reject = async (req, res, next) => {
  try {
    const order = await orderService.reject(req.params.id, req.user.id, req.body.reason);
    return success(res, order, 'Order rejected');
  } catch (err) { next(err); }
};

const updateStatus = async (req, res, next) => {
  try {
    const order = await orderService.updateStatus(req.params.id, req.body.status, req.user.id, req.body.note);
    return success(res, order, `Order status updated to ${req.body.status}`);
  } catch (err) { next(err); }
};

const bulkApprove = async (req, res, next) => {
  try {
    const result = await orderService.bulkApprove(req.body.orderIds, req.user.id);
    return success(res, result, `Approved: ${result.approved.length}, Failed: ${result.failed.length}`);
  } catch (err) { next(err); }
};

const bulkReject = async (req, res, next) => {
  try {
    const result = await orderService.bulkReject(req.body.orderIds, req.user.id, req.body.reason);
    return success(res, result, `Rejected: ${result.rejected.length}, Failed: ${result.failed.length}`);
  } catch (err) { next(err); }
};

const getPackingSlip = async (req, res, next) => {
  try {
    const slip = await orderService.getPackingSlip(req.params.id);
    return success(res, slip);
  } catch (err) { next(err); }
};

module.exports = { getAll, getById, approve, reject, updateStatus, bulkApprove, bulkReject, getPackingSlip };
