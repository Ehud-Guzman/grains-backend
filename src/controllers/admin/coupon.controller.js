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

const getPerformance = async (req, res, next) => {
  try {
    const coupons = await couponService.getPerformance(req.branchId);
    return success(res, coupons);
  } catch (err) { next(err); }
};

const getById = async (req, res, next) => {
  try {
    const coupon = await couponService.getById(req.params.id, req.branchId);
    return success(res, coupon);
  } catch (err) { next(err); }
};

const getRedemptions = async (req, res, next) => {
  try {
    const result = await couponService.getRedemptions(req.params.id, req.branchId, req.query);
    return success(res, result);
  } catch (err) { next(err); }
};

const create = async (req, res, next) => {
  try {
    const coupon = await couponService.create(req.body, req.branchId, req.user.id);
    await activityLogService.log({
      actorId: req.user.id, actorRole: req.user.role,
      action: LOG_ACTIONS.COUPON_CREATED,
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
      action: LOG_ACTIONS.COUPON_UPDATED,
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
      action: LOG_ACTIONS.COUPON_DELETED,
      branchId: req.branchId, targetId: req.params.id, targetType: 'Coupon',
      detail: { action: 'deleted' },
    });
    return success(res, null, 'Coupon deleted');
  } catch (err) { next(err); }
};

const { AppError } = require('../../middleware/errorHandler.middleware');
const UNIFORM_COUPON_ERRORS = ['COUPON_INVALID', 'COUPON_EXPIRED', 'COUPON_EXHAUSTED', 'COUPON_NOT_YOURS'];

// Public-facing validate (called at checkout to preview discount)
const validatePublic = async (req, res, next) => {
  try {
    const { code, subtotal } = req.body;
    const userId = req.user?.id || null;
    // Storefront guests/customers carry no JWT branchId (customer accounts are
    // shared across branches) — the resolved shop branch travels in the body,
    // same as order creation. req.branchId only applies to staff/driver JWTs.
    const branchId = req.body.branchId || req.branchId || (await require('../../services/defaultBranch.service').getDefaultBranch())?._id;
    const { coupon, discountAmount } = await couponService.validate(code, branchId, userId, Number(subtotal), req.body.phone || null);
    return success(res, {
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      discountAmount,
    }, 'Coupon applied');
  } catch (err) {
    // A dead code (unknown, inactive, expired, used up, or someone else's) must all look the same to an
    // anonymous caller, otherwise the endpoint tells a guesser which codes exist. Answers that need a code
    // that IS valid for this person (minimum order, own usage limit) keep their specific message.
    if (UNIFORM_COUPON_ERRORS.includes(err.errorCode)) {
      return next(new AppError('Coupon code is invalid or expired.', 400, 'COUPON_INVALID'));
    }
    next(err);
  }
};

module.exports = { getAll, getPerformance, getById, getRedemptions, create, update, remove, validatePublic };
