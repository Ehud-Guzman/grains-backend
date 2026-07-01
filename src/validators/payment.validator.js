const { body, param } = require('express-validator');

const manualConfirmPaymentValidator = [
  param('orderId')
    .isMongoId().withMessage('Invalid order ID'),

  // Required only for M-Pesa orders; cash orders omit it and the service handles the distinction
  body('transactionRef')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .matches(/^[A-Z0-9]{10}$/).withMessage('transactionRef must be 10 uppercase alphanumeric characters (e.g. QDK14KSHD7)'),

  // Cash/pickup orders: optional amount actually received, used to flag discrepancies
  body('receivedAmount')
    .optional({ nullable: true })
    .isNumeric().withMessage('receivedAmount must be a number')
    .isFloat({ min: 0 }).withMessage('receivedAmount must be non-negative'),
];

module.exports = { manualConfirmPaymentValidator };
