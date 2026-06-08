const { AppError } = require('../middleware/errorHandler.middleware');

const validateReason = (reason, label = 'A reason') => {
  if (!reason || reason.trim().length < 3) {
    throw new AppError(`${label} is required (minimum 3 characters)`, 400, 'REASON_REQUIRED');
  }
};

module.exports = { validateReason };
