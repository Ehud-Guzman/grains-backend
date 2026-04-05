const express = require('express');
const router = express.Router();
const productController = require('../../controllers/product.controller');
const { exportHandler, templateHandler, importHandler } = require('../../controllers/productImportExport.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireMinRole, requireBusinessRole } = require('../../middleware/role.middleware');
const { validate } = require('../../middleware/validate.middleware');
const { createProductValidator, updateProductValidator } = require('../../validators/product.validator');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

// Cloudinary config — credentials from .env, never hardcoded
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// multer for Excel import
const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only Excel files are accepted'));
  }
});

// multer for product images
const uploadImages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per image
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only JPEG, PNG, or WebP images are allowed'));
  }
});

router.use(verifyToken, adminLimiter);

// ── STATIC ROUTES (must be defined before /:id to avoid conflicts) ────────────

// GET  /api/admin/products/export
router.get('/export', requireMinRole('admin'), exportHandler);

// GET  /api/admin/products/template
router.get('/template', requireMinRole('admin'), templateHandler);

// POST /api/admin/products/import
router.post('/import', requireMinRole('admin'), uploadExcel.single('file'), importHandler);

// POST /api/admin/products/upload-images
// Uploads images to Cloudinary and saves URLs to the product document
router.post(
  '/upload-images',
  requireBusinessRole('admin'),
  uploadImages.array('images', 10), // max 10 images at once
  async (req, res, next) => {
    try {
      const { productId } = req.body;

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: 'No image files provided' });
      }

      // Upload each file to Cloudinary
      const uploadPromises = req.files.map(file =>
        new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              folder: 'grains-shop/products',
              transformation: [
                { width: 800, height: 800, crop: 'limit', quality: 'auto', fetch_format: 'auto' }
              ]
            },
            (error, result) => error ? reject(error) : resolve(result.secure_url)
          );
          stream.end(file.buffer);
        })
      );

      const urls = await Promise.all(uploadPromises);

      // If productId provided, persist URLs to the product document immediately
      let product = null;
      if (productId) {
        product = await productController.addImagesToProduct(productId, urls);
      }

      // Return in standard API response format { success, data: { urls } }
      return res.status(200).json({
        success: true,
        data: { urls, product },
        message: `${urls.length} image(s) uploaded successfully`
      });

    } catch (err) {
      next(err);
    }
  }
);

// ── READ (superadmin CAN view) ────────────────────────────────────────────────

// GET /api/admin/products
router.get('/', requireMinRole('admin'), productController.getAllAdmin);

// GET /api/admin/products/:id
router.get('/:id', requireMinRole('admin'), productController.getById);

// ── WRITE (superadmin CANNOT perform) ────────────────────────────────────────

// POST /api/admin/products
router.post('/', requireBusinessRole('admin'), createProductValidator, validate, productController.create);

// PUT /api/admin/products/:id
router.put('/:id', requireBusinessRole('admin'), updateProductValidator, validate, productController.update);

// PATCH /api/admin/products/:id/toggle-active
router.patch('/:id/toggle-active', requireBusinessRole('admin'), productController.toggleActive);

// POST /api/admin/products/:id/duplicate
router.post('/:id/duplicate', requireBusinessRole('admin'), productController.duplicate);

// DELETE /api/admin/products/:id
router.delete('/:id', requireBusinessRole('admin'), productController.deleteProduct);

module.exports = router;
