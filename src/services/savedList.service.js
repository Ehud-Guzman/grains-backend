const SavedList = require('../models/SavedList');
const { AppError } = require('../middleware/errorHandler.middleware');

const getMyLists = async (userId) => {
  return SavedList.find({ userId }).sort({ updatedAt: -1 }).lean();
};

const getListById = async (listId, userId) => {
  const list = await SavedList.findOne({ _id: listId, userId }).lean();
  if (!list) throw new AppError('List not found', 404, 'NOT_FOUND');
  return list;
};

const createList = async (userId, { name, items = [] }) => {
  if (!name?.trim()) throw new AppError('List name is required', 400, 'VALIDATION_ERROR');
  const count = await SavedList.countDocuments({ userId });
  if (count >= 20) throw new AppError('Maximum 20 saved lists allowed', 400, 'LIMIT_REACHED');
  return SavedList.create({ userId, name: name.trim(), items });
};

const updateList = async (listId, userId, { name, items }) => {
  const list = await SavedList.findOne({ _id: listId, userId });
  if (!list) throw new AppError('List not found', 404, 'NOT_FOUND');
  if (name !== undefined) list.name = name.trim();
  if (items !== undefined) list.items = items;
  await list.save();
  return list;
};

const deleteList = async (listId, userId) => {
  const result = await SavedList.deleteOne({ _id: listId, userId });
  if (!result.deletedCount) throw new AppError('List not found', 404, 'NOT_FOUND');
  return { deleted: true };
};

module.exports = { getMyLists, getListById, createList, updateList, deleteList };
