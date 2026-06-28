const express = require('express');
const router = express.Router();
const couponController = require('../../controllers/admin/coupon.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireMinRole } = require('../../middleware/role.middleware');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');

router.use(verifyToken, adminLimiter);

router.get('/',     requireMinRole('supervisor'), couponController.getAll);
router.get('/:id',  requireMinRole('supervisor'), couponController.getById);
router.post('/',    requireMinRole('admin'),       couponController.create);
router.put('/:id',  requireMinRole('admin'),       couponController.update);
router.delete('/:id', requireMinRole('admin'),     couponController.remove);

module.exports = router;
