const OrderCounter = require('../models/OrderCounter');

// Re-uses the existing OrderCounter model with an 'intake_' key prefix
// to generate sequential, per-branch, per-year intake refs: INT-YYYY-NNNN
const generateIntakeRef = async (branchId) => {
  if (!branchId) throw new Error('branchId is required to generate an intake reference');

  const year = new Date().getFullYear();
  const counterId = `intake_${branchId}_${year}`;

  const counter = await OrderCounter.findOneAndUpdate(
    { _id: counterId, year },
    { $inc: { seq: 1 }, $setOnInsert: { branchId } },
    { new: true, upsert: true }
  );

  const seq = String(counter.seq).padStart(4, '0');
  return `INT-${year}-${seq}`;
};

module.exports = generateIntakeRef;
