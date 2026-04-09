const express = require('express');
const router = express.Router();
const driverController = require('../controllers/driver.controller');
const { verifyToken } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { adminLimiter } = require('../middleware/rateLimit.middleware');

// All routes: must be authenticated as a driver
router.use(verifyToken, requireRole('driver'), adminLimiter);

// GET  /api/driver/me
router.get('/me', driverController.getMe);

// PATCH /api/driver/availability
router.patch('/availability', driverController.setAvailability);

// GET  /api/driver/orders
router.get('/orders', driverController.getMyOrders);

// GET  /api/driver/orders/:id
router.get('/orders/:id', driverController.getOrderDetail);

// PATCH /api/driver/orders/:id/complete
router.patch('/orders/:id/complete', driverController.completeDelivery);

module.exports = router;
