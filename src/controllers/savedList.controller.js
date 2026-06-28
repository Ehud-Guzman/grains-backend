const savedListService = require('../services/savedList.service');
const { success } = require('../utils/apiResponse');

const getMyLists = async (req, res, next) => {
  try {
    const lists = await savedListService.getMyLists(req.user.id);
    return success(res, lists);
  } catch (err) { next(err); }
};

const getListById = async (req, res, next) => {
  try {
    const list = await savedListService.getListById(req.params.id, req.user.id);
    return success(res, list);
  } catch (err) { next(err); }
};

const createList = async (req, res, next) => {
  try {
    const list = await savedListService.createList(req.user.id, req.body);
    return success(res, list, 201);
  } catch (err) { next(err); }
};

const updateList = async (req, res, next) => {
  try {
    const list = await savedListService.updateList(req.params.id, req.user.id, req.body);
    return success(res, list);
  } catch (err) { next(err); }
};

const deleteList = async (req, res, next) => {
  try {
    const result = await savedListService.deleteList(req.params.id, req.user.id);
    return success(res, result);
  } catch (err) { next(err); }
};

module.exports = { getMyLists, getListById, createList, updateList, deleteList };
