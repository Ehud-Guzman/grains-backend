// ── GLOBAL SETTINGS SERVICE ───────────────────────────────────────────────────
// Singleton get/update with in-memory cache — same pattern as settings.service.js.

const GlobalSettings = require('../models/GlobalSettings');

let _cache = null;

const getSettings = async () => {
  if (_cache) return _cache;
  let doc = await GlobalSettings.findById('global').lean();
  if (!doc) {
    doc = (await GlobalSettings.create({ _id: 'global' })).toObject();
  }
  _cache = doc;
  return _cache;
};

const updateSettings = async (patch) => {
  const doc = await GlobalSettings.findByIdAndUpdate(
    'global',
    { $set: patch },
    { new: true, upsert: true, runValidators: true }
  ).lean();
  _cache = doc;
  return _cache;
};

const invalidateCache = () => { _cache = null; };

module.exports = { getSettings, updateSettings, invalidateCache };
