const assistantService = require('../../services/assistant.service');
const { forAudience } = require('../assistant.controller');
const { success } = require('../../utils/apiResponse');

// GET /api/admin/assistant/unanswered?days=90&limit=50&audience=customer
// What people asked, in any of the three assistants, that had no answer — grouped and counted.
const unanswered = async (req, res, next) => {
  try {
    const rows = await assistantService.getUnanswered({
      days: Number(req.query.days) || 90,
      limit: Number(req.query.limit) || 50,
      audience: req.query.audience || null,
    });
    return success(res, rows);
  } catch (err) { next(err); }
};

module.exports = { ...forAudience('admin'), unanswered };
