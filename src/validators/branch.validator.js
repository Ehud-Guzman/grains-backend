const { body, param } = require('express-validator');

const createBranchValidator = [
  body('name')
    .trim()
    .notEmpty().withMessage('Branch name is required')
    .isLength({ max: 100 }).withMessage('Branch name cannot exceed 100 characters'),

  body('slug')
    .trim()
    .notEmpty().withMessage('Slug is required')
    .isSlug().withMessage('Slug must be lowercase letters, numbers, and hyphens only')
    .isLength({ max: 60 }).withMessage('Slug cannot exceed 60 characters'),

  body('location')
    .optional({ nullable: true })
    .trim()
    .isLength({ max: 200 }).withMessage('Location cannot exceed 200 characters'),

  body('phone')
    .optional({ nullable: true })
    .trim()
    .isLength({ max: 20 }).withMessage('Phone cannot exceed 20 characters'),

  body('email')
    .optional({ nullable: true })
    .trim()
    .isEmail().withMessage('Invalid email address'),

  body('isDefault')
    .optional()
    .isBoolean().withMessage('isDefault must be a boolean'),
];

const updateBranchValidator = [
  body('name')
    .optional()
    .trim()
    .notEmpty().withMessage('Branch name cannot be empty')
    .isLength({ max: 100 }).withMessage('Branch name cannot exceed 100 characters'),

  body('slug')
    .optional()
    .trim()
    .isSlug().withMessage('Slug must be lowercase letters, numbers, and hyphens only')
    .isLength({ max: 60 }).withMessage('Slug cannot exceed 60 characters'),

  body('location')
    .optional({ nullable: true })
    .trim()
    .isLength({ max: 200 }).withMessage('Location cannot exceed 200 characters'),

  body('phone')
    .optional({ nullable: true })
    .trim()
    .isLength({ max: 20 }).withMessage('Phone cannot exceed 20 characters'),

  body('email')
    .optional({ nullable: true })
    .trim()
    .isEmail().withMessage('Invalid email address'),

  body('isDefault')
    .optional()
    .isBoolean().withMessage('isDefault must be a boolean'),

  body('isActive')
    .optional()
    .isBoolean().withMessage('isActive must be a boolean'),
];

const assignUserToBranchValidator = [
  param('id')
    .isMongoId().withMessage('Invalid branch ID'),

  body('userId')
    .notEmpty().withMessage('userId is required')
    .isMongoId().withMessage('Invalid user ID')
];

module.exports = { createBranchValidator, updateBranchValidator, assignUserToBranchValidator };
