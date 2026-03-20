const { body } = require('express-validator');

const registerValidator = [
  body('name')
    .trim()
    .notEmpty().withMessage('Name is required')
    .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),

  body('phone')
    .trim()
    .notEmpty().withMessage('Phone number is required')
    .matches(/^(\+254|0)[17]\d{8}$/).withMessage('Enter a valid Kenyan phone number (e.g. 0712345678)'),

  body('email')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isEmail().withMessage('Enter a valid email address')
    .normalizeEmail(),

  body('password')
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
];

const loginValidator = [
  body('phone')
    .trim()
    .notEmpty().withMessage('Phone number is required'),

  body('password')
    .notEmpty().withMessage('Password is required')
];

const refreshValidator = [
  body('refreshToken')
    .notEmpty().withMessage('Refresh token is required')
];

module.exports = { registerValidator, loginValidator, refreshValidator };
