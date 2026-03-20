const userService = require('../../services/user.service');
const { success, paginated } = require('../../utils/apiResponse');

const getAll = async (req, res, next) => {
  try {
    const result = await userService.getAllAdminUsers(req.query, req.query);
    return paginated(res, result.users, result.pagination);
  } catch (err) { next(err); }
};

const create = async (req, res, next) => {
  try {
    const { name, phone, email, password, role } = req.body;
    const user = await userService.createAdminUser({ name, phone, email, password, role }, req.user.id);
    return success(res, user, 'Admin account created', 201);
  } catch (err) { next(err); }
};

const changeRole = async (req, res, next) => {
  try {
    const result = await userService.changeRole(req.params.id, req.body.role, req.user.id);
    return success(res, result, `Role updated to ${req.body.role}`);
  } catch (err) { next(err); }
};

const lockAccount = async (req, res, next) => {
  try {
    const result = await userService.lockAdminAccount(req.params.id, req.user.id);
    return success(res, result, 'Account locked');
  } catch (err) { next(err); }
};

const unlockAccount = async (req, res, next) => {
  try {
    const result = await userService.unlockAdminAccount(req.params.id, req.user.id);
    return success(res, result, 'Account unlocked');
  } catch (err) { next(err); }
};

const resetPassword = async (req, res, next) => {
  try {
    const result = await userService.resetPassword(req.params.id, req.body.password, req.user.id);
    return success(res, result, 'Password reset successfully');
  } catch (err) { next(err); }
};

module.exports = { getAll, create, changeRole, lockAccount, unlockAccount, resetPassword };
