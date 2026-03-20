const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/admin/settings.controller');

// GET /api/settings — public, no auth required
// Returns only shop-facing info (name, phone, hours, delivery fee etc)
router.get('/', settingsController.getPublic);

module.exports = router;