const { appEvents, ORDER_EVENTS } = require('../appEvents');
const notificationService = require('../../services/notification.service');
const adminAlertService = require('../../services/adminAlert.service');
const logger = require('../../utils/logger');

const register = () => {
  appEvents.on(ORDER_EVENTS.PLACED, ({ order, branchId }) => {
    notificationService.dispatchOrderPlaced(order, branchId)
      .catch(err => logger.error('[notification] order:placed failed', { err: err.message }));
    adminAlertService.notifyNewOrder(order, branchId)
      .catch(err => logger.error('[adminAlert] order:placed failed', { err: err.message }));
  });

  appEvents.on(ORDER_EVENTS.APPROVED, ({ order, branchId }) => {
    notificationService.dispatchOrderApproved(order, branchId)
      .catch(err => logger.error('[notification] order:approved failed', { err: err.message }));
  });

  appEvents.on(ORDER_EVENTS.REJECTED, ({ order, branchId }) => {
    notificationService.dispatchOrderRejected(order, branchId)
      .catch(err => logger.error('[notification] order:rejected failed', { err: err.message }));
  });

  appEvents.on(ORDER_EVENTS.DISPATCHED, ({ order, branchId }) => {
    notificationService.dispatchOrderDispatched(order, branchId)
      .catch(err => logger.error('[notification] order:dispatched failed', { err: err.message }));
  });

  // ORDER_EVENTS.COMPLETED and ORDER_EVENTS.CANCELLED have no listeners yet.
  // Phase 2 alert + churn jobs will attach here.
};

module.exports = { register };
