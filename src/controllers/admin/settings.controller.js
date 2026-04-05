const settingsService = require('../../services/settings.service');
const { getDefaultBranch } = require('../../services/defaultBranch.service');
const { success } = require('../../utils/apiResponse');
const { AppError } = require('../../middleware/errorHandler.middleware');

// GET /api/settings  (public — uses default branch)
const getPublic = async (req, res, next) => {
  try {
    // Public shop uses the default branch (fall back to any active branch, then built-in defaults)
    const defaultBranch = await getDefaultBranch();

    if (!defaultBranch) {
      // No branches yet (first-time setup) — return built-in defaults so the frontend doesn't break
      return success(res, {
        shopName: 'Vittorios Grains & Cereals',
        shopTagline: 'Quality grains, delivered fresh',
        shopPhone: '', shopEmail: '', shopHours: '', shopLocation: '', shopWhatsapp: '',
        deliveryFee: 0, minimumOrderValue: 0,
        allowGuestOrders: true, allowCashOnDelivery: true, allowPayOnPickup: true, allowMpesa: true,
        maintenanceMode: false, maintenanceMessage: ''
      });
    }

    const settings = await settingsService.getPublicSettings(defaultBranch._id);
    return success(res, { ...settings, branchId: defaultBranch._id, branchName: defaultBranch.name });
  } catch (err) { next(err); }
};

// GET /api/admin/settings  (admin+, scoped to req.branchId)
const getAll = async (req, res, next) => {
  try {
    if (!req.branchId) throw new AppError('Branch context required', 403, 'BRANCH_REQUIRED');
    const settings = await settingsService.getSettings(req.branchId);
    return success(res, settings);
  } catch (err) { next(err); }
};

// PUT /api/admin/settings  (admin+)
const update = async (req, res, next) => {
  try {
    if (!req.branchId) throw new AppError('Branch context required', 403, 'BRANCH_REQUIRED');
    const settings = await settingsService.updateSettings(
      req.body,
      req.user.id,
      req.user.role,
      req.branchId
    );
    return success(res, settings, 'Settings updated');
  } catch (err) { next(err); }
};

// GET /api/admin/settings/branch/:branchId  (superadmin only — cross-branch read)
const getForBranch = async (req, res, next) => {
  try {
    const settings = await settingsService.getSettings(req.params.branchId);
    return success(res, settings);
  } catch (err) { next(err); }
};

// PUT /api/admin/settings/branch/:branchId  (superadmin only — cross-branch write)
const updateForBranch = async (req, res, next) => {
  try {
    const settings = await settingsService.updateSettings(
      req.body,
      req.user.id,
      'superadmin',        // always treat as superadmin — all fields allowed
      req.params.branchId
    );
    return success(res, settings, 'Branch settings updated');
  } catch (err) { next(err); }
};

module.exports = { getPublic, getAll, update, getForBranch, updateForBranch };
