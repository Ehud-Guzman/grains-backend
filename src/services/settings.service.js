const Settings = require('../models/Settings');
const activityLogService = require('./activityLog.service');

// ── IN-MEMORY CACHE (per branch) ──────────────────────────────────────────────
// Each server process caches settings so a checkout does not read them from the database on every request.
// The cache EXPIRES (default 5 s): with two or more instances (Render scale-out, PM2 cluster) an
// invalidateCache() only reaches the process that handled the save, and a no-expiry cache let the other
// one keep accepting orders on a locked platform with old prices for as long as it stayed up (2026-10
// audit, F-12). A few seconds of staleness is the price of not needing a shared cache. Set
// SETTINGS_CACHE_TTL_MS=0 to disable caching altogether.
const _cache = new Map(); // branchId => { value, at }

const ttlMs = () => {
  const v = Number(process.env.SETTINGS_CACHE_TTL_MS);
  return Number.isFinite(v) && v >= 0 && process.env.SETTINGS_CACHE_TTL_MS !== undefined && process.env.SETTINGS_CACHE_TTL_MS !== '' ? v : 5000;
};

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
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs()) return hit.value;

  const settingsId = `settings_${branchId}`;
  let settings;
  try {
    settings = await Settings.findById(settingsId).lean();

    if (!settings) {
      // First boot for this branch — create with defaults
      settings = await Settings.create({ _id: settingsId, branchId });
      settings = settings.toObject();
    }
  } catch (err) {
    // The database hiccuped: keep serving the last known settings rather than failing every request.
    if (hit) return hit.value;
    throw err;
  }

  _cache.set(key, { value: settings, at: Date.now() });
  return settings;
};

// ── GET PUBLIC SETTINGS ───────────────────────────────────────────────────────
// Only shop info — safe to expose to frontend without auth
const getPublicSettings = async (branchId) => {
  const s = await getSettings(branchId);
  return {
    // Lets the storefront know which branch these settings belong to without a second request (the branch
    // list, or a re-fetch after branch resolution, used to be needed just to learn it).
    branchId:     String(s.branchId || branchId),
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
