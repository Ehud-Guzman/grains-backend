// Explicit allow-lists of User fields for each audience. A deny-list (`-passwordHash -failedLoginCount`)
// returns everything that was forgotten, which is how OTP hashes, login IPs and internal notes reached
// responses they had no business in (2026-10 audit, F-08). A new User field is invisible until it is added
// here on purpose. Credential fields are also `select: false` on the model as a second line of defence.

// What a signed-in user may see about THEMSELVES (/auth/me, profile update). Not `notes` (staff's private
// remarks about a customer), not lockout/session internals.
const SELF_PROFILE_FIELDS = [
  'name', 'email', 'phone', 'avatarURL', 'role', 'addresses', 'kraPin', 'isB2B',
  'marketingConsent', 'marketingConsentAt', 'branchId', 'allowedBranchIds', 'customPermissions',
  'vehicleInfo', 'isAvailableForDelivery', 'onboarding', 'lastLoginAt', 'createdAt', 'updatedAt'
].join(' ');

// A driver's own record (/driver/me).
const DRIVER_SELF_FIELDS = [
  'name', 'email', 'phone', 'avatarURL', 'role', 'branchId', 'vehicleInfo',
  'isAvailableForDelivery', 'lastLoginAt', 'createdAt', 'updatedAt'
].join(' ');

// A driver as an admin sees them.
const DRIVER_ADMIN_FIELDS = [
  'name', 'email', 'phone', 'avatarURL', 'role', 'branchId', 'vehicleInfo',
  'isAvailableForDelivery', 'isLocked', 'lastLoginAt', 'createdAt', 'updatedAt'
].join(' ');

// A customer as branch staff see them.
const CUSTOMER_ADMIN_FIELDS = [
  'name', 'email', 'phone', 'role', 'addresses', 'kraPin', 'isB2B', 'notes', 'isLocked',
  'marketingConsent', 'lastLoginAt', 'createdAt', 'updatedAt'
].join(' ');

// A staff account in the superadmin's user list.
const STAFF_ADMIN_FIELDS = [
  'name', 'email', 'phone', 'avatarURL', 'role', 'branchId', 'allowedBranchIds', 'customPermissions',
  'isLocked', 'lastLoginAt', 'createdAt', 'updatedAt'
].join(' ');

module.exports = {
  SELF_PROFILE_FIELDS,
  DRIVER_SELF_FIELDS,
  DRIVER_ADMIN_FIELDS,
  CUSTOMER_ADMIN_FIELDS,
  STAFF_ADMIN_FIELDS,
};
