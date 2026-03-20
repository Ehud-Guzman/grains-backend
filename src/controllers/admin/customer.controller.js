const customerService = require('../../services/customer.service');
const { success } = require('../../utils/apiResponse');

const getAll = async (req, res, next) => {
  try {
    const result = await customerService.getAll(req.query, req.query);
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
    const result = await customerService.addNote(req.params.id, req.body.note, req.user.id);
    return success(res, result, 'Note added');
  } catch (err) { next(err); }
};

const getSegments = async (req, res, next) => {
  try {
    const segments = await customerService.getSegments();
    return success(res, segments);
  } catch (err) { next(err); }
};

module.exports = { getAll, getProfile, addNote, getSegments };
