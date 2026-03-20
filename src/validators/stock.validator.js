const { body } = require('express-validator');

const deliveryValidator = [
  body('productId')
    .notEmpty().withMessage('Product ID is required')
    .isMongoId().withMessage('Invalid product ID'),

  body('varietyName')
    .trim()
    .notEmpty().withMessage('Variety name is required'),

  body('packagingSize')
    .trim()
    .notEmpty().withMessage('Packaging size is required'),

  body('quantity')
    .isInt({ min: 1 }).withMessage('Quantity must be at least 1'),

  body('reason')
    .optional()
    .trim()
    .isLength({ max: 500 }).withMessage('Reason cannot exceed 500 characters'),

  body('supplierId')
    .optional({ nullable: true })
    .isMongoId().withMessage('Invalid supplier ID')
];

const adjustmentValidator = [
  body('productId')
    .notEmpty().withMessage('Product ID is required')
    .isMongoId().withMessage('Invalid product ID'),

  body('varietyName')
    .trim()
    .notEmpty().withMessage('Variety name is required'),

  body('packagingSize')
    .trim()
    .notEmpty().withMessage('Packaging size is required'),

  body('newQuantity')
    .isInt({ min: 0 }).withMessage('New quantity must be 0 or greater'),

  body('reason')
    .trim()
    .notEmpty().withMessage('Reason is required for manual adjustments')
    .isLength({ min: 3, max: 500 }).withMessage('Reason must be between 3 and 500 characters')
];

const batchUpdateValidator = [
  body('updates')
    .isArray({ min: 1 }).withMessage('At least one update is required'),

  body('updates.*.productId')
    .notEmpty().withMessage('Product ID is required')
    .isMongoId().withMessage('Invalid product ID'),

  body('updates.*.varietyName')
    .trim()
    .notEmpty().withMessage('Variety name is required'),

  body('updates.*.packagingSize')
    .trim()
    .notEmpty().withMessage('Packaging size is required'),

  body('updates.*.quantity')
    .isInt({ min: 1 }).withMessage('Quantity must be at least 1')
];

module.exports = { deliveryValidator, adjustmentValidator, batchUpdateValidator };
