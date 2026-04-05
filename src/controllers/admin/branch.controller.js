const branchService = require('../../services/branch.service');
const { success } = require('../../utils/apiResponse');

const getAll = async (req, res, next) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const branches = await branchService.getAll(includeInactive);
    return success(res, branches);
  } catch (err) { next(err); }
};

const getOne = async (req, res, next) => {
  try {
    const branch = await branchService.getById(req.params.id);
    return success(res, branch);
  } catch (err) { next(err); }
};

const create = async (req, res, next) => {
  try {
    const branch = await branchService.create(req.body, req.user.id);
    return success(res, branch, 'Branch created', 201);
  } catch (err) { next(err); }
};

const update = async (req, res, next) => {
  try {
    const branch = await branchService.update(req.params.id, req.body, req.user.id);
    return success(res, branch, 'Branch updated');
  } catch (err) { next(err); }
};

const deactivate = async (req, res, next) => {
  try {
    const branch = await branchService.deactivate(req.params.id, req.user.id);
    return success(res, branch, 'Branch deactivated');
  } catch (err) { next(err); }
};

const getStaff = async (req, res, next) => {
  try {
    const staff = await branchService.getStaff(req.params.id);
    return success(res, staff);
  } catch (err) { next(err); }
};

const assignUser = async (req, res, next) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'MISSING_FIELDS', message: 'userId is required' });
    const user = await branchService.assignUser(userId, req.params.id, req.user.id);
    return success(res, user, 'User assigned to branch');
  } catch (err) { next(err); }
};

module.exports = { getAll, getOne, create, update, deactivate, getStaff, assignUser };
