const broadcastService = require('../../services/broadcast.service');
const { success } = require('../../utils/apiResponse');

const getAudienceCount = async (req, res, next) => {
  try {
    const count = await broadcastService.getAudienceCount(req.query.audience || 'all');
    return success(res, { count });
  } catch (err) { next(err); }
};

const send = async (req, res, next) => {
  try {
    const { message, audience } = req.body;
    const result = await broadcastService.sendBroadcast({ message, audience }, req.user.id, req.user.role);
    return success(res, result, 'Broadcast sent');
  } catch (err) { next(err); }
};

module.exports = { getAudienceCount, send };
