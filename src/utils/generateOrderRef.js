const OrderCounter = require('../models/OrderCounter');
const { getBranchCode } = require('./branchCode');
const { currentYearEAT } = require('./businessTime');

// <BRANCH CODE>-<year>-<4-digit sequence>, e.g. NAI-2026-0153.
//
// The sequence is per branch and per Nairobi calendar year (counter document `counter_<branchId>_<year>`),
// so the branch code is what keeps references unique across branches - see utils/branchCode.js.
// References issued before branch codes existed look like ORD-2026-0152; they are left as they are and
// can never clash with a new one ('ORD' is not a valid branch code).
//
// The counter is incremented inside the caller's transaction, so a failed or aborted order gives its
// number back. It is also the one document every order on a branch writes, which is what lets
// createGuestOrder/createCustomerOrder run their duplicate-submission check race-free - call this
// BEFORE reading anything the duplicate check depends on.
// Counters already known to exist in this process, so the create-if-missing round trip below happens
// once per branch per year, not once per order.
const knownCounters = new Set();

// Create the counter document OUTSIDE the order's transaction. Two orders hitting a brand-new counter
// (the first order of a year, or of a new branch) inside their transactions both tried to insert it,
// and one of them failed on the insert conflict. Once it exists, the transactional $inc below is a
// plain update. A concurrent creator losing the race (E11000) is fine - the document is there.
const ensureCounter = async (counterId, branchId, year) => {
  if (knownCounters.has(counterId)) return;
  try {
    await OrderCounter.updateOne(
      { _id: counterId },
      { $setOnInsert: { branchId, year, seq: 0 } },
      { upsert: true }
    );
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
  knownCounters.add(counterId);
};

const generateOrderRef = async (branchId, session = null) => {
  if (!branchId) throw new Error('branchId is required to generate an order reference');

  const year = currentYearEAT();
  const code = await getBranchCode(branchId); // outside the session on purpose: a read-mostly lookup, cached after the first order
  const counterId = `counter_${branchId}_${year}`;
  await ensureCounter(counterId, branchId, year);

  const counter = await OrderCounter.findOneAndUpdate(
    { _id: counterId, year },
    { $inc: { seq: 1 }, $setOnInsert: { branchId } },
    { new: true, upsert: true, session }
  );

  const seq = String(counter.seq).padStart(4, '0');
  return `${code}-${year}-${seq}`;
};

module.exports = generateOrderRef;
