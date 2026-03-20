const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');
const { AppError } = require('./errorHandler.middleware');

// ── PRODUCT IMAGES ────────────────────────────────────────────────────────────
const productStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: 'grains-shop/products',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [
      { width: 800, height: 800, crop: 'limit' }, // max size
      { quality: 'auto:good' },                    // auto compress
      { fetch_format: 'auto' }                     // serve WebP where supported
    ],
    public_id: `product-${Date.now()}-${Math.round(Math.random() * 1e9)}`
  })
});

// ── FILE FILTER ───────────────────────────────────────────────────────────────
const imageFilter = (req, file, cb) => {
  if (!file.mimetype.startsWith('image/')) {
    return cb(new AppError('Only image files are allowed', 400, 'INVALID_FILE_TYPE'), false);
  }
  cb(null, true);
};

// ── UPLOAD INSTANCES ──────────────────────────────────────────────────────────
// Single image upload
const uploadSingle = multer({
  storage: productStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB max per file
}).single('image');

// Multiple images upload (max 5)
const uploadMultiple = multer({
  storage: productStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024 }
}).array('images', 5);

// ── PROMISE WRAPPERS ──────────────────────────────────────────────────────────
// Wraps multer callback into async/await friendly functions
const uploadSingleAsync = (req, res) => new Promise((resolve, reject) => {
  uploadSingle(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return reject(new AppError('Image is too large. Maximum size is 5MB.', 400, 'FILE_TOO_LARGE'));
      }
      return reject(new AppError(err.message, 400, 'UPLOAD_ERROR'));
    }
    if (err) return reject(err);
    resolve();
  });
});

const uploadMultipleAsync = (req, res) => new Promise((resolve, reject) => {
  uploadMultiple(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return reject(new AppError('One or more images are too large. Maximum size is 5MB each.', 400, 'FILE_TOO_LARGE'));
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return reject(new AppError('Maximum 5 images allowed per product.', 400, 'TOO_MANY_FILES'));
      }
      return reject(new AppError(err.message, 400, 'UPLOAD_ERROR'));
    }
    if (err) return reject(err);
    resolve();
  });
});

module.exports = { uploadSingleAsync, uploadMultipleAsync };