const { body } = require('express-validator');

const orderItemsValidator = [
  body('orderItems')
    .isArray({ min: 1 }).withMessage('Order must contain at least one item'),

  body('orderItems.*.productId')
    .notEmpty().withMessage('Product ID is required for each item')
    .isMongoId().withMessage('Invalid product ID'),

  body('orderItems.*.variety')
    .trim()
    .notEmpty().withMessage('Variety is required for each item'),

  body('orderItems.*.packaging')
    .trim()
    .notEmpty().withMessage('Packaging size is required for each item'),

  body('orderItems.*.quantity')
    .isInt({ min: 1 }).withMessage('Quantity must be at least 1')
];

const guestOrderValidator = [
  body('name')
    .trim()
    .notEmpty().withMessage('Name is required')
    .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),

  body('phone')
    .trim()
    .notEmpty().withMessage('Phone number is required')
    .matches(/^(\+254|0)[17]\d{8}$/).withMessage('Enter a valid Kenyan phone number'),

  body('deliveryMethod')
    .isIn(['pickup', 'delivery']).withMessage('Delivery method must be pickup or delivery'),

  body('deliveryAddress')
    .if(body('deliveryMethod').equals('delivery'))
    .trim()
    .notEmpty().withMessage('Delivery address is required when delivery method is delivery'),

  body('paymentMethod')
    .isIn(['mpesa', 'pickup', 'delivery']).withMessage('Invalid payment method'),

  ...orderItemsValidator
];

const customerOrderValidator = [
  body('deliveryMethod')
    .isIn(['pickup', 'delivery']).withMessage('Delivery method must be pickup or delivery'),

  body('deliveryAddress')
    .if(body('deliveryMethod').equals('delivery'))
    .trim()
    .notEmpty().withMessage('Delivery address is required when delivery method is delivery'),

  body('paymentMethod')
    .isIn(['mpesa', 'pickup', 'delivery']).withMessage('Invalid payment method'),

  ...orderItemsValidator
];

const rejectOrderValidator = [
  body('reason')
    .trim()
    .notEmpty().withMessage('Rejection reason is required')
    .isLength({ min: 3, max: 500 }).withMessage('Reason must be between 3 and 500 characters')
];

const updateStatusValidator = [
  body('status')
    .trim()
    .notEmpty().withMessage('Status is required')
    .isIn(['preparing', 'out_for_delivery', 'completed']).withMessage('Invalid status'),

  body('note')
    .optional()
    .trim()
    .isLength({ max: 500 }).withMessage('Note cannot exceed 500 characters')
];

const bulkActionValidator = [
  body('orderIds')
    .isArray({ min: 1 }).withMessage('At least one order ID is required'),

  body('orderIds.*')
    .isMongoId().withMessage('Invalid order ID in list')
];

module.exports = {
  guestOrderValidator,
  customerOrderValidator,
  rejectOrderValidator,
  updateStatusValidator,
  bulkActionValidator
};
