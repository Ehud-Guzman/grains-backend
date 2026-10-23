const { body } = require('express-validator');

// POST /ask takes either a typed question or the id of a topic that was tapped.
const askValidator = [
  body('q').optional().isString().trim().isLength({ min: 2, max: 300 }).withMessage('Question must be 2 to 300 characters'),
  body('topicId').optional().isString().trim().isLength({ min: 1, max: 80 }).withMessage('Invalid topic'),
  body().custom((value) => {
    if (!value || (!value.q && !value.topicId)) throw new Error('Ask a question or pick a topic');
    return true;
  }),
];

module.exports = { askValidator };
