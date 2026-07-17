const User = require('../models/User');
const notificationService = require('./notification.service');
const activityLogService = require('./activityLog.service');
const { AppError } = require('../middleware/errorHandler.middleware');
const { LOG_ACTIONS } = require('../utils/constants');

const MAX_MESSAGE_LENGTH = 459; // 3 SMS segments (153 chars/segment after concat headers)

// ── AUDIENCE RESOLUTION ────────────────────────────────────────────────────────
// Registered customers only — guests have no durable identity to opt in/out of
// a marketing list. Not branch-scoped: customer accounts are shared across
// branches (branchId: null), matching how the admin Customers list already works.
// marketingConsent is an explicit opt-in (Kenya DPA 2019 — express consent is
// required for commercial messaging), so only customers who consented via
// registration or their profile are included. Transactional order SMS in
// notification.service.js are unaffected by this preference.
const buildAudienceQuery = (audience) => {
  const query = { role: 'customer', phone: { $ne: null }, marketingConsent: true };
  if (audience === 'b2b') query.isB2B = true;
  return query;
};

const getAudienceCount = async (audience) => {
  return User.countDocuments(buildAudienceQuery(audience));
};

// ── SEND BROADCAST ────────────────────────────────────────────────────────────
const sendBroadcast = async ({ message, audience = 'all' }, adminId, adminRole) => {
  const trimmed = (message || '').trim();
  if (!trimmed) throw new AppError('Message is required', 400, 'MESSAGE_REQUIRED');
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw new AppError(`Message is too long (max ${MAX_MESSAGE_LENGTH} characters)`, 400, 'MESSAGE_TOO_LONG');
  }

  const recipients = await User.find(buildAudienceQuery(audience)).select('phone').lean();
  if (!recipients.length) throw new AppError('No recipients match this audience', 400, 'NO_RECIPIENTS');

  const { sent, failed } = await notificationService.sendBulkSMS(
    recipients.map(r => r.phone), trimmed
  );

  await activityLogService.log({
    actorId: adminId,
    actorRole: adminRole,
    action: LOG_ACTIONS.SMS_BROADCAST_SENT,
    detail: { audience, recipientCount: recipients.length, sent, failed, messagePreview: trimmed.slice(0, 100) },
  });

  return { audience, recipientCount: recipients.length, sent, failed };
};

module.exports = { getAudienceCount, sendBroadcast, MAX_MESSAGE_LENGTH };
