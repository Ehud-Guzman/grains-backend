const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { registerValidator, loginValidator, refreshValidator } = require('../validators/auth.validator');
const { validate } = require('../middleware/validate.middleware');
const { verifyToken, optionalAuth } = require('../middleware/auth.middleware');
const { authLimiter } = require('../middleware/rateLimit.middleware');
const multer = require('multer');
const { UPLOAD_LIMITS } = require('../utils/constants');

// Multer for avatar uploads
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_LIMITS.IMAGE_MAX_FILE_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Only JPEG, PNG, or WebP images are allowed'));
  }
});

// ── PUBLIC AUTH ROUTES ────────────────────────────────────────────────────────

// POST /api/auth/register
router.post('/register', authLimiter, registerValidator, validate, authController.register);

// POST /api/auth/login
router.post('/login', authLimiter, loginValidator, validate, authController.login);

// POST /api/auth/refresh
router.post('/refresh', authLimiter, refreshValidator, validate, authController.refresh);

// POST /api/auth/select-branch — step 2 of admin login (exchange preAuthToken + branchId for full tokens)
router.post('/select-branch', authLimiter, authController.selectBranch);

// POST /api/auth/switch-branch — superadmin switches branch context while already logged in
router.post('/switch-branch', verifyToken, authController.switchBranch);

// POST /api/auth/logout — send { refreshToken } in body to blacklist it
router.post('/logout', optionalAuth, authController.logout);

// ── AUTHENTICATED ROUTES ──────────────────────────────────────────────────────

// POST /api/auth/change-password
router.post('/change-password', verifyToken, authController.changePassword);

// GET /api/auth/me — get own profile
router.get('/me', verifyToken, authController.getProfile);

// PUT /api/auth/me — update own profile
router.put('/me', verifyToken, authController.updateProfile);

// GET /api/auth/onboarding — get own onboarding state
router.get('/onboarding', verifyToken, authController.getOnboarding);

// PATCH /api/auth/onboarding — update own onboarding state
router.patch('/onboarding', verifyToken, authController.updateOnboarding);

// POST /api/auth/avatar — upload profile picture
router.post('/avatar', verifyToken, avatarUpload.single('avatar'), authController.uploadAvatar);

module.exports = router;
