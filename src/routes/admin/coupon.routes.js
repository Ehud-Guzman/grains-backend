const express = require('express');
const router = express.Router();
const couponController = require('../../controllers/admin/coupon.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireMinRole } = require('../../middleware/role.middleware');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');
const { validate } = require('../../middleware/validate.middleware');
const { createCouponValidator, updateCouponValidator } = require('../../validators/coupon.validator');

router.use(verifyToken, adminLimiter);

router.get('/',     requireMinRole('supervisor'), couponController.getAll);
router.get('/performance', requireMinRole('supervisor'), couponController.getPerformance);
router.get('/:id',  requireMinRole('supervisor'), couponController.getById);
router.get('/:id/redemptions', requireMinRole('supervisor'), couponController.getRedemptions);
router.post('/',    requireMinRole('admin'),       createCouponValidator, validate, couponController.create);
router.put('/:id',  requireMinRole('admin'),       updateCouponValidator, validate, couponController.update);
router.delete('/:id', requireMinRole('admin'),     couponController.remove);

module.exports = router;
