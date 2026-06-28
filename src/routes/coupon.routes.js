const express = require('express');
const router = express.Router();
const couponController = require('../controllers/admin/coupon.controller');
const { optionalAuth } = require('../middleware/auth.middleware');
const { publicLimiter } = require('../middleware/rateLimit.middleware');

// POST /api/coupons/validate — public (optionally authed for user-specific coupons)
router.post('/validate', publicLimiter, optionalAuth, couponController.validatePublic);

module.exports = router;
