const mongoose = require('mongoose');
const Branch = require('../models/Branch');

const CACHE_TTL = 60 * 1000;

let cachedBranch = null;
let cachedAt = 0;
let pendingBranchPromise = null;

const fetchDefaultBranch = async () => {
  const branch = await Branch.findOne({ isDefault: true, isActive: true }).lean()
    || await Branch.findOne({ isActive: true }).lean();

  cachedBranch = branch || null;
  cachedAt = Date.now();
  return cachedBranch;
};

const getDefaultBranch = async () => {
  if (cachedBranch && Date.now() - cachedAt < CACHE_TTL) {
    return cachedBranch;
  }

  if (!pendingBranchPromise) {
    pendingBranchPromise = fetchDefaultBranch()
      .finally(() => {
        pendingBranchPromise = null;
      });
  }

  return pendingBranchPromise;
};

const getDefaultBranchId = async () => {
  const branch = await getDefaultBranch();
  return branch?._id || null;
};

const invalidateDefaultBranchCache = () => {
  cachedBranch = null;
  cachedAt = 0;
  pendingBranchPromise = null;
};

// Resolve the branch for a public storefront request: an explicitly requested
// ?branchId (must be a valid, active branch) wins; otherwise the default
// branch. An invalid/inactive branchId silently falls back to default rather
// than erroring — public storefront endpoints must always render.
const resolvePublicBranch = async (requestedBranchId) => {
  if (requestedBranchId && mongoose.Types.ObjectId.isValid(requestedBranchId)) {
    const branch = await Branch.findOne({ _id: requestedBranchId, isActive: true })
      .select('name slug location isDefault').lean();
    if (branch) return branch;
  }
  return getDefaultBranch();
};

module.exports = {
  getDefaultBranch,
  getDefaultBranchId,
  invalidateDefaultBranchCache,
  resolvePublicBranch,
};
