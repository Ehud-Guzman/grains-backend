const express = require('express');
const router = express.Router();
const promotionService = require('../services/promotion.service');
const { getDefaultBranch } = require('../services/defaultBranch.service');
const { publicLimiter } = require('../middleware/rateLimit.middleware');
const { success } = require('../utils/apiResponse');

// GET /api/promotions — public active promotions for the storefront
router.get('/', publicLimiter, async (req, res, next) => {
  try {
    const branch = req.query.branchId
      ? { _id: req.query.branchId }
      : await getDefaultBranch();
    if (!branch) return success(res, []);
    const promos = await promotionService.getActive(branch._id);
    return success(res, promos);
  } catch (err) { next(err); }
});

module.exports = router;
