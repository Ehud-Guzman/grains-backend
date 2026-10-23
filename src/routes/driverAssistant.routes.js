const express = require('express');
const router = express.Router();
const { forAudience } = require('../controllers/assistant.controller');
const { askValidator } = require('../validators/assistant.validator');
const { verifyToken } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { adminLimiter } = require('../middleware/rateLimit.middleware');
const { validate } = require('../middleware/validate.middleware');

// The help assistant for drivers. Reads only — it is deliberately not behind the branch
// write-lock that guards the rest of the driver portal, so a driver can still ask how to
// handle a delivery while the branch is locked.
const help = forAudience('driver');

router.use(verifyToken, requireRole('driver'), adminLimiter);

router.get('/topics', help.topics);
router.post('/ask', askValidator, validate, help.ask);

module.exports = router;
