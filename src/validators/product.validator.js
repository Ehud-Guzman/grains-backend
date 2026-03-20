const { body } = require('express-validator');

const packagingValidator = [
  body('varieties.*.packaging.*.size')
    .trim()
    .notEmpty().withMessage('Packaging size is required'),

  body('varieties.*.packaging.*.priceKES')
    .optional({ nullable: true })
    .isFloat({ min: 0 }).withMessage('Price must be a positive number'),

  body('varieties.*.packaging.*.stock')
    .optional()
    .isInt({ min: 0 }).withMessage('Stock must be a non-negative integer'),

  body('varieties.*.packaging.*.lowStockThreshold')
    .optional()
    .isInt({ min: 0 }).withMessage('Low stock threshold must be a non-negative integer'),

  body('varieties.*.packaging.*.quoteOnly')
    .optional()
    .isBoolean().withMessage('quoteOnly must be true or false')
];

const createProductValidator = [
  body('name')
    .trim()
    .notEmpty().withMessage('Product name is required')
    .isLength({ min: 2, max: 200 }).withMessage('Name must be between 2 and 200 characters'),

  body('category')
    .trim()
    .notEmpty().withMessage('Category is required'),

  body('description')
    .optional()
    .trim()
    .isLength({ max: 2000 }).withMessage('Description cannot exceed 2000 characters'),

  body('varieties')
    .isArray({ min: 1 }).withMessage('At least one variety is required'),

  body('varieties.*.varietyName')
    .trim()
    .notEmpty().withMessage('Variety name is required'),

  body('varieties.*.packaging')
    .isArray({ min: 1 }).withMessage('Each variety must have at least one packaging size'),

  ...packagingValidator,

  body('isActive')
    .optional()
    .isBoolean().withMessage('isActive must be true or false')
];

const updateProductValidator = [
  body('name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 200 }).withMessage('Name must be between 2 and 200 characters'),

  body('category')
    .optional()
    .trim()
    .notEmpty().withMessage('Category cannot be empty'),

  body('varieties')
    .optional()
    .isArray({ min: 1 }).withMessage('At least one variety is required'),

  body('isActive')
    .optional()
    .isBoolean().withMessage('isActive must be true or false')
];

module.exports = { createProductValidator, updateProductValidator };
