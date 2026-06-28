const { appEvents, PRICE_EVENTS } = require('../appEvents');
const customerAlertService = require('../../services/customerAlert.service');
const logger = require('../../utils/logger');

const register = () => {
  appEvents.on(PRICE_EVENTS.CHANGED, ({ productId, branchId, varietyName, packaging, oldPrice, newPrice }) => {
    if (newPrice >= oldPrice) return; // not a drop, skip

    customerAlertService.triggerPriceDrop({ productId, branchId, varietyName, packaging, oldPrice, newPrice })
      .catch(err => logger.error('[alert] price:changed price_drop trigger failed', { err: err.message }));
  });
};

module.exports = { register };
