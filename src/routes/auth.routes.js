const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { registerValidator, loginValidator, refreshValidator } = require('../validators/auth.validator');
const { validate } = require('../middleware/validate.middleware');
const { verifyToken, optionalAuth } = require('../middleware/auth.middleware');
const { authLimiter } = require('../middleware/rateLimit.middleware');

// POST /api/auth/register
router.post('/register', authLimiter, registerValidator, validate, authController.register);

// POST /api/auth/login
router.post('/login', authLimiter, loginValidator, validate, authController.login);

// POST /api/auth/refresh
router.post('/refresh', refreshValidator, validate, authController.refresh);

// POST /api/auth/logout
router.post('/logout', optionalAuth, authController.logout);

// POST /api/auth/change-password (requires auth)
router.post('/change-password', verifyToken, authController.changePassword);

// GET /api/auth/me — get own profile
router.get('/me', verifyToken, authController.getProfile);

// PUT /api/auth/me — update own profile
router.put('/me', verifyToken, authController.updateProfile);

module.exports = router;

// POST /api/auth/avatar — upload profile picture (requires auth)
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only JPEG, PNG, or WebP images are allowed'));
  }
});

router.post('/avatar', verifyToken, uploadAvatar.single('avatar'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image provided' });
    }

    // Upload to Cloudinary — square crop, optimised
    const url = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: 'grains-shop/avatars',
          public_id: `user-${req.user.id}`,
          overwrite: true,
          transformation: [
            { width: 400, height: 400, crop: 'fill', gravity: 'face', quality: 'auto', fetch_format: 'auto' }
          ]
        },
        (error, result) => error ? reject(error) : resolve(result.secure_url)
      );
      stream.end(req.file.buffer);
    });

    // Save URL to user document
    const User = require('../models/User');
    await User.findByIdAndUpdate(req.user.id, { avatarURL: url });

    // Log
    const activityLogService = require('../services/activityLog.service');
    await activityLogService.log({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'PROFILE_UPDATED',
      targetId: req.user.id,
      targetType: 'User',
      detail: { updatedFields: ['avatarURL'] }
    });

    return res.json({ success: true, data: { avatarURL: url }, message: 'Avatar updated' });
  } catch (err) {
    next(err);
  }
});