const OrderCounter = require('../models/OrderCounter');

const generateOrderRef = async (branchId, session = null) => {
  if (!branchId) throw new Error('branchId is required to generate an order reference');

  const year = new Date().getFullYear();
  const counterId = `counter_${branchId}_${year}`;

  const counter = await OrderCounter.findOneAndUpdate(
    { _id: counterId, year },
    { $inc: { seq: 1 }, $setOnInsert: { branchId } },
    { new: true, upsert: true, session }
  );

  const seq = String(counter.seq).padStart(4, '0');
  return `ORD-${year}-${seq}`;
};

module.exports = generateOrderRef;
