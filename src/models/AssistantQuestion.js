const mongoose = require('mongoose');

// Questions the help assistant could not answer (or answered with "the system cannot do
// that"), one row per distinct question with a count. Together they are a to-do list: missing
// catalogue entries, unclear wording, and features people expect. Answered questions are
// deliberately not stored, and nothing here identifies who asked — only the roles that did.
const assistantQuestionSchema = new mongoose.Schema({
  audience: { type: String, required: true, enum: ['admin', 'customer', 'driver'] },
  normalized: { type: String, required: true, maxlength: 300 },  // sorted stems, so "delete order" and "order delete" group together
  outcome: { type: String, required: true, enum: ['no_match', 'not_supported'] },
  example: { type: String, required: true, maxlength: 300 },     // latest wording, with phone numbers/emails/refs masked
  count: { type: Number, default: 1 },
  roles: { type: [String], default: [] },
  topMatchId: { type: String, default: null },
  firstAskedAt: { type: Date, default: Date.now },
  lastAskedAt: { type: Date, default: Date.now },
}, { versionKey: false });

assistantQuestionSchema.index({ audience: 1, normalized: 1, outcome: 1 }, { unique: true });
assistantQuestionSchema.index({ lastAskedAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });
assistantQuestionSchema.index({ count: -1 });

module.exports = mongoose.model('AssistantQuestion', assistantQuestionSchema);
