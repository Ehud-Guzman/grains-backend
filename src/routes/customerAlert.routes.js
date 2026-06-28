const express = require('express');
const router = express.Router();
const alertController = require('../controllers/customerAlert.controller');
const { verifyToken } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { publicLimiter } = require('../middleware/rateLimit.middleware');

router.use(verifyToken, requireRole('customer'), publicLimiter);

// GET  /api/alerts       — my active alerts
router.get('/', alertController.getMyAlerts);

// POST /api/alerts       — subscribe (back_in_stock | price_drop)
router.post('/', alertController.subscribe);

// DELETE /api/alerts/:id — unsubscribe
router.delete('/:id', alertController.unsubscribe);

module.exports = router;
