const activityLogService = require('../../services/activityLog.service');
const { success } = require('../../utils/apiResponse');

const getLogs = async (req, res, next) => {
  try {
    const { page, limit, actorId, action, targetType, from, to, branchId } = req.query;
    // Superadmin can pass ?branchId=xxx to scope to a single branch,
    // otherwise req.branchId (null for global superadmin = all logs)
    const scopedBranchId = branchId || req.branchId || null;
    const result = await activityLogService.getLogs(
      { actorId, action, targetType, from, to },
      { page: Number(page) || 1, limit: Number(limit) || 20 },
      scopedBranchId
    );
    return success(res, result);
  } catch (err) { next(err); }
};

module.exports = { getLogs };
