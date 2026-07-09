const { body } = require('express-validator');

const PROMO_TYPES = ['banner', 'featured_product', 'seasonal', 'tip'];

const sharedFieldRules = [
  body('description')
    .optional({ nullable: true })
    .trim()
    .isLength({ max: 1000 }).withMessage('Description cannot exceed 1000 characters'),

  body('imageUrl')
    .optional({ nullable: true })
    .isURL({ protocols: ['https', 'http'] }).withMessage('Image URL must be a valid URL'),

  body('mediaType')
    .optional()
    .isIn(['image', 'video']).withMessage('mediaType must be image or video'),

  body('videoUrl')
    .optional({ nullable: true })
    .isURL({ protocols: ['https', 'http'] }).withMessage('Video URL must be a valid URL'),

  body('linkedProductId')
    .optional({ nullable: true })
    .isMongoId().withMessage('Invalid product ID'),

  body('startDate')
    .optional({ nullable: true })
    .isISO8601().withMessage('Start date must be a valid date'),

  body('endDate')
    .optional({ nullable: true })
    .isISO8601().withMessage('End date must be a valid date')
    .custom((value, { req }) => {
      if (value && req.body.startDate && new Date(value) < new Date(req.body.startDate)) {
        throw new Error('End date cannot be before start date');
      }
      return true;
    }),

  body('isActive')
    .optional()
    .isBoolean().withMessage('isActive must be true or false'),

  body('seasonTag')
    .optional({ nullable: true })
    .trim()
    .isLength({ max: 50 }).withMessage('Season tag cannot exceed 50 characters'),

  body('sortOrder')
    .optional()
    .isInt().withMessage('Sort order must be a whole number'),
];

const createPromotionValidator = [
  body('title')
    .trim()
    .notEmpty().withMessage('Title is required')
    .isLength({ max: 150 }).withMessage('Title cannot exceed 150 characters'),

  body('type')
    .isIn(PROMO_TYPES).withMessage(`Type must be one of: ${PROMO_TYPES.join(', ')}`),

  ...sharedFieldRules,
];

const updatePromotionValidator = [
  body('title')
    .optional()
    .trim()
    .notEmpty().withMessage('Title cannot be empty')
    .isLength({ max: 150 }).withMessage('Title cannot exceed 150 characters'),

  body('type')
    .optional()
    .isIn(PROMO_TYPES).withMessage(`Type must be one of: ${PROMO_TYPES.join(', ')}`),

  ...sharedFieldRules,
];

module.exports = { createPromotionValidator, updatePromotionValidator };
