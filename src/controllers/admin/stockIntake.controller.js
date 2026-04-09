const stockIntakeService = require('../../services/stockIntake.service');
const { success, paginated } = require('../../utils/apiResponse');

const create = async (req, res, next) => {
  try {
    const intake = await stockIntakeService.create(req.body, req.user.id, req.branchId);
    return success(res, intake, 'Intake record created', 201);
  } catch (err) { next(err); }
};

const list = async (req, res, next) => {
  try {
    const { status, search, from, to, page, limit } = req.query;
    const result = await stockIntakeService.list(
      { status, search, from, to },
      { page, limit },
      req.branchId
    );
    return paginated(res, result.records, result.pagination);
  } catch (err) { next(err); }
};

const getOne = async (req, res, next) => {
  try {
    const intake = await stockIntakeService.getOne(req.params.id, req.branchId);
    return success(res, intake);
  } catch (err) { next(err); }
};

const markProcessed = async (req, res, next) => {
  try {
    const intake = await stockIntakeService.markProcessed(
      req.params.id,
      req.user.id,
      req.branchId,
      req.body.processedNotes
    );
    return success(res, intake, 'Intake marked as processed');
  } catch (err) { next(err); }
};

const remove = async (req, res, next) => {
  try {
    await stockIntakeService.remove(req.params.id, req.user.id, req.branchId);
    return success(res, null, 'Intake record deleted');
  } catch (err) { next(err); }
};

module.exports = { create, list, getOne, markProcessed, remove };
