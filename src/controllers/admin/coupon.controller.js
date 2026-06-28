const couponService = require('../../services/coupon.service');
const activityLogService = require('../../services/activityLog.service');
const { success } = require('../../utils/apiResponse');
const { LOG_ACTIONS } = require('../../utils/constants');

const getAll = async (req, res, next) => {
  try {
    const coupons = await couponService.getAll(req.branchId);
    return success(res, coupons);
  } catch (err) { next(err); }
};

const getById = async (req, res, next) => {
  try {
    const coupon = await couponService.getById(req.params.id, req.branchId);
    return success(res, coupon);
  } catch (err) { next(err); }
};

const create = async (req, res, next) => {
  try {
    const coupon = await couponService.create(req.body, req.branchId, req.user.id);
    await activityLogService.log({
      actorId: req.user.id, actorRole: req.user.role,
      action: LOG_ACTIONS.SETTINGS_UPDATED,
      branchId: req.branchId, targetId: coupon._id, targetType: 'Coupon',
      detail: { code: coupon.code, action: 'created' },
    });
    return success(res, coupon, 'Coupon created', 201);
  } catch (err) { next(err); }
};

const update = async (req, res, next) => {
  try {
    const coupon = await couponService.update(req.params.id, req.body, req.branchId);
    await activityLogService.log({
      actorId: req.user.id, actorRole: req.user.role,
      action: LOG_ACTIONS.SETTINGS_UPDATED,
      branchId: req.branchId, targetId: coupon._id, targetType: 'Coupon',
      detail: { code: coupon.code, action: 'updated' },
    });
    return success(res, coupon, 'Coupon updated');
  } catch (err) { next(err); }
};

const remove = async (req, res, next) => {
  try {
    await couponService.remove(req.params.id, req.branchId);
    await activityLogService.log({
      actorId: req.user.id, actorRole: req.user.role,
      action: LOG_ACTIONS.SETTINGS_UPDATED,
      branchId: req.branchId, targetId: req.params.id, targetType: 'Coupon',
      detail: { action: 'deleted' },
    });
    return success(res, null, 'Coupon deleted');
  } catch (err) { next(err); }
};

// Public-facing validate (called at checkout to preview discount)
const validatePublic = async (req, res, next) => {
  try {
    const { code, subtotal } = req.body;
    const userId = req.user?.id || null;
    const branchId = req.branchId || (await require('../../services/defaultBranch.service').getDefaultBranch())?._id;
    const { coupon, discountAmount } = await couponService.validate(code, branchId, userId, Number(subtotal));
    return success(res, {
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      discountAmount,
    }, 'Coupon applied');
  } catch (err) { next(err); }
};

module.exports = { getAll, getById, create, update, remove, validatePublic };
