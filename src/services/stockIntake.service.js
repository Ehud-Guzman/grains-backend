const mongoose = require('mongoose');
const StockIntake = require('../models/StockIntake');
const { AppError } = require('../middleware/errorHandler.middleware');
const activityLogService = require('./activityLog.service');
const { LOG_ACTIONS } = require('../utils/constants');
const { paginate, buildPaginationMeta } = require('../utils/paginate');
const generateIntakeRef = require('../utils/generateIntakeRef');

// ── CREATE ────────────────────────────────────────────────────────────────────
const create = async (data, userId, branchId) => {
  const { supplier, vehicleRef, arrivedAt, notes, items } = data;

  const intakeRef = await generateIntakeRef(branchId);

  const intake = await StockIntake.create({
    intakeRef,
    branchId,
    supplier:   supplier.trim(),
    vehicleRef: vehicleRef?.trim() || '',
    arrivedAt:  new Date(arrivedAt),
    notes:      notes?.trim() || '',
    items:      items.map(i => ({
      description: i.description.trim(),
      quantity:    Number(i.quantity),
      unit:        i.unit?.trim() || 'bags',
      notes:       i.notes?.trim() || '',
    })),
    status:    'pending',
    createdBy: userId,
  });

  await activityLogService.log({
    actorId:    userId,
    actorRole:  'supervisor',
    action:     LOG_ACTIONS.INTAKE_LOGGED,
    branchId,
    targetId:   intake._id,
    targetType: 'StockIntake',
    detail: {
      intakeRef,
      supplier,
      vehicleRef,
      itemCount: items.length,
      arrivedAt,
    },
  });

  return intake;
};

// ── LIST ─────────────────────────────────────────────────────────────────────
const list = async (filters = {}, query = {}, branchId) => {
  const { page, limit, skip } = paginate(query);

  const match = { branchId: new mongoose.Types.ObjectId(branchId) };

  if (filters.status && ['pending', 'processed'].includes(filters.status)) {
    match.status = filters.status;
  }

  if (filters.search) {
    const re = new RegExp(filters.search.trim(), 'i');
    match.$or = [
      { intakeRef:  re },
      { supplier:   re },
      { vehicleRef: re },
    ];
  }

  if (filters.from || filters.to) {
    match.arrivedAt = {};
    if (filters.from) match.arrivedAt.$gte = new Date(filters.from);
    if (filters.to)   match.arrivedAt.$lte = new Date(filters.to);
  }

  const [total, records] = await Promise.all([
    StockIntake.countDocuments(match),
    StockIntake.find(match)
      .populate('createdBy',   'name role')
      .populate('processedBy', 'name role')
      .sort({ arrivedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  return { records, pagination: buildPaginationMeta(page, limit, total) };
};

// ── GET ONE ──────────────────────────────────────────────────────────────────
const getOne = async (id, branchId) => {
  const intake = await StockIntake.findOne({
    _id:      id,
    branchId: new mongoose.Types.ObjectId(branchId),
  })
    .populate('createdBy',   'name role')
    .populate('processedBy', 'name role')
    .lean();

  if (!intake) throw new AppError('Intake record not found', 404, 'INTAKE_NOT_FOUND');

  return intake;
};

// ── MARK PROCESSED ───────────────────────────────────────────────────────────
const markProcessed = async (id, userId, branchId, processedNotes = '') => {
  const intake = await StockIntake.findOne({
    _id:      id,
    branchId: new mongoose.Types.ObjectId(branchId),
  });

  if (!intake) throw new AppError('Intake record not found', 404, 'INTAKE_NOT_FOUND');
  if (intake.status === 'processed') {
    throw new AppError('This intake has already been processed', 409, 'ALREADY_PROCESSED');
  }

  intake.status         = 'processed';
  intake.processedAt    = new Date();
  intake.processedBy    = userId;
  intake.processedNotes = processedNotes?.trim() || '';
  await intake.save();

  await activityLogService.log({
    actorId:    userId,
    actorRole:  'supervisor',
    action:     LOG_ACTIONS.INTAKE_PROCESSED,
    branchId,
    targetId:   intake._id,
    targetType: 'StockIntake',
    detail: {
      intakeRef:      intake.intakeRef,
      supplier:       intake.supplier,
      itemCount:      intake.items.length,
      processedNotes: processedNotes || '',
    },
  });

  return intake;
};

// ── DELETE ────────────────────────────────────────────────────────────────────
// Only allowed while status is 'pending' — once processed it becomes audit trail
const remove = async (id, userId, branchId) => {
  const intake = await StockIntake.findOne({
    _id:      id,
    branchId: new mongoose.Types.ObjectId(branchId),
  });

  if (!intake) throw new AppError('Intake record not found', 404, 'INTAKE_NOT_FOUND');
  if (intake.status === 'processed') {
    throw new AppError('Processed intake records cannot be deleted', 409, 'INTAKE_PROCESSED');
  }

  await StockIntake.deleteOne({ _id: id });

  await activityLogService.log({
    actorId:    userId,
    actorRole:  'supervisor',
    action:     LOG_ACTIONS.INTAKE_DELETED,
    branchId,
    targetId:   intake._id,
    targetType: 'StockIntake',
    detail: { intakeRef: intake.intakeRef, supplier: intake.supplier },
  });
};

// ── SUMMARY (for dashboard widgets) ─────────────────────────────────────────
const getPendingCount = async (branchId) => {
  return StockIntake.countDocuments({
    branchId: new mongoose.Types.ObjectId(branchId),
    status:   'pending',
  });
};

module.exports = { create, list, getOne, markProcessed, remove, getPendingCount };
