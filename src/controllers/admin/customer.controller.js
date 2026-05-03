const customerService = require('../../services/customer.service');
const { success } = require('../../utils/apiResponse');

const lockAccount = async (req, res, next) => {
  try {
    const result = await customerService.lockCustomer(req.params.id, req.user.id, req.user.role);
    return success(res, result, 'Customer account locked');
  } catch (err) { next(err); }
};

const unlockAccount = async (req, res, next) => {
  try {
    const result = await customerService.unlockCustomer(req.params.id, req.user.id, req.user.role);
    return success(res, result, 'Customer account unlocked');
  } catch (err) { next(err); }
};

const getAll = async (req, res, next) => {
  try {
    const pagination = { page: req.query.page, limit: req.query.limit };
    const result = await customerService.getAll(req.query, pagination);
    return success(res, result);
  } catch (err) { next(err); }
};

const getProfile = async (req, res, next) => {
  try {
    const profile = await customerService.getProfile(req.params.id);
    return success(res, profile);
  } catch (err) { next(err); }
};

const addNote = async (req, res, next) => {
  try {
    const result = await customerService.addNote(req.params.id, req.body.note, req.user.id, req.user.role);
    return success(res, result, 'Note added');
  } catch (err) { next(err); }
};

const getSegments = async (req, res, next) => {
  try {
    const segments = await customerService.getSegments();
    return success(res, segments);
  } catch (err) { next(err); }
};

module.exports = { getAll, getProfile, addNote, getSegments, lockAccount, unlockAccount };
