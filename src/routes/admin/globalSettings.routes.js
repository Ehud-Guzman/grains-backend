// ── GLOBAL SETTINGS ROUTES ────────────────────────────────────────────────────
// Superadmin-only, OR users explicitly granted the manage_etims permission —
// credentials and role gates for system-wide features (eTIMS).

const express    = require('express');
const router     = express.Router();
const { body }   = require('express-validator');
const controller = require('../../controllers/admin/globalSettings.controller');
const { verifyToken }   = require('../../middleware/auth.middleware');
const { requireSuperadminOrPermission } = require('../../middleware/role.middleware');
const { adminLimiter }  = require('../../middleware/rateLimit.middleware');
const { validate }      = require('../../middleware/validate.middleware');
const { PERMISSIONS }   = require('../../utils/constants');

const ALLOWED_ROLES = ['staff', 'supervisor', 'admin', 'superadmin'];

router.use(verifyToken, adminLimiter, requireSuperadminOrPermission(PERMISSIONS.MANAGE_ETIMS));

// GET  /api/admin/global-settings
router.get('/', controller.get);

// PUT  /api/admin/global-settings
router.put('/', [
  body('enabled').optional().isBoolean().withMessage('enabled must be a boolean'),
  body('baseUrl').optional({ nullable: true }).trim()
    .isURL({ require_tld: false }).withMessage('baseUrl must be a valid URL'),
  body('tin').optional({ nullable: true }).trim()
    .matches(/^[A-Z]\d{9}[A-Z]$/).withMessage('TIN must be a valid KRA PIN (e.g. P051234567X)'),
  body('bhfId').optional({ nullable: true }).trim(),
  body('deviceId').optional({ nullable: true }).trim(),
  body('allowedRoles').optional().isArray().withMessage('allowedRoles must be an array'),
  body('allowedRoles.*').isIn(ALLOWED_ROLES).withMessage(`Each role must be one of: ${ALLOWED_ROLES.join(', ')}`),
], validate, controller.update);

module.exports = router;
