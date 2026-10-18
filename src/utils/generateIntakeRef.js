const OrderCounter = require('../models/OrderCounter');
const { currentYearEAT } = require('./businessTime');

// Re-uses the existing OrderCounter model with an 'intake_' key prefix
// to generate sequential, per-branch, per-year intake refs: INT-YYYY-NNNN
// (the year follows the Nairobi calendar, not the server's). Intake refs only need to be unique
// within a branch - StockIntake has a { branchId, intakeRef } unique index - so no branch code here.
const generateIntakeRef = async (branchId) => {
  if (!branchId) throw new Error('branchId is required to generate an intake reference');

  const year = currentYearEAT();
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
