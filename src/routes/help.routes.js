const express = require('express');
const router = express.Router();
const { forAudience, asCustomerOrGuest } = require('../controllers/assistant.controller');
const { askValidator } = require('../validators/assistant.validator');
const { optionalAuth } = require('../middleware/auth.middleware');
const { helpLimiter } = require('../middleware/rateLimit.middleware');
const { validate } = require('../middleware/validate.middleware');

// The storefront help assistant. Open to everyone: a visitor who has not signed in is told
// which things need an account, a signed-in customer gets the full answer.
const help = forAudience('customer', asCustomerOrGuest);

router.use(optionalAuth, helpLimiter);

router.get('/topics', help.topics);
router.post('/ask', askValidator, validate, help.ask);

module.exports = router;
