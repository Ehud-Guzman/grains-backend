const Branch = require('../models/Branch');
const User = require('../models/User');
const { AppError } = require('../middleware/errorHandler.middleware');
const activityLogService = require('./activityLog.service');
const { invalidateDefaultBranchCache } = require('./defaultBranch.service');

// ── GET ALL BRANCHES ──────────────────────────────────────────────────────────
const getAll = async (includeInactive = false) => {
  const query = includeInactive ? {} : { isActive: true };
  return Branch.find(query).sort({ name: 1 }).lean();
};

// ── GET SINGLE BRANCH ─────────────────────────────────────────────────────────
const getById = async (branchId) => {
  const branch = await Branch.findById(branchId).lean();
  if (!branch) throw new AppError('Branch not found', 404, 'BRANCH_NOT_FOUND');
  return branch;
};

// ── CREATE BRANCH ─────────────────────────────────────────────────────────────
const create = async (data, adminId) => {
  const existing = await Branch.findOne({ slug: data.slug });
  if (existing) throw new AppError('A branch with this slug already exists', 409, 'SLUG_TAKEN');

  // If this is the first branch, make it default
  const count = await Branch.countDocuments();
  const isDefault = count === 0 ? true : (data.isDefault || false);

  // If setting as default, unset any existing default
  if (isDefault) {
    await Branch.updateMany({ isDefault: true }, { isDefault: false });
  }

  const branch = await Branch.create({ ...data, isDefault });

  await activityLogService.log({
    actorId: adminId,
    actorRole: 'superadmin',
    action: 'BRANCH_CREATED',
    targetId: branch._id,
    targetType: 'Branch',
    detail: { name: branch.name, slug: branch.slug }
  });

  invalidateDefaultBranchCache();
  return branch;
};

// ── UPDATE BRANCH ─────────────────────────────────────────────────────────────
const update = async (branchId, data, adminId) => {
  const branch = await Branch.findById(branchId);
  if (!branch) throw new AppError('Branch not found', 404, 'BRANCH_NOT_FOUND');

  if (data.slug && data.slug !== branch.slug) {
    const existing = await Branch.findOne({ slug: data.slug, _id: { $ne: branchId } });
    if (existing) throw new AppError('A branch with this slug already exists', 409, 'SLUG_TAKEN');
  }

  // If setting as default, unset any existing default
  if (data.isDefault === true) {
    await Branch.updateMany({ _id: { $ne: branchId }, isDefault: true }, { isDefault: false });
  }

  Object.assign(branch, data);
  await branch.save();

  await activityLogService.log({
    actorId: adminId,
    actorRole: 'superadmin',
    action: 'BRANCH_UPDATED',
    targetId: branch._id,
    targetType: 'Branch',
    detail: { name: branch.name, updatedFields: Object.keys(data) }
  });

  invalidateDefaultBranchCache();
  return branch;
};

// ── DEACTIVATE BRANCH ─────────────────────────────────────────────────────────
const deactivate = async (branchId, adminId) => {
  const branch = await Branch.findById(branchId);
  if (!branch) throw new AppError('Branch not found', 404, 'BRANCH_NOT_FOUND');
  if (branch.isDefault) throw new AppError('Cannot deactivate the default branch. Set another branch as default first.', 409, 'CANNOT_DEACTIVATE_DEFAULT');

  branch.isActive = false;
  await branch.save();

  await activityLogService.log({
    actorId: adminId,
    actorRole: 'superadmin',
    action: 'BRANCH_DEACTIVATED',
    targetId: branch._id,
    targetType: 'Branch',
    detail: { name: branch.name }
  });

  invalidateDefaultBranchCache();
  return branch;
};

// ── GET BRANCH STAFF ──────────────────────────────────────────────────────────
const getStaff = async (branchId) => {
  await getById(branchId); // throws if not found
  return User.find({ branchId, role: { $in: ['staff', 'supervisor', 'admin'] } })
    .select('name phone email role lastLoginAt isLocked')
    .lean();
};

// ── ASSIGN USER TO BRANCH ─────────────────────────────────────────────────────
const assignUser = async (userId, branchId, adminId) => {
  const [user, branch] = await Promise.all([
    User.findById(userId),
    Branch.findById(branchId)
  ]);

  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');
  if (!branch) throw new AppError('Branch not found', 404, 'BRANCH_NOT_FOUND');
  if (user.role === 'superadmin') throw new AppError('Superadmin cannot be assigned to a branch', 400, 'INVALID_OPERATION');

  user.branchId = branchId;
  await user.save();

  await activityLogService.log({
    actorId: adminId,
    actorRole: 'superadmin',
    action: 'USER_BRANCH_ASSIGNED',
    targetId: userId,
    targetType: 'User',
    detail: { userName: user.name, branchName: branch.name }
  });

  return user;
};

module.exports = { getAll, getById, create, update, deactivate, getStaff, assignUser };
