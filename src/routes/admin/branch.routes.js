const express = require('express');
const router = express.Router();
const branchController = require('../../controllers/admin/branch.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireSuperadminOrPermission } = require('../../middleware/role.middleware');
const { PERMISSIONS } = require('../../utils/constants');
const { validate } = require('../../middleware/validate.middleware');
const {
  createBranchValidator,
  updateBranchValidator,
  assignUserToBranchValidator
} = require('../../validators/branch.validator');

// Superadmin-only OR users explicitly granted manage_branches permission
router.use(verifyToken, requireSuperadminOrPermission(PERMISSIONS.MANAGE_BRANCHES));

// GET  /api/admin/branches
router.get('/', branchController.getAll);

// GET  /api/admin/branches/:id
router.get('/:id', branchController.getOne);

// POST /api/admin/branches
router.post('/', createBranchValidator, validate, branchController.create);

// PUT  /api/admin/branches/:id
router.put('/:id', updateBranchValidator, validate, branchController.update);

// DELETE /api/admin/branches/:id  (soft-deactivate)
router.delete('/:id', branchController.deactivate);

// GET  /api/admin/branches/:id/staff
router.get('/:id/staff', branchController.getStaff);

// POST /api/admin/branches/:id/assign-user
router.post('/:id/assign-user', assignUserToBranchValidator, validate, branchController.assignUser);

module.exports = router;
