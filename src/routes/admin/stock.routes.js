const express = require('express');
const router = express.Router();
const stockController = require('../../controllers/admin/stock.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireMinRole, requireBusinessRole } = require('../../middleware/role.middleware');
const { validate } = require('../../middleware/validate.middleware');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');
const { deliveryValidator, adjustmentValidator, batchUpdateValidator } = require('../../validators/stock.validator');

router.use(verifyToken, adminLimiter);

// ── READ (superadmin CAN view — oversight) ────────────────────────────────────

// GET /api/admin/stock
router.get('/', requireMinRole('supervisor'), stockController.getOverview);

// GET /api/admin/stock/low
router.get('/low', requireMinRole('supervisor'), stockController.getLowStock);

// GET /api/admin/stock/logs
router.get('/logs', (req, res, next) => {
  req.params.productId = null;
  stockController.getLogs(req, res, next);
});

// GET /api/admin/stock/:productId/logs
router.get('/:productId/logs', requireMinRole('supervisor'), stockController.getLogs);

// ── WRITE (superadmin CANNOT perform — business operations) ───────────────────

// POST /api/admin/stock/delivery
router.post('/delivery', requireBusinessRole('supervisor'), deliveryValidator, validate, stockController.addDelivery);

// POST /api/admin/stock/adjust
router.post('/adjust', requireBusinessRole('supervisor'), adjustmentValidator, validate, stockController.manualAdjustment);

// POST /api/admin/stock/batch
router.post('/batch', requireBusinessRole('supervisor'), batchUpdateValidator, validate, stockController.batchUpdate);

module.exports = router;