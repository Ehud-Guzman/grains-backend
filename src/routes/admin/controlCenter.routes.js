const express = require('express');
const router = express.Router();
const { body, param, query } = require('express-validator');
const controller = require('../../controllers/admin/controlCenter.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');
const { validate } = require('../../middleware/validate.middleware');
const { JOB_NAMES } = require('../../services/jobControl.service');

// The Control Center. Superadmin only — everything under here is protected before it is
// written. Deliberately NOT behind checkPlatformLock: the lever that locks a branch must
// still work (and, above all, un-lock it) while the branch is locked.
router.use(verifyToken, requireRole('superadmin'), adminLimiter);

const idParam = param('id').isMongoId().withMessage('Invalid id');

// --- the first screen ---------------------------------------------------------
router.get('/overview', controller.overview);

// --- accounts and sessions ----------------------------------------------------
router.get('/accounts', controller.listAccounts);
router.post('/accounts/sign-out-all',
  [body('scope').optional().isIn(['staff', 'everyone']).withMessage('scope must be "staff" or "everyone"')],
  validate, controller.signOutAll);
router.post('/accounts/:id/sign-out', [idParam], validate, controller.signOutAccount);

// --- switches and jobs --------------------------------------------------------
router.put('/branches/:branchId/switches',
  [param('branchId').isMongoId().withMessage('Invalid branch id')],
  validate, controller.setBranchSwitches);
router.put('/lock-all',
  [body('locked').isBoolean().withMessage('locked must be true or false')],
  validate, controller.setLockAll);
router.put('/jobs/:name',
  [param('name').isIn(JOB_NAMES).withMessage('Unknown job'), body('paused').isBoolean().withMessage('paused must be true or false')],
  validate, controller.setJobPaused);

// --- security and audit -------------------------------------------------------
router.get('/security', [query('days').optional().isInt({ min: 1, max: 90 })], validate, controller.securityFeed);
router.get('/audit/export', controller.exportAudit);
router.get('/audit/:id', [idParam], validate, controller.rawEntry);

// --- health checks ------------------------------------------------------------
router.get('/integrity', controller.integrityScan);
router.get('/permissions', controller.permissions);

module.exports = router;
