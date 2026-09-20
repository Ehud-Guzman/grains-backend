const express = require('express');
const router = express.Router();
const couponController = require('../../controllers/admin/coupon.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireMinRole, requireBusinessRole } = require('../../middleware/role.middleware');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');
const { checkPlatformLock } = require('../../middleware/platformLock.middleware');
const { validate } = require('../../middleware/validate.middleware');
const { createCouponValidator, updateCouponValidator } = require('../../validators/coupon.validator');

router.use(verifyToken, adminLimiter, checkPlatformLock);

router.get('/',     requireMinRole('supervisor'), couponController.getAll);
router.get('/performance', requireMinRole('supervisor'), couponController.getPerformance);
router.get('/:id',  requireMinRole('supervisor'), couponController.getById);
router.get('/:id/redemptions', requireMinRole('supervisor'), couponController.getRedemptions);
// ── WRITE (business operations — superadmin CANNOT perform) ───────────────────
// These were requireMinRole('admin'), which let superadmin through unchanged
// (they sit at the top of the role hierarchy, so the index comparison always
// passed). Coupons are a trading decision, not a platform one, and the admin UI
// gives superadmin no Coupons nav entry at all.
router.post('/',    requireBusinessRole('admin'),  createCouponValidator, validate, couponController.create);
router.put('/:id',  requireBusinessRole('admin'),  updateCouponValidator, validate, couponController.update);
router.delete('/:id', requireBusinessRole('admin'), couponController.remove);

module.exports = router;
