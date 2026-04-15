const { body } = require('express-validator');

// Reusable time string validator (HH:MM)
const isTimeString = (val) => {
  if (val === null || val === undefined || val === '') return true; // optional
  return /^\d{2}:\d{2}$/.test(val);
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
  body('autoCancelHours').optional().isInt({ min: 0 }).withMessage('Auto-cancel hours must be 0 or greater'),
  body('allowGuestOrders').optional().isBoolean().withMessage('allowGuestOrders must be a boolean'),
  body('allowCashOnDelivery').optional().isBoolean().withMessage('allowCashOnDelivery must be a boolean'),
  body('allowPayOnPickup').optional().isBoolean().withMessage('allowPayOnPickup must be a boolean'),
  body('allowMpesa').optional().isBoolean().withMessage('allowMpesa must be a boolean'),

  // Order workflow
  body('requireOrderApproval').optional().isBoolean().withMessage('requireOrderApproval must be a boolean'),
  body('enableOrderHours').optional().isBoolean().withMessage('enableOrderHours must be a boolean'),
  body('orderAcceptanceStart')
    .optional()
    .custom(isTimeString).withMessage('orderAcceptanceStart must be HH:MM format'),
  body('orderAcceptanceEnd')
    .optional()
    .custom(isTimeString).withMessage('orderAcceptanceEnd must be HH:MM format'),

  // Delivery zones
  body('useDeliveryZones').optional().isBoolean().withMessage('useDeliveryZones must be a boolean'),
  body('deliveryZones').optional().isArray().withMessage('deliveryZones must be an array'),
  body('deliveryZones.*.name').optional().trim().notEmpty().withMessage('Zone name is required'),
  body('deliveryZones.*.fee').optional().isFloat({ min: 0 }).withMessage('Zone fee must be 0 or greater'),

  // Catalog
  body('autoHideOutOfStock').optional().isBoolean().withMessage('autoHideOutOfStock must be a boolean'),
  body('allowProductReviews').optional().isBoolean().withMessage('allowProductReviews must be a boolean'),

  // Customer accounts
  body('blockNewRegistrations').optional().isBoolean().withMessage('blockNewRegistrations must be a boolean'),
  body('requirePhoneVerification').optional().isBoolean().withMessage('requirePhoneVerification must be a boolean'),
  body('requireEmailVerification').optional().isBoolean().withMessage('requireEmailVerification must be a boolean'),

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
  body('notifyCustomerOnApproval').optional().isBoolean().withMessage('notifyCustomerOnApproval must be a boolean'),
  body('notifyCustomerOnRejection').optional().isBoolean().withMessage('notifyCustomerOnRejection must be a boolean'),
  body('notifyCustomerOnDelivery').optional().isBoolean().withMessage('notifyCustomerOnDelivery must be a boolean'),
  body('smsEnabled').optional().isBoolean().withMessage('smsEnabled must be a boolean'),
  body('emailEnabled').optional().isBoolean().withMessage('emailEnabled must be a boolean'),

  // Superadmin-only (service strips these for non-superadmins, but still validate shape)
  body('maintenanceMode').optional().isBoolean().withMessage('maintenanceMode must be a boolean'),
  body('maintenanceMessage').optional().trim().isLength({ max: 500 }).withMessage('Maintenance message cannot exceed 500 characters'),
  body('platformLocked').optional().isBoolean().withMessage('platformLocked must be a boolean'),
  body('allowNewAdminAccounts').optional().isBoolean().withMessage('allowNewAdminAccounts must be a boolean'),
  body('maxProductsPerBranch').optional().isInt({ min: 0 }).withMessage('maxProductsPerBranch must be 0 or greater'),
  body('maxStaffPerBranch').optional().isInt({ min: 0 }).withMessage('maxStaffPerBranch must be 0 or greater'),
  body('logRetentionDays').optional().isInt({ min: 0 }).withMessage('logRetentionDays must be 0 or greater'),
];

module.exports = { updateSettingsValidator };
