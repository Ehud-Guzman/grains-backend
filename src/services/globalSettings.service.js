// ── GLOBAL SETTINGS SERVICE ───────────────────────────────────────────────────
// Singleton get/update with in-memory cache — same pattern as settings.service.js.

const GlobalSettings = require('../models/GlobalSettings');
const { AppError } = require('../middleware/errorHandler.middleware');

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
  // eTIMS cannot be turned on without the credentials KRA requires for every
  // fiscal submission — otherwise it fails silently (fire-and-forget) on the
  // very next payment confirmation.
  if (patch['etims.enabled'] === true) {
    const current = await getSettings();
    const tin      = patch['etims.tin']      !== undefined ? patch['etims.tin']      : current.etims?.tin;
    const bhfId    = patch['etims.bhfId']     !== undefined ? patch['etims.bhfId']     : current.etims?.bhfId;
    const deviceId = patch['etims.deviceId']  !== undefined ? patch['etims.deviceId']  : current.etims?.deviceId;
    if (!tin?.trim() || !bhfId?.trim() || !deviceId?.trim()) {
      throw new AppError(
        'Cannot enable eTIMS without TIN, Branch ID (BHF ID), and Device Serial Number set.',
        400,
        'ETIMS_INCOMPLETE_CONFIG'
      );
    }
  }

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
