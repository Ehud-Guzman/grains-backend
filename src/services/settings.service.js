const Settings = require('../models/Settings');
const activityLogService = require('./activityLog.service');

// ── IN-MEMORY CACHE (per branch) ──────────────────────────────────────────────
const _cache = new Map(); // branchId => settings

const invalidateCache = (branchId) => {
  if (branchId) {
    _cache.delete(String(branchId));
  } else {
    _cache.clear(); // clear all if no branchId given
  }
};

// ── GET SETTINGS ──────────────────────────────────────────────────────────────
const getSettings = async (branchId) => {
  if (!branchId) throw new Error('branchId is required to get settings');

  const key = String(branchId);
  if (_cache.has(key)) return _cache.get(key);

  const settingsId = `settings_${branchId}`;
  let settings = await Settings.findById(settingsId).lean();

  if (!settings) {
    // First boot for this branch — create with defaults
    settings = await Settings.create({ _id: settingsId, branchId });
    settings = settings.toObject();
  }

  _cache.set(key, settings);
  return settings;
};

// ── GET PUBLIC SETTINGS ───────────────────────────────────────────────────────
// Only shop info — safe to expose to frontend without auth
const getPublicSettings = async (branchId) => {
  const s = await getSettings(branchId);
  return {
    shopName:     s.shopName,
    shopTagline:  s.shopTagline,
    shopPhone:    s.shopPhone,
    shopPhones:   s.shopPhones || [],
    shopEmail:    s.shopEmail,
    shopHours:    s.shopHours,
    shopLocation: s.shopLocation,
    shopWhatsapp: s.shopWhatsapp,
    deliveryFee:  s.deliveryFee,
    minimumOrderValue: s.minimumOrderValue,
    minimumOrderQuantity: s.minimumOrderQuantity || 0,
    allowGuestOrders:  s.allowGuestOrders,
    allowCashOnDelivery: s.allowCashOnDelivery,
    allowPayOnPickup:  s.allowPayOnPickup,
    allowMpesa:        s.allowMpesa,
    maintenanceMode:   s.maintenanceMode,
    maintenanceMessage: s.maintenanceMessage,
    // Delivery pricing mode — needed so checkout can decide whether to request geolocation
    deliveryPricingMode: s.deliveryPricingMode || 'flat',
    // Expose whether branch has coordinates configured (not the coords themselves)
    hasDeliveryZones: s.deliveryPricingMode === 'distance' &&
      s.deliveryZones?.length > 0 &&
      s.branchLat != null && s.branchLng != null,
    // Tax — vatEnabled/vatRate needed for checkout VAT preview
    vatEnabled: s.vatEnabled === true,
    vatRate:    s.vatRate != null ? Number(s.vatRate) : 16,
    // kraPin and receiptFooterNote are omitted — fetched via authenticated /api/settings/receipt
    // Loyalty programme thresholds (needed by customer dashboard)
    loyaltyEnabled:         s.loyaltyEnabled !== false,
    loyaltyBronzeThreshold: s.loyaltyBronzeThreshold ?? 5000,
    loyaltySilverThreshold: s.loyaltySilverThreshold ?? 25000,
    loyaltyGoldThreshold:   s.loyaltyGoldThreshold   ?? 75000,
    priceAlertThresholdPct: s.priceAlertThresholdPct ?? 5,
  };
};

// ── UPDATE SETTINGS ───────────────────────────────────────────────────────────
const updateSettings = async (data, adminId, adminRole, branchId) => {
  if (!branchId) throw new Error('branchId is required to update settings');

  // SuperAdmin-only fields
  const superAdminFields = [
    'maintenanceMode', 'maintenanceMessage',
    'platformLocked', 'allowNewAdminAccounts',
    'maxProductsPerBranch', 'maxStaffPerBranch', 'logRetentionDays',
  ];
  if (adminRole !== 'superadmin') {
    superAdminFields.forEach(f => delete data[f]);
  }

  delete data._id;
  delete data.branchId;
  delete data.updatedBy;

  const settingsId = `settings_${branchId}`;
  const settings = await Settings.findByIdAndUpdate(
    settingsId,
    { ...data, branchId, updatedAt: new Date(), updatedBy: adminId },
    { new: true, upsert: true, runValidators: true }
  );

  invalidateCache(branchId);

  await activityLogService.log({
    actorId: adminId,
    actorRole: adminRole,
    action: 'SETTINGS_UPDATED',
    branchId,
    targetId: null,
    targetType: 'Settings',
    detail: { updatedFields: Object.keys(data) },
  });

  return settings;
};

module.exports = { getSettings, getPublicSettings, updateSettings, invalidateCache };
