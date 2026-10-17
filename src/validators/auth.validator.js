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
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number'),

  body('marketingConsent')
    .optional()
    .isBoolean().withMessage('marketingConsent must be true or false')
    .toBoolean()
];

const loginValidator = [
  body('phone')
    .trim()
    .notEmpty().withMessage('Phone number is required')
    .matches(/^(\+254|0)[17]\d{8}$/).withMessage('Enter a valid Kenyan phone number (e.g. 0712345678)'),

  body('password')
    .notEmpty().withMessage('Password is required')
];

// refreshToken can arrive as an HttpOnly cookie (browser) or body field (API clients).
// The controller reads both; we just skip body validation so cookies-only requests pass.
const refreshValidator = [
  body('refreshToken').optional()
];

const forgotPasswordValidator = [
  body('phone')
    .trim()
    .notEmpty().withMessage('Phone number is required')
    .matches(/^(\+254|0)[17]\d{8}$/).withMessage('Enter a valid Kenyan phone number (e.g. 0712345678)'),
];

const resetPasswordValidator = [
  body('phone')
    .trim()
    .notEmpty().withMessage('Phone number is required')
    .matches(/^(\+254|0)[17]\d{8}$/).withMessage('Enter a valid Kenyan phone number (e.g. 0712345678)'),

  body('otp')
    .trim()
    .notEmpty().withMessage('Reset code is required')
    .matches(/^\d{6}$/).withMessage('Reset code must be 6 digits'),

  body('newPassword')
    .notEmpty().withMessage('New password is required')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number'),
];

// PUT /auth/me — every field optional, but anything sent must be well-formed and
// bounded (addresses and names were stored as-is, with no length limits).
const updateProfileValidator = [
  body('name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),

  body('email')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isEmail().withMessage('Enter a valid email address'),

  body('kraPin')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .toUpperCase()
    .matches(/^[A-Z]\d{9}[A-Z]$/).withMessage('KRA PIN must look like A012345678B'),

  body('addresses')
    .optional()
    .isArray({ max: 10 }).withMessage('You can save up to 10 addresses'),
  body('addresses.*.label')
    .trim().notEmpty().withMessage('Each address needs a label')
    .isLength({ max: 60 }).withMessage('Address label cannot exceed 60 characters'),
  body('addresses.*.value')
    .trim().notEmpty().withMessage('Each address needs its details')
    .isLength({ max: 500 }).withMessage('Address cannot exceed 500 characters'),

  body('marketingConsent')
    .optional()
    .isBoolean().withMessage('marketingConsent must be true or false')
];

module.exports = {
  updateProfileValidator,
  registerValidator, loginValidator, refreshValidator,
  forgotPasswordValidator, resetPasswordValidator
};
