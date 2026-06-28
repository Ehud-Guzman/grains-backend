const { appEvents, STOCK_EVENTS } = require('../appEvents');
const customerAlertService = require('../../services/customerAlert.service');
const logger = require('../../utils/logger');

const register = () => {
  appEvents.on(STOCK_EVENTS.UPDATED, ({ productId, branchId, varietyName, packaging, newStock }) => {
    if (!newStock || newStock <= 0) return;

    customerAlertService.triggerBackInStock({ productId, branchId, varietyName, packaging })
      .catch(err => logger.error('[alert] stock:updated back_in_stock trigger failed', { err: err.message }));
  });
};

module.exports = { register };
