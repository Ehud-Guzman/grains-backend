const express = require('express');
const router = express.Router();
const orderController = require('../controllers/order.controller');
const { verifyToken } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { validate } = require('../middleware/validate.middleware');
const { guestOrderValidator, customerOrderValidator } = require('../validators/order.validator');

// ── PUBLIC ────────────────────────────────────────────────────────────────────

// POST /api/orders/guest
router.post('/guest', guestOrderValidator, validate, orderController.createGuestOrder);

// GET /api/orders/track?phone=&ref=
router.get('/track', orderController.trackOrder);

// ── CUSTOMER AUTH REQUIRED ────────────────────────────────────────────────────

// POST /api/orders
router.post('/', verifyToken, requireRole('customer'), customerOrderValidator, validate, orderController.createCustomerOrder);

// GET /api/orders/my
router.get('/my', verifyToken, requireRole('customer'), orderController.getMyOrders);

// PATCH /api/orders/:id/cancel
router.patch('/:id/cancel', verifyToken, requireRole('customer'), orderController.cancelOrder);

module.exports = router;
