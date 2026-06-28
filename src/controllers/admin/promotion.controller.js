const promotionService = require('../../services/promotion.service');
const activityLogService = require('../../services/activityLog.service');
const { success } = require('../../utils/apiResponse');
const { LOG_ACTIONS } = require('../../utils/constants');

const getAll = async (req, res, next) => {
  try {
    const promos = await promotionService.getAll(req.branchId);
    return success(res, promos);
  } catch (err) { next(err); }
};

const getActive = async (req, res, next) => {
  try {
    const promos = await promotionService.getActive(req.branchId);
    return success(res, promos);
  } catch (err) { next(err); }
};

const getById = async (req, res, next) => {
  try {
    const promo = await promotionService.getById(req.params.id, req.branchId);
    return success(res, promo);
  } catch (err) { next(err); }
};

const create = async (req, res, next) => {
  try {
    const promo = await promotionService.create(req.body, req.branchId, req.user.id);
    await activityLogService.log({
      actorId: req.user.id, actorRole: req.user.role,
      action: LOG_ACTIONS.SETTINGS_UPDATED,
      branchId: req.branchId, targetId: promo._id, targetType: 'Promotion',
      detail: { title: promo.title, action: 'created' },
    });
    return success(res, promo, 'Promotion created', 201);
  } catch (err) { next(err); }
};

const update = async (req, res, next) => {
  try {
    const promo = await promotionService.update(req.params.id, req.body, req.branchId);
    await activityLogService.log({
      actorId: req.user.id, actorRole: req.user.role,
      action: LOG_ACTIONS.SETTINGS_UPDATED,
      branchId: req.branchId, targetId: promo._id, targetType: 'Promotion',
      detail: { title: promo.title, action: 'updated' },
    });
    return success(res, promo, 'Promotion updated');
  } catch (err) { next(err); }
};

const remove = async (req, res, next) => {
  try {
    await promotionService.remove(req.params.id, req.branchId);
    await activityLogService.log({
      actorId: req.user.id, actorRole: req.user.role,
      action: LOG_ACTIONS.SETTINGS_UPDATED,
      branchId: req.branchId, targetId: req.params.id, targetType: 'Promotion',
      detail: { action: 'deleted' },
    });
    return success(res, null, 'Promotion deleted');
  } catch (err) { next(err); }
};

module.exports = { getAll, getActive, getById, create, update, remove };
