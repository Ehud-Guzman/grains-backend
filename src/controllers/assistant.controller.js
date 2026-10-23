const assistantService = require('../services/assistant.service');
const { success } = require('../utils/apiResponse');
const { ROLES } = require('../utils/constants');

// Who is asking, as the assistant understands them. A storefront visitor is either a
// customer or a guest — a staff member browsing the shop with their admin token is just a
// guest there, so the customer answers never depend on a business role.
const asCustomerOrGuest = (req) => ({
  id: req.user?.id || null,
  role: req.user?.role === ROLES.CUSTOMER ? ROLES.CUSTOMER : ROLES.GUEST,
  branchId: null,
  customPermissions: [],
});

// The ask/topics handlers for one audience. Each audience's router decides who may reach
// them; `who` says how to read the caller from the request.
const forAudience = (audience, who = (req) => req.user) => ({
  // POST { q } or { topicId }
  ask: async (req, res, next) => {
    try {
      const user = who(req);
      const { q, topicId } = req.body;
      const result = assistantService.ask(req.app, user, { q, topicId }, audience);
      // Only typed questions are worth learning from; a tap on a known topic never fails.
      if (q) assistantService.recordUnanswered(audience, user, q, result).catch(() => {});
      // Internal bookkeeping stays server-side.
      const { normalized: _normalized, topMatchId: _topMatchId, ...visible } = result;
      return success(res, visible);
    } catch (err) { next(err); }
  },

  // Everything the audience can do, grouped, marked for the caller's role.
  topics: async (req, res, next) => {
    try {
      return success(res, assistantService.topics(req.app, who(req), audience));
    } catch (err) { next(err); }
  },
});

module.exports = { forAudience, asCustomerOrGuest };
