const Settings = require('../models/Settings');
const activityLogService = require('./activityLog.service');

// ── IN-MEMORY CACHE ───────────────────────────────────────────────────────────
let _cache = null;

const invalidateCache = () => { _cache = null; };

// ── GET SETTINGS ──────────────────────────────────────────────────────────────
// Creates the default document if it doesn't exist yet (first run)
const getSettings = async () => {
  if (_cache) return _cache;

  let settings = await Settings.findById('app_settings').lean();

  if (!settings) {
    // First boot — create defaults
    settings = await Settings.create({ _id: 'app_settings' });
    settings = settings.toObject();
  }

  _cache = settings;
  return settings;
};

// ── GET PUBLIC SETTINGS ───────────────────────────────────────────────────────
// Only shop info — safe to expose to frontend without auth
const getPublicSettings = async () => {
  const s = await getSettings();
  return {
    shopName:     s.shopName,
    shopTagline:  s.shopTagline,
    shopPhone:    s.shopPhone,
    shopEmail:    s.shopEmail,
    shopHours:    s.shopHours,
    shopLocation: s.shopLocation,
    shopWhatsapp: s.shopWhatsapp,
    deliveryFee:  s.deliveryFee,
    minimumOrderValue: s.minimumOrderValue,
    allowGuestOrders:  s.allowGuestOrders,
    allowCashOnDelivery: s.allowCashOnDelivery,
    allowPayOnPickup:  s.allowPayOnPickup,
    allowMpesa:        s.allowMpesa,
    maintenanceMode:   s.maintenanceMode,
    maintenanceMessage: s.maintenanceMessage,
  };
};

// ── UPDATE SETTINGS ───────────────────────────────────────────────────────────
const updateSettings = async (data, adminId, adminRole) => {
  // SuperAdmin-only fields
  const superAdminFields = ['maintenanceMode', 'maintenanceMessage'];

  if (adminRole !== 'superadmin') {
    superAdminFields.forEach(f => delete data[f]);
  }

  // Never allow these to be set via this endpoint
  delete data._id;
  delete data.updatedBy;

  const settings = await Settings.findByIdAndUpdate(
    'app_settings',
    { ...data, updatedAt: new Date(), updatedBy: adminId },
    { new: true, upsert: true, runValidators: true }
  );

  invalidateCache();

  await activityLogService.log({
    actorId: adminId,
    actorRole: adminRole,
    action: 'SETTINGS_UPDATED',
    targetId: null,
    targetType: 'Settings',
    detail: { updatedFields: Object.keys(data) },
  });

  return settings;
};

module.exports = { getSettings, getPublicSettings, updateSettings, invalidateCache };