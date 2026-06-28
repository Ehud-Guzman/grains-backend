const customerAlertService = require('../services/customerAlert.service');
const Product = require('../models/Product');
const { success } = require('../utils/apiResponse');
const { AppError } = require('../middleware/errorHandler.middleware');

const subscribe = async (req, res, next) => {
  try {
    const { type, productId, productName, varietyName, packaging, priceAtSubscription } = req.body;
    if (!type || !productId || !varietyName || !packaging) {
      throw new AppError('type, productId, varietyName, and packaging are required', 400, 'VALIDATION_ERROR');
    }

    // Customers have branchId=null in JWT — resolve it from the product itself
    let branchId = req.branchId;
    if (!branchId) {
      const product = await Product.findById(productId).select('branchId').lean();
      if (!product) throw new AppError('Product not found', 404, 'NOT_FOUND');
      branchId = product.branchId;
    }

    const alert = await customerAlertService.subscribe({
      userId: req.user.id,
      branchId,
      type, productId, productName, varietyName, packaging, priceAtSubscription,
    });
    return success(res, alert, 201);
  } catch (err) { next(err); }
};

const getMyAlerts = async (req, res, next) => {
  try {
    const alerts = await customerAlertService.getMyAlerts(req.user.id);
    return success(res, alerts);
  } catch (err) { next(err); }
};

const unsubscribe = async (req, res, next) => {
  try {
    const alert = await customerAlertService.unsubscribe(req.params.id, req.user.id);
    if (!alert) throw new AppError('Alert not found', 404, 'NOT_FOUND');
    return success(res, { cancelled: true });
  } catch (err) { next(err); }
};

module.exports = { subscribe, getMyAlerts, unsubscribe };
