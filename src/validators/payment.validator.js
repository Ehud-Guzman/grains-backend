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

const refundSentValidator = [
  param('orderId').isMongoId().withMessage('Invalid order ID'),
  body('method').isIn(['mpesa', 'cash', 'bank', 'other']).withMessage('method must be mpesa, cash, bank or other'),
  // The M-Pesa receipt format is checked in the service (it is only required for method=mpesa).
  body('reference').optional({ nullable: true }).isString().withMessage('reference must be text').isLength({ max: 60 }),
  body('amount').optional({ nullable: true, checkFalsy: true }).isFloat({ min: 1 }).withMessage('amount must be at least 1'),
  body('note').optional({ nullable: true }).isString().withMessage('note must be text').isLength({ max: 300 }),
];

const resolveExceptionValidator = [
  param('paymentId').isMongoId().withMessage('Invalid payment ID'),
  body('note').isString().withMessage('note is required').trim().isLength({ min: 3, max: 300 }).withMessage('note must be 3-300 characters'),
];

module.exports = { manualConfirmPaymentValidator, refundSentValidator, resolveExceptionValidator };
