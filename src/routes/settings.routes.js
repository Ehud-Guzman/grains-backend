const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/admin/settings.controller');

// GET /api/settings — public, no auth required
// Returns only shop-facing info (name, phone, hours, delivery fee etc)
router.get('/', settingsController.getPublic);

// GET /api/delivery-fee?lat=X&lng=Y — public
// Returns calculated delivery fee for the given customer coordinates.
// Used by checkout page for live fee preview before order submission.
router.get('/delivery-fee', settingsController.getDeliveryFee);

module.exports = router;