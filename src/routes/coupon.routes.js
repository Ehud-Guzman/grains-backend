const express = require('express');
const router = express.Router();
const couponController = require('../controllers/admin/coupon.controller');
const { optionalAuth } = require('../middleware/auth.middleware');
const { publicLimiter } = require('../middleware/rateLimit.middleware');
const { validate } = require('../middleware/validate.middleware');
const { validateCouponValidator } = require('../validators/coupon.validator');

// POST /api/coupons/validate — public (optionally authed for user-specific coupons)
router.post('/validate', publicLimiter, optionalAuth, validateCouponValidator, validate, couponController.validatePublic);

module.exports = router;
