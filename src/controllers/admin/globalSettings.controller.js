// ── GLOBAL SETTINGS CONTROLLER ────────────────────────────────────────────────
const globalSettingsService = require('../../services/globalSettings.service');
const { success } = require('../../utils/apiResponse');

// GET /api/admin/global-settings
const get = async (req, res, next) => {
  try {
    const settings = await globalSettingsService.getSettings();
    return success(res, settings.etims || {});
  } catch (err) { next(err); }
};

// PUT /api/admin/global-settings
const update = async (req, res, next) => {
  try {
    const { enabled, baseUrl, tin, bhfId, deviceId, allowedRoles } = req.body;

    const patch = {};
    if (enabled      !== undefined) patch['etims.enabled']      = enabled;
    if (baseUrl      !== undefined) patch['etims.baseUrl']      = baseUrl;
    if (tin          !== undefined) patch['etims.tin']          = tin;
    if (bhfId        !== undefined) patch['etims.bhfId']        = bhfId;
    if (deviceId     !== undefined) patch['etims.deviceId']     = deviceId;
    if (allowedRoles !== undefined) patch['etims.allowedRoles'] = allowedRoles;

    const updated = await globalSettingsService.updateSettings(patch);
    return success(res, updated.etims || {}, 'eTIMS settings saved');
  } catch (err) { next(err); }
};

module.exports = { get, update };
