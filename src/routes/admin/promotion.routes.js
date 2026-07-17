const express = require('express');
const router = express.Router();
const multer = require('multer');
const cloudinary = require('../../config/cloudinary');
const promoController = require('../../controllers/admin/promotion.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireMinRole, requireBusinessRole } = require('../../middleware/role.middleware');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');
const { checkPlatformLock } = require('../../middleware/platformLock.middleware');
const { validate } = require('../../middleware/validate.middleware');
const { createPromotionValidator, updatePromotionValidator } = require('../../validators/promotion.validator');
const { isValidImageBuffer } = require('../../utils/validateImageBuffer');
const { isValidVideoBuffer } = require('../../utils/validateVideoBuffer');

router.use(verifyToken, adminLimiter, checkPlatformLock);

// In-memory multer (no disk write — stream straight to Cloudinary)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'].includes(file.mimetype);
    ok ? cb(null, true) : cb(new Error('Only JPEG, PNG or WebP images are allowed'));
  },
});

// Videos are a much heavier asset than the 5MB image cap allows — 25MB covers
// a several-second banner clip; the storefront carousel plays it muted/looped,
// so this is meant for short loops, not long-form video.
const uploadVideo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['video/mp4', 'video/webm', 'video/quicktime'].includes(file.mimetype);
    ok ? cb(null, true) : cb(new Error('Only MP4, WebM or MOV videos are allowed'));
  },
});

// POST /api/admin/promotions/upload-image
router.post('/upload-image', requireBusinessRole('admin'), upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No image file provided' });
    if (!isValidImageBuffer(req.file.buffer)) {
      return res.status(400).json({ success: false, message: 'File is not a valid JPEG, PNG, or WebP image' });
    }
    const url = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'grains-shop/promotions', transformation: [{ width: 1200, height: 630, crop: 'limit', quality: 'auto', fetch_format: 'auto' }] },
        (err, result) => err ? reject(err) : resolve(result.secure_url)
      );
      stream.end(req.file.buffer);
    });
    res.json({ success: true, data: { url } });
  } catch (err) { next(err); }
});

// POST /api/admin/promotions/upload-video
router.post('/upload-video', requireBusinessRole('admin'), uploadVideo.single('video'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No video file provided' });
    if (!isValidVideoBuffer(req.file.buffer)) {
      return res.status(400).json({ success: false, message: 'File is not a valid MP4, WebM, or MOV video' });
    }
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'video',
          folder: 'grains-shop/promotions',
          transformation: [{ width: 1280, height: 720, crop: 'limit', quality: 'auto' }],
        },
        (err, result) => err ? reject(err) : resolve(result)
      );
      stream.end(req.file.buffer);
    });
    res.json({ success: true, data: { url: result.secure_url, thumbnailUrl: result.secure_url.replace(/\.[^./]+$/, '.jpg') } });
  } catch (err) { next(err); }
});

router.get('/',     requireMinRole('supervisor'), promoController.getAll);
router.get('/:id',  requireMinRole('supervisor'), promoController.getById);
router.post('/',    requireMinRole('admin'),       createPromotionValidator, validate, promoController.create);
router.put('/:id',  requireMinRole('admin'),       updatePromotionValidator, validate, promoController.update);
router.delete('/:id', requireMinRole('admin'),     promoController.remove);

module.exports = router;
