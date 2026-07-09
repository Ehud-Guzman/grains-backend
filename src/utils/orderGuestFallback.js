// cleanup.job.js purges Guest documents on a retention timer, but the Order
// itself (a financial/KRA-relevant record) must stay identifiable afterward —
// falls back to the order's own guestName/guestPhone snapshot whenever a
// populated guestId comes back null because the referenced Guest is gone.
const withGuestFallback = (order) => {
  if (order && !order.guestId && order.guestName) {
    order.guestId = { name: order.guestName, phone: order.guestPhone };
  }
  return order;
};

const withGuestFallbackList = (orders) => orders.map(withGuestFallback);

module.exports = { withGuestFallback, withGuestFallbackList };
