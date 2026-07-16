const { body, check } = require('express-validator');
const { PAYMENT_METHODS } = require('../utils/constants');
const { startOfDayEAT } = require('../utils/businessTime');

// Customer's requested delivery/pickup date — a logistics planning hint.
// Must be a real date, not in the past (Nairobi clock), and within 60 days
// so a typo'd year doesn't land a phantom order in the 2030 delivery plan.
const MAX_PREFERRED_DATE_DAYS = 60;
const preferredDeliveryDateValidator =
  body('preferredDeliveryDate')
    .optional({ nullable: true, checkFalsy: true })
    .custom((val) => {
      const date = new Date(val);
      if (isNaN(date.getTime())) throw new Error('Invalid preferred delivery date');
      if (date < startOfDayEAT()) throw new Error('Preferred delivery date cannot be in the past');
      if (date > new Date(Date.now() + MAX_PREFERRED_DATE_DAYS * 24 * 60 * 60 * 1000))
        throw new Error(`Preferred delivery date cannot be more than ${MAX_PREFERRED_DATE_DAYS} days ahead`);
      return true;
    });

const deliveryCoordinatesValidator =
  check('deliveryCoordinates')
    .optional({ nullable: true })
    .custom((val) => {
      if (val === null || val === undefined) return true;
      if (typeof val !== 'object') throw new Error('deliveryCoordinates must be an object');
      const { lat, lng } = val;
      if (typeof lat !== 'number' || typeof lng !== 'number')
        throw new Error('deliveryCoordinates.lat and .lng must be numbers');
      if (lat < -90 || lat > 90)   throw new Error('Invalid latitude (must be -90 to 90)');
      if (lng < -180 || lng > 180) throw new Error('Invalid longitude (must be -180 to 180)');
      return true;
    });

const orderItemsValidator = [
  body('orderItems')
    .isArray({ min: 1 }).withMessage('Order must contain at least one item'),

  body('orderItems.*.productId')
    .notEmpty().withMessage('Product ID is required for each item')
    .isMongoId().withMessage('Invalid product ID'),

  body('orderItems.*.variety')
    .trim()
    .notEmpty().withMessage('Variety is required for each item')
    .isLength({ max: 200 }).withMessage('Variety name cannot exceed 200 characters'),

  body('orderItems.*.packaging')
    .trim()
    .notEmpty().withMessage('Packaging size is required for each item')
    .isLength({ max: 100 }).withMessage('Packaging size cannot exceed 100 characters'),

  body('orderItems.*.quantity')
    .isInt({ min: 1, max: 10000 }).withMessage('Quantity must be between 1 and 10,000')
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
    .notEmpty().withMessage('Delivery address is required when delivery method is delivery')
    .isLength({ max: 1000 }).withMessage('Delivery address cannot exceed 1000 characters'),

  body('specialInstructions')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 500 }).withMessage('Special instructions cannot exceed 500 characters'),

  body('paymentMethod')
    .isIn(Object.values(PAYMENT_METHODS)).withMessage('Invalid payment method'),

  preferredDeliveryDateValidator,
  deliveryCoordinatesValidator,
  ...orderItemsValidator
];

const customerOrderValidator = [
  body('deliveryMethod')
    .isIn(['pickup', 'delivery']).withMessage('Delivery method must be pickup or delivery'),

  body('deliveryAddress')
    .if(body('deliveryMethod').equals('delivery'))
    .trim()
    .notEmpty().withMessage('Delivery address is required when delivery method is delivery')
    .isLength({ max: 1000 }).withMessage('Delivery address cannot exceed 1000 characters'),

  body('specialInstructions')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 500 }).withMessage('Special instructions cannot exceed 500 characters'),

  body('paymentMethod')
    .isIn(Object.values(PAYMENT_METHODS)).withMessage('Invalid payment method'),

  preferredDeliveryDateValidator,
  deliveryCoordinatesValidator,
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
