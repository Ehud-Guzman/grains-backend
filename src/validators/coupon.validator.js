const { body } = require('express-validator');

const discountRules = [
  body('discountType')
    .isIn(['percentage', 'fixed']).withMessage('Discount type must be "percentage" or "fixed"'),

  body('discountValue')
    .isFloat({ min: 0 }).withMessage('Discount value must be 0 or greater')
    .custom((value, { req }) => {
      if (req.body.discountType === 'percentage' && Number(value) > 100) {
        throw new Error('Percentage discount cannot exceed 100%');
      }
      return true;
    }),
];

const optionalFieldRules = [
  body('minOrderValue')
    .optional({ nullable: true })
    .isFloat({ min: 0 }).withMessage('Minimum order value must be 0 or greater'),

  body('expiresAt')
    .optional({ nullable: true })
    .isISO8601().withMessage('Expiry must be a valid date'),

  body('usageLimit')
    .optional({ nullable: true })
    .isInt({ min: 1 }).withMessage('Usage limit must be at least 1'),

  body('assignedTo')
    .optional({ nullable: true })
    .isMongoId().withMessage('Invalid user ID'),

  body('isActive')
    .optional()
    .isBoolean().withMessage('isActive must be true or false'),
];

const createCouponValidator = [
  body('code')
    .trim()
    .notEmpty().withMessage('Coupon code is required')
    .isLength({ min: 3, max: 30 }).withMessage('Coupon code must be between 3 and 30 characters')
    .matches(/^[A-Za-z0-9_-]+$/).withMessage('Coupon code may only contain letters, numbers, hyphens and underscores'),

  ...discountRules,
  ...optionalFieldRules,
];

const updateCouponValidator = [
  body('code')
    .optional()
    .trim()
    .notEmpty().withMessage('Coupon code cannot be empty')
    .isLength({ min: 3, max: 30 }).withMessage('Coupon code must be between 3 and 30 characters')
    .matches(/^[A-Za-z0-9_-]+$/).withMessage('Coupon code may only contain letters, numbers, hyphens and underscores'),

  body('discountType')
    .optional()
    .isIn(['percentage', 'fixed']).withMessage('Discount type must be "percentage" or "fixed"'),

  body('discountValue')
    .optional()
    .isFloat({ min: 0 }).withMessage('Discount value must be 0 or greater'),

  ...optionalFieldRules,
];

// Public checkout preview — guards couponService.validate against non-string
// code (would 500 on .toUpperCase()) and NaN subtotal
const validateCouponValidator = [
  body('code')
    .isString().withMessage('Coupon code is required')
    .trim()
    .notEmpty().withMessage('Coupon code is required')
    .isLength({ max: 30 }).withMessage('Invalid coupon code'),

  body('subtotal')
    .isFloat({ min: 0 }).withMessage('Subtotal must be 0 or greater'),
];

module.exports = { createCouponValidator, updateCouponValidator, validateCouponValidator };
