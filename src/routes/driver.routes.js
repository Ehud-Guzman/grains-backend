const express = require('express');
const router = express.Router();
const driverController = require('../controllers/driver.controller');
const { verifyToken } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { adminLimiter } = require('../middleware/rateLimit.middleware');
const multer = require('multer');
const { UPLOAD_LIMITS } = require('../utils/constants');

// In-memory multer for the optional proof-of-delivery photo (streamed to Cloudinary)
const proofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_LIMITS.IMAGE_MAX_FILE_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Only JPEG, PNG, or WebP images are allowed'));
  }
});

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

// PATCH /api/driver/orders/:id/complete — multipart: optional `photo` file +
// optional recipientName/note text fields (plain JSON bodies still work)
router.patch('/orders/:id/complete', proofUpload.single('photo'), driverController.completeDelivery);

module.exports = router;
