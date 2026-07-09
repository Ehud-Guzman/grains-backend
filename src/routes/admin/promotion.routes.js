const express = require('express');
const router = express.Router();
const multer = require('multer');
const cloudinary = require('../../config/cloudinary');
const promoController = require('../../controllers/admin/promotion.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireMinRole, requireBusinessRole } = require('../../middleware/role.middleware');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');
const { validate } = require('../../middleware/validate.middleware');
const { createPromotionValidator, updatePromotionValidator } = require('../../validators/promotion.validator');
const { isValidImageBuffer } = require('../../utils/validateImageBuffer');

router.use(verifyToken, adminLimiter);

// In-memory multer (no disk write — stream straight to Cloudinary)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'].includes(file.mimetype);
    ok ? cb(null, true) : cb(new Error('Only JPEG, PNG or WebP images are allowed'));
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

router.get('/',     requireMinRole('supervisor'), promoController.getAll);
router.get('/:id',  requireMinRole('supervisor'), promoController.getById);
router.post('/',    requireMinRole('admin'),       createPromotionValidator, validate, promoController.create);
router.put('/:id',  requireMinRole('admin'),       updatePromotionValidator, validate, promoController.update);
router.delete('/:id', requireMinRole('admin'),     promoController.remove);

module.exports = router;
