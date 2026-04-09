const { body, param } = require('express-validator');

const createIntakeValidator = [
  body('supplier')
    .trim()
    .notEmpty().withMessage('Supplier name is required')
    .isLength({ max: 200 }).withMessage('Supplier name cannot exceed 200 characters'),

  body('vehicleRef')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 100 }).withMessage('Vehicle reference cannot exceed 100 characters'),

  body('arrivedAt')
    .notEmpty().withMessage('Arrival date/time is required')
    .isISO8601().withMessage('arrivedAt must be a valid ISO 8601 date'),

  body('notes')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 1000 }).withMessage('Notes cannot exceed 1000 characters'),

  body('items')
    .isArray({ min: 1 }).withMessage('At least one item is required'),

  body('items.*.description')
    .trim()
    .notEmpty().withMessage('Each item must have a description')
    .isLength({ max: 300 }).withMessage('Item description cannot exceed 300 characters'),

  body('items.*.quantity')
    .isFloat({ min: 0 }).withMessage('Item quantity must be 0 or greater'),

  body('items.*.unit')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 50 }).withMessage('Unit cannot exceed 50 characters'),

  body('items.*.notes')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 500 }).withMessage('Item notes cannot exceed 500 characters'),
];

const processIntakeValidator = [
  param('id')
    .isMongoId().withMessage('Invalid intake ID'),

  body('processedNotes')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 1000 }).withMessage('Processed notes cannot exceed 1000 characters'),
];

module.exports = { createIntakeValidator, processIntakeValidator };
