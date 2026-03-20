const { validationResult } = require('express-validator');

// Runs after express-validator checks, returns 400 if any errors found
const validate = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: errors.array()[0].msg, // return first error only
      errors: errors.array()
    });
  }

  next();
};

module.exports = { validate };
