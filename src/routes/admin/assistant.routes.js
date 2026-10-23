const express = require('express');
const router = express.Router();
const assistantController = require('../../controllers/admin/assistant.controller');
const { askValidator } = require('../../validators/assistant.validator');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireMinRole, requireRole } = require('../../middleware/role.middleware');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');
const { validate } = require('../../middleware/validate.middleware');

// The help assistant is for the people who sign in to the admin panel. It only ever
// explains what the caller's own role may do, so every admin role may ask.
router.use(verifyToken, requireMinRole('staff'), adminLimiter);

router.get('/topics', assistantController.topics);
router.post('/ask', askValidator, validate, assistantController.ask);

// What people asked (in any assistant) that could not be answered — the backlog of missing features and wording.
router.get('/unanswered', requireRole('superadmin'), assistantController.unanswered);

module.exports = router;
