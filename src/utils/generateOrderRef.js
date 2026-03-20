const OrderCounter = require('../models/OrderCounter');

const generateOrderRef = async () => {
  const year = new Date().getFullYear();

  // Atomically increment the counter for this year
  const counter = await OrderCounter.findOneAndUpdate(
    { _id: 'order_counter', year },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  // If the year changed, reset seq to 1
  if (!counter) {
    await OrderCounter.create({ _id: 'order_counter', year, seq: 1 });
    return `ORD-${year}-0001`;
  }

  const seq = String(counter.seq).padStart(4, '0');
  return `ORD-${year}-${seq}`;
};

module.exports = generateOrderRef;
