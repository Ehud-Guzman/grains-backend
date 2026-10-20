const { body } = require('express-validator');

// Reusable time string validator (HH:MM)
const isTimeString = (val) => {
  if (val === null || val === undefined || val === '') return true; // optional
  return /^\d{2}:\d{2}$/.test(val);
};

// Distance bands (see calculateDeliveryFee) must be a clean sequence of rings around the shop: each band starts
// where the previous one ends. An overlap makes the price depend on array order, a gap silently charges the
// flat fee for those distances, and a delivery radius inside the last band leaves that band unreachable (the
// exact mistake that shipped in both presets once). 2026-10 audit, F-47. Legacy zones that only have a name
// and a fee (no distances) are left alone.
const validateDeliveryZones = (zones, { req }) => {
  if (!Array.isArray(zones)) return true;
  const bands = zones.filter(z => z && (z.minKm != null || z.maxKm != null));
  if (bands.length === 0) return true;

  for (const z of bands) {
    const min = Number(z.minKm ?? 0);
    const max = Number(z.maxKm);
    if (!Number.isFinite(min) || min < 0) throw new Error(`"${z.name || 'A zone'}": start distance must be 0 or more`);
    if (!Number.isFinite(max) || max <= min) throw new Error(`"${z.name || 'A zone'}": end distance must be greater than its start (${min} km)`);
  }
  const sorted = [...bands].sort((a, b) => Number(a.minKm ?? 0) - Number(b.minKm ?? 0));
  if (Number(sorted[0].minKm ?? 0) !== 0) throw new Error('The first zone must start at 0 km');
  for (let i = 1; i < sorted.length; i += 1) {
    const prevEnd = Number(sorted[i - 1].maxKm);
    const start = Number(sorted[i].minKm ?? 0);
    if (start < prevEnd) throw new Error(`Zones overlap: "${sorted[i - 1].name}" ends at ${prevEnd} km but "${sorted[i].name}" starts at ${start} km`);
    if (start > prevEnd) throw new Error(`There is a gap between ${prevEnd} km and ${start} km - customers there would silently pay the flat fee`);
  }
  const radius = req.body?.maxDeliveryKm;
  if (radius !== undefined && radius !== null && radius !== '') {
    const lastStart = Number(sorted[sorted.length - 1].minKm ?? 0);
    if (Number(radius) <= lastStart) {
      throw new Error(`The delivery radius (${radius} km) is inside the last zone, which starts at ${lastStart} km - that zone could never be used`);
    }
  }
  return true;
};

const updateSettingsValidator = [
  // Shop info
  body('shopName').optional().trim().isLength({ max: 100 }).withMessage('Shop name cannot exceed 100 characters'),
  body('shopTagline').optional().trim().isLength({ max: 200 }).withMessage('Tagline cannot exceed 200 characters'),
  body('shopPhone').optional().trim().isLength({ max: 20 }).withMessage('Phone cannot exceed 20 characters'),
  body('shopPhones').optional().isArray().withMessage('shopPhones must be an array'),
  body('shopPhones.*').optional().trim().isLength({ max: 20 }).withMessage('Each phone cannot exceed 20 characters'),
  body('shopEmail').optional().trim().isEmail().withMessage('Invalid shop email'),
  body('shopHours').optional().trim().isLength({ max: 100 }).withMessage('Shop hours cannot exceed 100 characters'),
  body('shopLocation').optional().trim().isLength({ max: 200 }).withMessage('Location cannot exceed 200 characters'),
  body('shopWhatsapp').optional().trim().isLength({ max: 20 }).withMessage('WhatsApp number cannot exceed 20 characters'),

  // Order settings
  body('deliveryFee').optional().isFloat({ min: 0 }).withMessage('Delivery fee must be 0 or greater'),
  body('minimumOrderValue').optional().isFloat({ min: 0 }).withMessage('Minimum order value must be 0 or greater'),
  body('minimumOrderQuantity').optional().isInt({ min: 0 }).withMessage('Minimum order quantity must be 0 or greater'),
  body('autoCancelHours').optional().isInt({ min: 0 }).withMessage('Auto-cancel hours must be 0 or greater'),
  body('allowGuestOrders').optional().isBoolean().withMessage('allowGuestOrders must be a boolean'),
  body('allowCashOnDelivery').optional().isBoolean().withMessage('allowCashOnDelivery must be a boolean'),
  body('allowPayOnPickup').optional().isBoolean().withMessage('allowPayOnPickup must be a boolean'),
  body('allowMpesa').optional().isBoolean().withMessage('allowMpesa must be a boolean'),

  // Order workflow (requireOrderApproval removed 2026-07-17 — dead toggle, see Settings.js)
  body('enableOrderHours').optional().isBoolean().withMessage('enableOrderHours must be a boolean'),
  body('orderAcceptanceStart')
    .optional()
    .custom(isTimeString).withMessage('orderAcceptanceStart must be HH:MM format'),
  body('orderAcceptanceEnd')
    .optional()
    .custom(isTimeString).withMessage('orderAcceptanceEnd must be HH:MM format'),

  // Delivery zones
  body('useDeliveryZones').optional().isBoolean().withMessage('useDeliveryZones must be a boolean'),
  body('deliveryZones').optional().isArray().withMessage('deliveryZones must be an array').bail().custom(validateDeliveryZones),
  body('deliveryZones.*.name').optional().trim().notEmpty().withMessage('Zone name is required'),
  body('deliveryZones.*.fee').optional().isFloat({ min: 0 }).withMessage('Zone fee must be 0 or greater'),

  // Catalog (allowProductReviews removed 2026-07-17 — dead toggle, see Settings.js)
  body('autoHideOutOfStock').optional().isBoolean().withMessage('autoHideOutOfStock must be a boolean'),

  // Customer accounts (requirePhone/EmailVerification removed 2026-07-17 — dead toggles, see Settings.js)
  body('blockNewRegistrations').optional().isBoolean().withMessage('blockNewRegistrations must be a boolean'),

  // Tax & compliance
  body('kraPin').optional().trim().isLength({ max: 20 }).withMessage('KRA PIN cannot exceed 20 characters'),
  body('vatEnabled').optional().isBoolean().withMessage('vatEnabled must be a boolean'),
  body('vatRate').optional().isFloat({ min: 0, max: 100 }).withMessage('VAT rate must be between 0 and 100'),

  // Receipt & stock
  body('receiptFooterNote').optional().trim().isLength({ max: 500 }).withMessage('Receipt footer note cannot exceed 500 characters'),
  body('defaultLowStockThreshold').optional().isInt({ min: 0 }).withMessage('Low stock threshold must be 0 or greater'),

  // Notifications
  body('notifyAdminNewOrder').optional().isBoolean().withMessage('notifyAdminNewOrder must be a boolean'),
  body('notifyAdminLowStock').optional().isBoolean().withMessage('notifyAdminLowStock must be a boolean'),
  body('notifyAdminDailySalesReport').optional().isBoolean().withMessage('notifyAdminDailySalesReport must be a boolean'),
  body('notifyCustomerOnApproval').optional().isBoolean().withMessage('notifyCustomerOnApproval must be a boolean'),
  body('notifyCustomerOnRejection').optional().isBoolean().withMessage('notifyCustomerOnRejection must be a boolean'),
  body('notifyCustomerOnDelivery').optional().isBoolean().withMessage('notifyCustomerOnDelivery must be a boolean'),
  body('smsEnabled').optional().isBoolean().withMessage('smsEnabled must be a boolean'),
  body('emailEnabled').optional().isBoolean().withMessage('emailEnabled must be a boolean'),
  body('priceAlertThresholdPct').optional().isFloat({ min: 0, max: 100 }).withMessage('Price alert threshold must be 0–100'),
  body('largeOrderThresholdKES').optional().isFloat({ min: 0 }).withMessage('Large order threshold must be 0 or greater'),

  // Loyalty
  body('loyaltyEnabled').optional().isBoolean().withMessage('loyaltyEnabled must be a boolean'),
  body('loyaltyBronzeThreshold').optional().isFloat({ min: 0 }).withMessage('Bronze threshold must be >= 0'),
  body('loyaltySilverThreshold').optional().isFloat({ min: 0 }).withMessage('Silver threshold must be >= 0'),
  body('loyaltyGoldThreshold').optional().isFloat({ min: 0 }).withMessage('Gold threshold must be >= 0'),

  // Superadmin-only (service strips these for non-superadmins, but still validate shape)
  body('maintenanceMode').optional().isBoolean().withMessage('maintenanceMode must be a boolean'),
  body('maintenanceMessage').optional().trim().isLength({ max: 500 }).withMessage('Maintenance message cannot exceed 500 characters'),
  body('platformLocked').optional().isBoolean().withMessage('platformLocked must be a boolean'),
  body('allowNewAdminAccounts').optional().isBoolean().withMessage('allowNewAdminAccounts must be a boolean'),
  body('maxProductsPerBranch').optional().isInt({ min: 0 }).withMessage('maxProductsPerBranch must be 0 or greater'),
  body('maxStaffPerBranch').optional().isInt({ min: 0 }).withMessage('maxStaffPerBranch must be 0 or greater'),
  body('logRetentionDays').optional().isInt({ min: 0 }).withMessage('logRetentionDays must be 0 or greater'),
];

module.exports = { updateSettingsValidator, validateDeliveryZones };
