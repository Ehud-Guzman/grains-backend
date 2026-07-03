const mongoose = require('mongoose');
const settingsService = require('../../services/settings.service');
const { getDefaultBranch } = require('../../services/defaultBranch.service');
const { calculateDeliveryFee } = require('../../services/order.service');
const { success } = require('../../utils/apiResponse');
const { AppError } = require('../../middleware/errorHandler.middleware');
const Branch = require('../../models/Branch');

// Resolve the branch for public storefront requests: an explicitly requested
// ?branchId (must be a valid, active branch) wins; otherwise the default
// branch. An invalid/inactive branchId falls back to default rather than
// erroring — the storefront must always render.
const resolvePublicBranch = async (requestedBranchId) => {
  if (requestedBranchId && mongoose.Types.ObjectId.isValid(requestedBranchId)) {
    const branch = await Branch.findOne({ _id: requestedBranchId, isActive: true })
      .select('name slug location isDefault').lean();
    if (branch) return branch;
  }
  return getDefaultBranch();
};

// GET /api/settings?branchId=…  (public — requested branch or default)
const getPublic = async (req, res, next) => {
  try {
    const defaultBranch = await resolvePublicBranch(req.query.branchId);

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
    return success(res, { ...settings, branchName: defaultBranch.name });
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

// GET /api/delivery-fee?lat=X&lng=Y  (public — uses default branch settings)
// Returns calculated fee, distance, and matched zone name for live checkout preview.
const getDeliveryFee = async (req, res, next) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);

    if (isNaN(lat) || isNaN(lng)) {
      return next(new AppError('lat and lng query parameters are required', 400, 'INVALID_COORDS'));
    }

    const branch = await resolvePublicBranch(req.query.branchId);
    if (!branch) return success(res, { fee: 0, distanceKm: null, zoneName: null });

    const settings = await settingsService.getSettings(branch._id);
    const result = calculateDeliveryFee(settings, 'delivery', { lat, lng });

    return success(res, result);
  } catch (err) { next(err); }
};

// POST /api/admin/settings/test-email
// Sends a test email through the same Gmail transport the notification
// service uses — bypasses all settings toggles.
const testEmail = async (req, res, next) => {
  try {
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      throw new AppError('GMAIL_USER or GMAIL_APP_PASSWORD not set in .env', 500, 'EMAIL_NOT_CONFIGURED');
    }

    const to = req.body.to || req.user.email;
    if (!to) throw new AppError('Provide a "to" email in the request body', 400, 'EMAIL_REQUIRED');

    const notificationService = require('../../services/notification.service');
    await notificationService.sendEmail({
      to,
      subject: 'Test Email — Grains System',
      html: '<p>This is a test email from your Grains System. If you can read this, email is configured correctly.</p>',
    });

    return success(res, { to }, 'Test email sent successfully');
  } catch (err) { next(err); }
};

// GET /api/settings/receipt  (requires auth — any role)
const getReceiptConfig = async (req, res, next) => {
  try {
    let branchId = req.branchId;
    if (!branchId) {
      const defaultBranch = await getDefaultBranch();
      if (!defaultBranch) return success(res, { kraPin: '', receiptFooterNote: '' });
      branchId = defaultBranch._id;
    }
    const s = await settingsService.getSettings(branchId);
    return success(res, { kraPin: s.kraPin || '', receiptFooterNote: s.receiptFooterNote || '' });
  } catch (err) { next(err); }
};

module.exports = { getPublic, getDeliveryFee, getAll, update, getForBranch, updateForBranch, testEmail, getReceiptConfig };
