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

  // A reassignment used to be silent: order.driverId was simply overwritten and,
  // because the DISPATCHED event is deliberately suppressed on reassignment (to
  // avoid re-sending the customer's "on the way" SMS), nothing at all was
  // emitted. The previous driver's own order list is filtered by driverId, so on
  // their next refresh the order vanished with no explanation — potentially
  // while they were already driving to the address. This tells them directly.
  appEvents.on(ORDER_EVENTS.REASSIGNED, ({ previousDriver, order, branchId }) => {
    if (!previousDriver?.phone) return;
    const ref = order?.orderRef || 'your order';
    notificationService
      .sendSMS(
        previousDriver.phone,
        `Hi ${previousDriver.name}, order ${ref} has been reassigned to another rider. ` +
        `You no longer need to deliver it. Sorry for the confusion.`
      )
      .catch(err => logger.error('[notification] order:reassigned SMS failed', { err: err.message }));
  });

  // ORDER_EVENTS.COMPLETED and ORDER_EVENTS.CANCELLED have no listeners yet.
  // Phase 2 alert + churn jobs will attach here.
};

module.exports = { register };
