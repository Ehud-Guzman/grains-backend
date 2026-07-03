const express = require('express');
const router = express.Router();
const branchController = require('../controllers/branch.controller');

// ── PUBLIC BRANCH ROUTES (no auth — storefront branch resolution) ─────────────
// Rate-limited by the global publicLimiter applied in app.js.

// GET /api/branches — active branches for the storefront picker
router.get('/', branchController.getPublicBranches);

// GET /api/branches/nearest?lat=X&lng=Y — nearest branch for customer location
router.get('/nearest', branchController.getNearestBranch);

// GET /api/branches/:branchId/riders — available riders for checkout selection
router.get('/:branchId/riders', branchController.getAvailableRiders);

module.exports = router;
