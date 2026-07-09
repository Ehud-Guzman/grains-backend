const stockService = require('../../services/stock.service');
const { success } = require('../../utils/apiResponse');

const getOverview = async (req, res, next) => {
  try {
    const rows = await stockService.getOverview(req.query, req.branchId);
    return success(res, rows);
  } catch (err) { next(err); }
};

const getLowStock = async (req, res, next) => {
  try {
    const rows = await stockService.getLowStock(req.branchId);
    return success(res, rows);
  } catch (err) { next(err); }
};

const getLogs = async (req, res, next) => {
  try {
    const { productId } = req.params;
    const pagination = { page: req.query.page, limit: req.query.limit };
    const result = await stockService.getLogs(productId, req.query, pagination, req.branchId);
    return success(res, result);
  } catch (err) { next(err); }
};

const addDelivery = async (req, res, next) => {
  try {
    const { productId, varietyName, packagingSize, quantity, reason, supplierId, sourceIntakeId } = req.body;
    const result = await stockService.addDelivery(productId, varietyName, packagingSize, quantity, reason, supplierId, req.user.id, req.branchId, req.user.role, sourceIntakeId || null);
    return success(res, result, 'Stock delivery recorded');
  } catch (err) { next(err); }
};

const manualAdjustment = async (req, res, next) => {
  try {
    const { productId, varietyName, packagingSize, newQuantity, reason } = req.body;
    const result = await stockService.manualAdjustment(productId, varietyName, packagingSize, newQuantity, reason, req.user.id, req.branchId, req.user.role);
    return success(res, result, 'Stock adjusted');
  } catch (err) { next(err); }
};

const batchUpdate = async (req, res, next) => {
  try {
    const result = await stockService.batchUpdate(req.body.updates, req.user.id, req.branchId);
    const message = result.failed.length > 0
      ? `${result.succeeded.length} entries updated, ${result.failed.length} failed`
      : `${result.succeeded.length} stock entries updated`;
    return success(res, result, message);
  } catch (err) { next(err); }
};

module.exports = { getOverview, getLowStock, getLogs, addDelivery, manualAdjustment, batchUpdate };
