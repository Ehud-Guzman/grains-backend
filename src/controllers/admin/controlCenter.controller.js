const controlCenter = require('../../services/controlCenter.service');
const audit = require('../../services/controlCenterAudit.service');
const integrity = require('../../services/integrity.service');
const jobControl = require('../../services/jobControl.service');
const activityLogService = require('../../services/activityLog.service');
const { buildPermissionMatrix } = require('../../utils/permissionMatrix');
const { confirmPassword } = require('../../utils/reauth');
const { success } = require('../../utils/apiResponse');
const { ROLES, LOG_ACTIONS } = require('../../utils/constants');

// Who is acting, for the activity log.
const actorOf = (req) => ({
  id: req.user.id,
  ip: req.ip || null,
  userAgent: req.headers['user-agent'] || null,
});

// Switches that need the password again. Everything else on the page is reversible with
// a tap and low-blast-radius.
const GUARDED_SWITCHES = ['platformLocked', 'maintenanceMode'];

// What the API resolved for THIS request: client IP, proxy hops, and the forwarding headers. Run it from
// two different networks - if both show the same resolvedIp, per-IP rate limits are shared by everyone
// and CLIENT_IP_HEADER (or TRUST_PROXY_HOPS) needs setting. See utils/clientIp.js.
const network = async (req, res, next) => {
  try {
    return success(res, require('../../utils/clientIp').describeNetwork(req));
  } catch (err) { next(err); }
};

const overview = async (req, res, next) => {
  try {
    return success(res, await controlCenter.getOverview());
  } catch (err) { next(err); }
};

const listAccounts = async (req, res, next) => {
  try {
    return success(res, await controlCenter.listAccounts());
  } catch (err) { next(err); }
};

const signOutAccount = async (req, res, next) => {
  try {
    const result = await controlCenter.signOutAccount(req.params.id, actorOf(req));
    return success(res, result, `${result.name} has been signed out everywhere`);
  } catch (err) { next(err); }
};

const signOutAll = async (req, res, next) => {
  try {
    await confirmPassword(req.user.id, req.body.password);
    const result = await controlCenter.signOutAll(req.body.scope || 'staff', actorOf(req));
    return success(res, result, `${result.accounts} account(s) signed out`);
  } catch (err) { next(err); }
};

const setBranchSwitches = async (req, res, next) => {
  try {
    const { password, ...patch } = req.body;
    if (GUARDED_SWITCHES.some(k => k in patch)) await confirmPassword(req.user.id, password);
    const result = await controlCenter.setBranchSwitches(req.params.branchId, patch, actorOf(req));
    return success(res, result, result.changed.length ? 'Switches updated' : 'Nothing changed');
  } catch (err) { next(err); }
};

const setLockAll = async (req, res, next) => {
  try {
    await confirmPassword(req.user.id, req.body.password);
    const result = await controlCenter.setLockAllBranches(Boolean(req.body.locked), actorOf(req));
    return success(res, result, result.locked ? 'Every branch is locked' : 'Every branch is unlocked');
  } catch (err) { next(err); }
};

const setJobPaused = async (req, res, next) => {
  try {
    const result = await controlCenter.setJobPaused(req.params.name, Boolean(req.body.paused), actorOf(req));
    return success(res, { ...result, jobs: await jobControl.listJobs() }, req.body.paused ? 'Job paused' : 'Job resumed');
  } catch (err) { next(err); }
};

const securityFeed = async (req, res, next) => {
  try {
    return success(res, await audit.getSecurityFeed({ days: req.query.days, limit: req.query.limit }));
  } catch (err) { next(err); }
};

const rawEntry = async (req, res, next) => {
  try {
    return success(res, await audit.getRawEntry(req.params.id));
  } catch (err) { next(err); }
};

// Streams the CSV so a large log never has to fit in memory. Headers are sent with the
// first chunk, so a bad filter still gets a normal JSON error before anything is written.
const exportAudit = async (req, res, next) => {
  try {
    const { from, to, action } = req.query;
    let started = false;
    const write = (chunk) => {
      if (!started) {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="activity-log-${new Date().toISOString().slice(0, 10)}.csv"`);
        started = true;
      }
      res.write(chunk);
    };
    const rows = await audit.exportActivityCsv({ from, to, action }, write);
    await activityLogService.log({
      actorId: req.user.id, actorRole: ROLES.SUPERADMIN,
      action: LOG_ACTIONS.CONTROL_AUDIT_EXPORTED,
      detail: { rows, from: from || null, to: to || null, action: action || null },
      ip: req.ip || null, userAgent: req.headers['user-agent'] || null,
    });
    res.end();
  } catch (err) {
    if (res.headersSent) return res.end(); // mid-stream: the truncated file is the signal
    next(err);
  }
};

const integrityScan = async (req, res, next) => {
  try {
    return success(res, await integrity.runScan());
  } catch (err) { next(err); }
};

const permissions = async (req, res, next) => {
  try {
    const roles = Object.values(ROLES).filter(r => r !== ROLES.GUEST);
    return success(res, buildPermissionMatrix(req.app, roles));
  } catch (err) { next(err); }
};

module.exports = {
  network, overview, listAccounts, signOutAccount, signOutAll,
  setBranchSwitches, setLockAll, setJobPaused,
  securityFeed, rawEntry, exportAudit, integrityScan, permissions,
};
