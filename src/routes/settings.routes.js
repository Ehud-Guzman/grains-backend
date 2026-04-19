const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/admin/settings.controller');
const { verifyToken } = require('../middleware/auth.middleware');

// GET /api/settings — public, no auth required
router.get('/', settingsController.getPublic);

// GET /api/settings/receipt — requires auth; returns kraPin + receiptFooterNote for receipt rendering
router.get('/receipt', verifyToken, settingsController.getReceiptConfig);

// GET /api/settings/delivery-fee?lat=X&lng=Y — public
router.get('/delivery-fee', settingsController.getDeliveryFee);

module.exports = router;