const EventEmitter = require('events');

const appEvents = new EventEmitter();
appEvents.setMaxListeners(30); // room for Phase 2+ listeners

const ORDER_EVENTS = {
  PLACED:     'order:placed',     // { order, branchId }
  APPROVED:   'order:approved',   // { order, branchId }
  REJECTED:   'order:rejected',   // { order, branchId }
  DISPATCHED: 'order:dispatched', // { order, branchId }
  COMPLETED:  'order:completed',  // { order, branchId }
  CANCELLED:  'order:cancelled',  // { order, branchId }
};

const STOCK_EVENTS = {
  UPDATED: 'stock:updated', // { productId, branchId, varietyName, packaging, newStock }
};

const PRICE_EVENTS = {
  CHANGED: 'price:changed', // { productId, branchId, varietyName, packaging, oldPrice, newPrice, changedBy }
};

module.exports = { appEvents, ORDER_EVENTS, STOCK_EVENTS, PRICE_EVENTS };
