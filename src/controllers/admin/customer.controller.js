const customerService = require('../../services/customer.service');
const { success } = require('../../utils/apiResponse');

// Branch staff only see/act on customers who have ordered at their branch; a superadmin keeps the global view.
const scopeOf = (req) => ({ global: req.user.role === 'superadmin' });

const lockAccount = async (req, res, next) => {
  try {
    const result = await customerService.lockCustomer(req.params.id, req.user.id, req.user.role, req.branchId, scopeOf(req));
    return success(res, result, 'Customer account locked');
  } catch (err) { next(err); }
};

const unlockAccount = async (req, res, next) => {
  try {
    const result = await customerService.unlockCustomer(req.params.id, req.user.id, req.user.role, req.branchId, scopeOf(req));
    return success(res, result, 'Customer account unlocked');
  } catch (err) { next(err); }
};

const getAll = async (req, res, next) => {
  try {
    const pagination = { page: req.query.page, limit: req.query.limit };
    const result = await customerService.getAll(req.query, pagination, req.branchId, scopeOf(req));
    return success(res, result);
  } catch (err) { next(err); }
};

const getProfile = async (req, res, next) => {
  try {
    const profile = await customerService.getProfile(req.params.id, req.branchId, scopeOf(req));
    return success(res, profile);
  } catch (err) { next(err); }
};

const addNote = async (req, res, next) => {
  try {
    const result = await customerService.addNote(req.params.id, req.body.note, req.user.id, req.user.role, req.branchId, scopeOf(req));
    return success(res, result, 'Note added');
  } catch (err) { next(err); }
};

const getSegments = async (req, res, next) => {
  try {
    const segments = await customerService.getSegments(req.branchId);
    return success(res, segments);
  } catch (err) { next(err); }
};

const toggleB2B = async (req, res, next) => {
  try {
    const result = await customerService.toggleB2B(req.params.id, req.user.id, req.user.role, req.branchId, scopeOf(req));
    return success(res, result, result.isB2B ? 'Marked as B2B' : 'Removed B2B flag');
  } catch (err) { next(err); }
};

module.exports = { getAll, getProfile, addNote, getSegments, lockAccount, unlockAccount, toggleB2B };
