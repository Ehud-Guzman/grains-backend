const { body, param } = require('express-validator');

const manualConfirmPaymentValidator = [
  param('orderId')
    .isMongoId().withMessage('Invalid order ID'),

  body('transactionRef')
    .trim()
    .notEmpty().withMessage('transactionRef is required')
    .matches(/^[A-Z0-9]{10}$/).withMessage('transactionRef must be 10 uppercase alphanumeric characters')
];

module.exports = { manualConfirmPaymentValidator };
