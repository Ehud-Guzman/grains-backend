const mongoose = require('mongoose');
const Branch = require('../models/Branch');
const User = require('../models/User');
const { AppError } = require('../middleware/errorHandler.middleware');
const activityLogService = require('./activityLog.service');
const { invalidateDefaultBranchCache, getDefaultBranch } = require('./defaultBranch.service');
const settingsService = require('./settings.service');
const haversine = require('../utils/haversine');
const { escapeRegex } = require('../utils/escapeRegex');
const { LOG_ACTIONS } = require('../utils/constants');
const { bumpTokenValidAfter } = require('../utils/tokenValidAfter');

// ── GET ALL BRANCHES ──────────────────────────────────────────────────────────
const getAll = async (includeInactive = false) => {
  const query = includeInactive ? {} : { isActive: true };
  return Branch.find(query).sort({ name: 1 }).lean();
};

// ── PUBLIC: LIST ACTIVE BRANCHES (storefront picker) ─────────────────────────
// Only safe-to-expose fields — no staff data, no internal config.
const getPublicBranches = async () => {
  return Branch.find({ isActive: true })
    .select('name slug location isDefault')
    .sort({ name: 1 })
    .lean();
};

// ── PUBLIC: FIND NEAREST BRANCH ───────────────────────────────────────────────
// Location-driven fulfilment: given customer coordinates, pick the branch that
// will serve them. Rules:
//   1. Prefer the nearest branch that can DELIVER to the customer
//      (has coordinates configured, and distance <= its maxDeliveryKm if set).
//   2. If no branch can deliver, return the nearest branch with coordinates —
//      flagged deliveryAvailable: false so the UI offers pickup only.
//   3. If no branch has coordinates configured at all, fall back to the
//      default branch (same behaviour as before this feature existed).
// Returns { branch, distanceKm, deliveryAvailable, resolvedBy }.
const findNearestBranch = async (lat, lng) => {
  const branches = await Branch.find({ isActive: true })
    .select('name slug location isDefault')
    .lean();

  const candidates = [];
  for (const branch of branches) {
    // Settings are cached per branch, so this loop is cheap after the first call
    const settings = await settingsService.getSettings(branch._id);
    if (settings.branchLat == null || settings.branchLng == null) continue;

    const distanceKm = haversine(settings.branchLat, settings.branchLng, lat, lng);
    candidates.push({
      branch,
      distanceKm: Math.round(distanceKm * 10) / 10,
      deliveryAvailable: settings.maxDeliveryKm == null || distanceKm <= settings.maxDeliveryKm
    });
  }

  if (candidates.length === 0) {
    const fallback = await getDefaultBranch();
    if (!fallback) throw new AppError('No branches available', 404, 'NO_BRANCHES');
    return {
      branch: { _id: fallback._id, name: fallback.name, slug: fallback.slug, location: fallback.location, isDefault: fallback.isDefault },
      distanceKm: null,
      deliveryAvailable: true,
      resolvedBy: 'default' // no branch has coordinates configured
    };
  }

  candidates.sort((a, b) => a.distanceKm - b.distanceKm);
  const deliverable = candidates.find(c => c.deliveryAvailable);
  const chosen = deliverable || candidates[0];

  return { ...chosen, resolvedBy: deliverable ? 'nearest-deliverable' : 'nearest-pickup-only' };
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

  const nameTaken = await Branch.findOne({ name: new RegExp(`^${escapeRegex(data.name)}$`, 'i') });
  if (nameTaken) throw new AppError('A branch with this name already exists', 409, 'NAME_TAKEN');

  const session = await mongoose.startSession();
  session.startTransaction();
  let branch;
  try {
    // If this is the first branch, make it default
    const count = await Branch.countDocuments().session(session);
    const isDefault = count === 0 ? true : (data.isDefault || false);

    // If setting as default, unset any existing default — same transaction so a
    // crash mid-swap can never leave the system with zero default branches.
    if (isDefault) {
      await Branch.updateMany({ isDefault: true }, { isDefault: false }, { session });
    }

    [branch] = await Branch.create([{ ...data, isDefault }], { session });
    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }

  await activityLogService.log({
    actorId: adminId,
    actorRole: 'superadmin',
    action: LOG_ACTIONS.BRANCH_CREATED,
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

  // Deactivating the default branch must always go through deactivate() — never
  // let it happen silently as a side effect of an unrelated field edit.
  if (data.isActive === false && branch.isDefault) {
    throw new AppError('Cannot deactivate the default branch. Set another branch as default first.', 409, 'CANNOT_DEACTIVATE_DEFAULT');
  }

  if (data.slug && data.slug !== branch.slug) {
    const existing = await Branch.findOne({ slug: data.slug, _id: { $ne: branchId } });
    if (existing) throw new AppError('A branch with this slug already exists', 409, 'SLUG_TAKEN');
  }

  if (data.name && data.name !== branch.name) {
    const nameTaken = await Branch.findOne({ name: new RegExp(`^${escapeRegex(data.name)}$`, 'i'), _id: { $ne: branchId } });
    if (nameTaken) throw new AppError('A branch with this name already exists', 409, 'NAME_TAKEN');
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // If setting as default, unset any existing default — same transaction as
    // the save below so a crash mid-swap can't leave zero default branches.
    if (data.isDefault === true) {
      await Branch.updateMany({ _id: { $ne: branchId }, isDefault: true }, { isDefault: false }, { session });
    }

    Object.assign(branch, data);
    await branch.save({ session });
    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }

  await activityLogService.log({
    actorId: adminId,
    actorRole: 'superadmin',
    action: LOG_ACTIONS.BRANCH_UPDATED,
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
    action: LOG_ACTIONS.BRANCH_DEACTIVATED,
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
  // Any already-issued token still embeds the OLD branchId — without bumping
  // this, refreshToken() would keep reissuing access tokens scoped to the
  // branch this user was just moved off of, silently breaking branch isolation
  // until they happen to log out. Forces their next refresh to fail and
  // re-login, which then correctly picks up the new assignment.
  user.tokenValidAfter = bumpTokenValidAfter();
  await user.save();

  await activityLogService.log({
    actorId: adminId,
    actorRole: 'superadmin',
    action: LOG_ACTIONS.USER_BRANCH_ASSIGNED,
    targetId: userId,
    targetType: 'User',
    detail: { userName: user.name, branchName: branch.name }
  });

  return user;
};

module.exports = { getAll, getById, create, update, deactivate, getStaff, assignUser, getPublicBranches, findNearestBranch };
