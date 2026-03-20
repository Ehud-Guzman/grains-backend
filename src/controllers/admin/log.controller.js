const activityLogService = require('../../services/activityLog.service');
const { success } = require('../../utils/apiResponse');

const getLogs = async (req, res, next) => {
  try {
    const { page, limit, actorId, action, targetType, from, to } = req.query;
    const result = await activityLogService.getLogs(
      { actorId, action, targetType, from, to },
      { page: Number(page) || 1, limit: Number(limit) || 20 }
    );
    return success(res, result);
  } catch (err) { next(err); }
};

module.exports = { getLogs };
