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

module.exports = {
  getDefaultBranch,
  getDefaultBranchId,
  invalidateDefaultBranchCache,
};
