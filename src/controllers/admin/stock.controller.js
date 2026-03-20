const stockService = require('../../services/stock.service');
const { success } = require('../../utils/apiResponse');

const getOverview = async (req, res, next) => {
  try {
    const rows = await stockService.getOverview(req.query);
    return success(res, rows);
  } catch (err) { next(err); }
};

const getLowStock = async (req, res, next) => {
  try {
    const rows = await stockService.getLowStock();
    return success(res, rows);
  } catch (err) { next(err); }
};

const getLogs = async (req, res, next) => {
  try {
    const { productId } = req.params;
    const result = await stockService.getLogs(productId, req.query, req.query);
    return success(res, result);
  } catch (err) { next(err); }
};

const addDelivery = async (req, res, next) => {
  try {
    const { productId, varietyName, packagingSize, quantity, reason, supplierId } = req.body;
    const result = await stockService.addDelivery(productId, varietyName, packagingSize, quantity, reason, supplierId, req.user.id);
    return success(res, result, 'Stock delivery recorded');
  } catch (err) { next(err); }
};

const manualAdjustment = async (req, res, next) => {
  try {
    const { productId, varietyName, packagingSize, newQuantity, reason } = req.body;
    const result = await stockService.manualAdjustment(productId, varietyName, packagingSize, newQuantity, reason, req.user.id);
    return success(res, result, 'Stock adjusted');
  } catch (err) { next(err); }
};

const batchUpdate = async (req, res, next) => {
  try {
    const result = await stockService.batchUpdate(req.body.updates, req.user.id);
    return success(res, result, `${result.length} stock entries updated`);
  } catch (err) { next(err); }
};

module.exports = { getOverview, getLowStock, getLogs, addDelivery, manualAdjustment, batchUpdate };
