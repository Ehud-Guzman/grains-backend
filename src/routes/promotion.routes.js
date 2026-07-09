const express = require('express');
const router = express.Router();
const promotionService = require('../services/promotion.service');
const { resolvePublicBranch } = require('../services/defaultBranch.service');
const { publicLimiter } = require('../middleware/rateLimit.middleware');
const { success } = require('../utils/apiResponse');

// GET /api/promotions?branchId=… — public active promotions for the storefront.
// An invalid/inactive branchId falls back to default rather than erroring —
// same resolution rule as /api/settings and /api/products (storefront must
// always render, and must never return another branch's promotions just
// because a malformed/stale id was passed).
router.get('/', publicLimiter, async (req, res, next) => {
  try {
    const branch = await resolvePublicBranch(req.query.branchId);
    if (!branch) return success(res, []);
    const promos = await promotionService.getActive(branch._id);
    return success(res, promos);
  } catch (err) { next(err); }
});

module.exports = router;
