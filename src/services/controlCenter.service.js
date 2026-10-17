// ── CONTROL CENTER SERVICE ────────────────────────────────────────────────────
// What only the superadmin can see and do, in one place: system health, what needs
// attention, accounts and sessions, and the switches that govern each branch.
//
// Two rules shape this file:
//   1. Every part of the overview is computed independently and a failure is reported
//      as that part's failure (see `section`). A control room that goes blank when the
//      thing it watches is broken is no use at the one moment it is wanted.
//   2. Everything that changes state writes to the activity log, with before/after.

const mongoose = require('mongoose');
const User = require('../models/User');
const Branch = require('../models/Branch');
const Settings = require('../models/Settings');
const Order = require('../models/Order');
const Product = require('../models/Product');
const ActivityLog = require('../models/ActivityLog');
const globalSettingsService = require('./globalSettings.service');
const settingsService = require('./settings.service');
const activityLogService = require('./activityLog.service');
const jobControl = require('./jobControl.service');
const backupService = require('./backup.service');
const { AppError } = require('../middleware/errorHandler.middleware');
const { ROLES, LOG_ACTIONS } = require('../utils/constants');
const { revokeAllBefore } = require('../utils/tokenValidAfter');
const { startOfDayEAT } = require('../utils/businessTime');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SEVERITY_ORDER = { high: 0, medium: 1, info: 2 };

// Runs one part of the overview; returns its value or `{ error }`.
const section = async (label, run) => {
  try {
    return await run();
  } catch (err) {
    return { error: `${label} could not be read: ${err.message}` };
  }
};
const failed = (value) => Boolean(value && value.error);

// Accounts the Control Center lists. Customers are managed on the Customers page.
const STAFF_ROLES = [ROLES.STAFF, ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.SUPERADMIN, ROLES.DRIVER];

// ── CONFIGURATION CHECKS ──────────────────────────────────────────────────────
// What the deployment is actually set up with. Booleans and short labels only — never
// a secret's value.
const getConfigChecks = ({ anySmsOn = false, anyEmailOn = false, etimsOn = false } = {}) => {
  const isProd = process.env.NODE_ENV === 'production';
  const path = require('path');
  const atSandbox = !process.env.AT_USERNAME || process.env.AT_USERNAME === 'sandbox';
  const emailReady = Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
  const photosReady = Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
  const backupDirOk = Boolean(process.env.BACKUP_STORAGE_DIR) && path.isAbsolute(process.env.BACKUP_STORAGE_DIR);

  return [
    {
      id: 'mpesa', label: 'M-Pesa',
      ok: process.env.MPESA_ENV === 'production',
      value: process.env.MPESA_ENV || 'not set',
      note: process.env.MPESA_ENV === 'production'
        ? 'Live payments. Confirm the Daraja keys are production keys with a real STK push.'
        : 'Sandbox — customers are not really charged.',
      severity: isProd ? 'high' : 'info',
    },
    {
      id: 'sms', label: 'SMS (Africa’s Talking)',
      ok: !atSandbox,
      value: atSandbox ? 'sandbox' : 'live',
      note: atSandbox
        ? (anySmsOn
          ? 'SMS is switched on for a branch, but the account is the sandbox: nothing reaches real phones.'
          : 'Sandbox account: texts would not reach real phones. SMS is off on every branch, so nothing is lost today.')
        : 'Texts are delivered to real phones.',
      severity: atSandbox && anySmsOn ? 'medium' : 'info',
    },
    {
      id: 'email', label: 'Email (Gmail)',
      ok: emailReady,
      value: emailReady ? 'configured' : 'not set',
      note: emailReady
        ? 'Order emails, admin alerts and password codes can be sent.'
        : (anyEmailOn
          ? 'Email is switched on for a branch but no mail account is configured: nothing is sent, including password-reset codes.'
          : 'No mail account configured: admin alerts and password-reset codes cannot be sent.'),
      severity: emailReady ? 'info' : (anyEmailOn ? 'medium' : 'info'),
    },
    {
      id: 'photos', label: 'Photos (Cloudinary)',
      ok: photosReady,
      value: photosReady ? 'configured' : 'not set',
      note: photosReady ? 'Product images and delivery proof can be uploaded.' : 'Image uploads will fail.',
      severity: 'medium',
    },
    {
      id: 'sentry', label: 'Error tracking (Sentry)',
      ok: Boolean(process.env.SENTRY_DSN),
      value: process.env.SENTRY_DSN ? 'on' : 'off',
      note: process.env.SENTRY_DSN ? 'Server errors are reported.' : 'Server errors are only in the logs.',
      severity: 'info',
    },
    {
      id: 'backup-encryption', label: 'Backup encryption',
      ok: Boolean(process.env.BACKUP_ENCRYPTION_KEY),
      value: process.env.BACKUP_ENCRYPTION_KEY ? 'on' : 'off',
      note: process.env.BACKUP_ENCRYPTION_KEY
        ? 'Backups are encrypted at rest (AES-256-GCM).'
        : 'Backups hold customer phone numbers and orders in plain text.',
      severity: isProd ? 'medium' : 'info',
    },
    {
      id: 'backup-storage', label: 'Backup storage',
      ok: backupDirOk,
      value: backupDirOk ? 'persistent path' : 'default path',
      note: backupDirOk
        ? 'Backups are written to the configured directory.'
        : 'No absolute BACKUP_STORAGE_DIR: on most hosts the default disk is wiped on every deploy, taking the backups with it.',
      severity: isProd ? 'medium' : 'info',
    },
    {
      id: 'two-factor', label: 'Admin two-factor sign-in',
      ok: process.env.SKIP_2FA !== 'true',
      value: process.env.SKIP_2FA === 'true' ? 'bypassed' : 'enforced',
      note: process.env.SKIP_2FA === 'true'
        ? 'SKIP_2FA is true: admin and superadmin sign-in skips the emailed code.'
        : 'Admin and superadmin sign-in needs the emailed code.',
      severity: isProd ? 'high' : 'info',
    },
    {
      id: 'etims', label: 'KRA eTIMS',
      ok: etimsOn,
      value: etimsOn ? 'on' : 'off',
      note: etimsOn ? 'Paid orders are submitted to KRA.' : 'Fiscal invoices are not being submitted to KRA.',
      severity: 'info',
    },
  ];
};

// ── BRANCH FIGURES ────────────────────────────────────────────────────────────
// One cheap aggregate per figure, each hitting an index, merged by branch.
const loadBranchFigures = async () => {
  const todayStart = startOfDayEAT();
  const [pending, today, cod, etimsFailed, lowStock] = await Promise.all([
    Order.aggregate([
      { $match: { status: 'pending' } },
      { $group: { _id: '$branchId', count: { $sum: 1 }, oldest: { $min: '$createdAt' } } },
    ]),
    Order.aggregate([
      { $match: { createdAt: { $gte: todayStart } } },
      { $group: {
        _id: '$branchId',
        orders: { $sum: 1 },
        paidRevenue: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, '$total', 0] } },
      } },
    ]),
    // Cash on delivery: the order completes unpaid and the supervisor confirms the cash
    // when the driver remits it (CLAUDE.md, "Payment gates on the pipeline").
    Order.aggregate([
      { $match: { status: 'completed', paymentMethod: 'delivery', paymentStatus: 'unpaid' } },
      { $group: { _id: '$branchId', count: { $sum: 1 }, amount: { $sum: '$total' }, oldest: { $min: '$deliveredAt' } } },
    ]),
    Order.aggregate([
      { $match: { etimsStatus: 'failed' } },
      { $group: { _id: '$branchId', count: { $sum: 1 } } },
    ]),
    Product.aggregate([
      { $match: { isActive: true } },
      { $unwind: '$varieties' },
      { $unwind: '$varieties.packaging' },
      { $match: { 'varieties.packaging.quoteOnly': { $ne: true }, $expr: { $lte: ['$varieties.packaging.stock', '$varieties.packaging.lowStockThreshold'] } } },
      { $group: { _id: '$branchId', count: { $sum: 1 } } },
    ]),
  ]);

  const byBranch = (rows) => new Map(rows.map(r => [String(r._id), r]));
  return {
    pending: byBranch(pending),
    today: byBranch(today),
    cod: byBranch(cod),
    etimsFailed: byBranch(etimsFailed),
    lowStock: byBranch(lowStock),
  };
};

// The switches the Control Center edits, per branch. `key` is the Settings field.
// `global` marks the two that the app reads from the DEFAULT branch only (CLAUDE.md,
// "Settings enforcement map"), so they are shown on that branch's card with a note.
const SWITCHES = [
  { key: 'platformLocked',        label: 'Lock all changes',          group: 'emergency', risky: true,  description: 'Staff, supervisors, admins and drivers can read but not change anything on this branch. New orders are refused.' },
  { key: 'maintenanceMode',       label: 'Maintenance mode',          group: 'emergency', risky: true,  description: 'Customers cannot place orders; the shop shows the maintenance message. Staff are not affected.' },
  { key: 'allowGuestOrders',      label: 'Guest checkout',            group: 'checkout',  description: 'Let people order without an account.' },
  { key: 'allowMpesa',            label: 'M-Pesa payment',            group: 'checkout',  payment: true },
  { key: 'allowCashOnDelivery',   label: 'Cash on delivery',          group: 'checkout',  payment: true },
  { key: 'allowPayOnPickup',      label: 'Pay on pickup',             group: 'checkout',  payment: true },
  { key: 'smsEnabled',            label: 'SMS notifications',         group: 'messages',  description: 'Master switch for texts to customers and admins.' },
  { key: 'emailEnabled',          label: 'Email notifications',       group: 'messages',  description: 'Master switch for emails to customers.' },
  { key: 'blockNewRegistrations', label: 'Block new sign-ups',        group: 'accounts',  global: true, description: 'Stops new customer registrations everywhere. Read from the default branch.' },
  { key: 'allowNewAdminAccounts', label: 'Allow new staff accounts',  group: 'accounts',  global: true, description: 'When off, no staff or admin account can be created. Read from the default branch.' },
];
const SWITCH_KEYS = SWITCHES.map(s => s.key);
const PAYMENT_KEYS = SWITCHES.filter(s => s.payment).map(s => s.key);

// What a switch effectively is: the allow* flags default to on, the rest to off, so an
// unset field (older documents) reads as its default rather than as a change.
const effective = (settings, key) => (key.startsWith('allow') ? settings[key] !== false : Boolean(settings[key]));

const switchValues = (settings) => {
  const out = {};
  for (const { key } of SWITCHES) out[key] = effective(settings, key);
  return out;
};

// ── OVERVIEW ──────────────────────────────────────────────────────────────────
const getOverview = async () => {
  const now = Date.now();

  const [branches, jobs, accounts, backups, figures, securityCounts, globalSettings] = await Promise.all([
    section('Branches', () => Branch.find().sort({ isDefault: -1, name: 1 }).lean()),
    section('Scheduled jobs', () => jobControl.listJobs()),
    section('Accounts', () => User.find({ role: { $in: STAFF_ROLES } })
      .select('name role isLocked failedLoginCount lastLoginAt createdAt branchId').lean()),
    section('Backups', () => backupService.getBackupStorageSummary()),
    section('Branch figures', loadBranchFigures),
    section('Security events', async () => {
      const since = new Date(now - DAY_MS);
      const [failedLogins, locks] = await Promise.all([
        ActivityLog.countDocuments({ action: LOG_ACTIONS.FAILED_LOGIN, timestamp: { $gte: since } }),
        ActivityLog.countDocuments({ action: LOG_ACTIONS.ADMIN_ACCOUNT_LOCKED, timestamp: { $gte: since } }),
      ]);
      return { failedLogins24h: failedLogins, accountLocks24h: locks };
    }),
    section('Global settings', () => globalSettingsService.getSettings()),
  ]);

  // Settings docs are created on first read, so load them through the service (which
  // also hits its cache) rather than querying the collection and missing new branches.
  const branchList = failed(branches) ? [] : branches;
  const settingsByBranch = new Map();
  await Promise.all(branchList.map(async (b) => {
    try {
      settingsByBranch.set(String(b._id), await settingsService.getSettings(b._id));
    } catch { /* surfaced below as a missing-settings attention item */ }
  }));

  const anySmsOn = [...settingsByBranch.values()].some(s => s.smsEnabled);
  const anyEmailOn = [...settingsByBranch.values()].some(s => s.emailEnabled);
  const etimsOn = !failed(globalSettings) && Boolean(globalSettings?.etims?.enabled);
  const config = getConfigChecks({ anySmsOn, anyEmailOn, etimsOn });

  // Per-branch cards
  const branchCards = branchList.map((b) => {
    const id = String(b._id);
    const s = settingsByBranch.get(id) || {};
    const f = failed(figures) ? null : figures;
    const pending = f?.pending.get(id);
    const todayRow = f?.today.get(id);
    const cod = f?.cod.get(id);
    return {
      id,
      name: b.name,
      slug: b.slug,
      location: b.location || null,
      isActive: b.isActive,
      isDefault: b.isDefault,
      hasCoordinates: s.branchLat != null && s.branchLng != null,
      figures: f ? {
        pendingOrders: pending?.count || 0,
        oldestPendingAt: pending?.oldest || null,
        ordersToday: todayRow?.orders || 0,
        paidRevenueToday: todayRow?.paidRevenue || 0,
        codUnsettledCount: cod?.count || 0,
        codUnsettledAmount: cod?.amount || 0,
        codOldestAt: cod?.oldest || null,
        etimsFailed: f.etimsFailed.get(id)?.count || 0,
        lowStockLines: f.lowStock.get(id)?.count || 0,
      } : null,
      switches: switchValues(s),
      maintenanceMessage: s.maintenanceMessage || '',
    };
  });

  // ── what needs attention, worst first ───────────────────────────────────────
  const attention = [];
  const flag = (severity, id, title, detail, link = null) => attention.push({ severity, id, title, detail, link });

  if (mongoose.connection.readyState !== 1) {
    flag('high', 'db-down', 'The database is not connected', 'Nothing can be read or saved until it is back.', 'health');
  }
  if (backupService.isRestoreInProgress()) {
    flag('high', 'restore-running', 'A restore is in progress', 'The API is refusing other traffic until it finishes.', 'data');
  }

  for (const check of config) {
    if (!check.ok && check.severity !== 'info') flag(check.severity, `config-${check.id}`, `${check.label}: ${check.value}`, check.note, 'health');
  }

  if (!failed(backups)) {
    const latest = backups.summary.latestBackupAt;
    if (!latest) {
      flag('high', 'backup-never', 'There is no backup', 'Nothing has been backed up from this server. Create one before anything risky.', 'data');
    } else {
      const days = Math.floor((now - new Date(latest).getTime()) / DAY_MS);
      if (days >= 7) flag('medium', 'backup-stale', `The last backup is ${days} days old`, 'Backups are manual in this system — create a fresh one.', 'data');
    }
  }

  if (!failed(jobs)) {
    for (const job of jobs) {
      if (job.lastRun?.outcome === 'failed') flag('high', `job-${job.name}`, `${job.label} failed last time`, job.lastRun.error || 'See the server log.', 'jobs');
      if (job.paused) flag('info', `job-paused-${job.name}`, `${job.label} is paused`, job.pauseEffect, 'jobs');
    }
  }

  if (!failed(branches)) {
    if (!branchList.some(b => b.isActive && b.isDefault) && !branchList.some(b => b.isActive)) {
      flag('high', 'no-branch', 'There is no active branch', 'The shop cannot take orders.', 'branches');
    }
    for (const card of branchCards) {
      if (card.switches.platformLocked) flag('medium', `locked-${card.id}`, `${card.name} is locked`, 'Nobody can change anything on this branch and customers cannot order.', 'switches');
      if (card.switches.maintenanceMode) flag('medium', `maint-${card.id}`, `${card.name} is in maintenance mode`, 'Customers cannot place orders. Switch it off when you are done.', 'switches');
      if (card.isActive && !card.hasCoordinates) flag('info', `coords-${card.id}`, `${card.name} has no map coordinates`, 'Without them the shop can never pick it as the nearest branch, and distance-based delivery pricing cannot work.', 'branches');
      if (card.isActive && !settingsByBranch.has(card.id)) flag('medium', `settings-${card.id}`, `${card.name}: settings could not be read`, 'Orders for this branch may fail.', 'branches');
      const fg = card.figures;
      if (fg) {
        if (fg.oldestPendingAt) {
          const hours = (now - new Date(fg.oldestPendingAt).getTime()) / HOUR_MS;
          if (hours >= 24) flag('high', `pending-${card.id}`, `${card.name}: orders waiting over a day`, `${fg.pendingOrders} pending, the oldest ${Math.floor(hours / 24)} day(s) old.`, '/admin/orders?status=pending');
          else if (hours >= 4) flag('medium', `pending-${card.id}`, `${card.name}: orders waiting ${Math.floor(hours)}h`, `${fg.pendingOrders} pending, the oldest ${Math.floor(hours)} hours old.`, '/admin/orders?status=pending');
        }
        if (fg.codUnsettledCount > 0) {
          const oldDays = fg.codOldestAt ? Math.floor((now - new Date(fg.codOldestAt).getTime()) / DAY_MS) : 0;
          flag(oldDays >= 7 ? 'medium' : 'info', `cod-${card.id}`, `${card.name}: cash not yet confirmed`,
            `${fg.codUnsettledCount} delivered cash-on-delivery order(s), KES ${Math.round(fg.codUnsettledAmount).toLocaleString('en-KE')}, oldest ${oldDays} day(s).`, '/admin/orders');
        }
        if (fg.etimsFailed > 0) flag(etimsOn ? 'medium' : 'info', `etims-${card.id}`, `${card.name}: ${fg.etimsFailed} eTIMS invoice(s) failed`, 'KRA did not accept them. The retry job tries for 7 days, then they need a manual resubmit.', '/admin/etims');
        if (fg.lowStockLines > 0) flag('info', `lowstock-${card.id}`, `${card.name}: ${fg.lowStockLines} item(s) low or out of stock`, 'Customers cannot order what is out of stock.', '/admin/stock');
      }
    }
  }

  if (!failed(accounts)) {
    const live = accounts.filter(u => !u.isLocked);
    if (live.filter(u => u.role === ROLES.SUPERADMIN).length === 1) {
      flag('info', 'one-superadmin', 'There is only one superadmin', 'If that account is lost, nobody can restore backups, reset staff passwords or change these switches. Consider a second.', 'accounts');
    }
    for (const u of accounts.filter(x => !x.isLocked && (x.failedLoginCount || 0) >= 3)) {
      flag('medium', `failed-${u._id}`, `${u.name}: ${u.failedLoginCount} wrong passwords in a row`, 'Either they forgot, or somebody is guessing. The account locks at 5.', 'accounts');
    }
    const orphaned = accounts.filter(u => [ROLES.STAFF, ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.DRIVER].includes(u.role) && !u.branchId);
    if (orphaned.length) flag('medium', 'no-branch-staff', `${orphaned.length} staff account(s) belong to no branch`, `${orphaned.map(u => u.name).join(', ')} cannot do branch work.`, 'accounts');
    const unused = live.filter(u => !u.lastLoginAt && now - new Date(u.createdAt).getTime() > 7 * DAY_MS);
    if (unused.length) flag('info', 'never-used', `${unused.length} account(s) created over a week ago, never used`, unused.map(u => u.name).join(', '), 'accounts');
  }

  if (!failed(securityCounts) && securityCounts.failedLogins24h >= 10) {
    flag('medium', 'failed-logins', `${securityCounts.failedLogins24h} failed sign-ins in the last day`, 'More than usual. Check where they came from.', 'security');
  }

  attention.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const accountSummary = failed(accounts) ? accounts : {
    total: accounts.length,
    locked: accounts.filter(u => u.isLocked).length,
    byRole: STAFF_ROLES.reduce((acc, r) => ({ ...acc, [r]: accounts.filter(u => u.role === r).length }), {}),
    signedInToday: accounts.filter(u => u.lastLoginAt && now - new Date(u.lastLoginAt).getTime() < DAY_MS).length,
  };

  return {
    generatedAt: new Date(now).toISOString(),
    health: {
      api: {
        uptimeSeconds: Math.round(process.uptime()),
        node: process.version,
        environment: process.env.NODE_ENV || 'development',
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        restoreInProgress: backupService.isRestoreInProgress(),
      },
      database: {
        connected: mongoose.connection.readyState === 1,
        name: mongoose.connection.name || '',
      },
      config,
    },
    attention,
    branches: failed(branches) ? branches : branchCards,
    accounts: accountSummary,
    backups: failed(backups) ? backups : {
      total: backups.summary.totalBackups,
      totalSizeBytes: backups.summary.totalSizeBytes,
      latestBackupAt: backups.summary.latestBackupAt,
      encrypted: Boolean(process.env.BACKUP_ENCRYPTION_KEY),
    },
    jobs,
    security: securityCounts,
    switchDefinitions: SWITCHES,
  };
};

// ── ACCOUNTS & SESSIONS ───────────────────────────────────────────────────────
const accountDTO = (u, branchNames) => ({
  id: u._id,
  name: u.name,
  phone: u.phone,
  email: u.email || null,
  role: u.role,
  branchId: u.branchId || null,
  branchName: u.branchId ? (branchNames.get(String(u.branchId)) || 'Unknown branch') : null,
  isLocked: Boolean(u.isLocked),
  failedLoginCount: u.failedLoginCount || 0,
  lastLoginAt: u.lastLoginAt || null,
  lastLoginIp: u.lastLoginIp || null,
  createdAt: u.createdAt,
  // When their sessions were last cut off by a role change, password reset or sign-out.
  sessionsRevokedAt: u.tokenValidAfter || null,
});

const listAccounts = async () => {
  const [users, branches] = await Promise.all([
    User.find({ role: { $in: STAFF_ROLES } })
      .select('name phone email role branchId isLocked failedLoginCount lastLoginAt lastLoginIp createdAt tokenValidAfter')
      .sort({ role: 1, createdAt: 1 }).lean(),
    Branch.find().select('name').lean(),
  ]);
  const branchNames = new Map(branches.map(b => [String(b._id), b.name]));
  return users.map(u => accountDTO(u, branchNames));
};

const signOutAccount = async (targetId, actor) => {
  if (String(targetId) === String(actor.id)) {
    throw new AppError('To end your own session, use Log out.', 400, 'CANNOT_MODIFY_SELF');
  }
  const user = await User.findByIdAndUpdate(targetId, { tokenValidAfter: revokeAllBefore() }, { new: true })
    .select('name role').lean();
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

  await activityLogService.log({
    actorId: actor.id, actorRole: ROLES.SUPERADMIN,
    action: LOG_ACTIONS.CONTROL_SESSIONS_REVOKED,
    targetId, targetType: 'User',
    detail: { scope: 'one', name: user.name, role: user.role },
    ip: actor.ip, userAgent: actor.userAgent,
  });
  return { id: user._id, name: user.name };
};

// scope 'staff' = everyone with a staff-side role; 'everyone' adds customers too.
// The caller is always spared, so the action can never lock the superadmin out of the
// page they are using.
const signOutAll = async (scope, actor) => {
  if (!['staff', 'everyone'].includes(scope)) {
    throw new AppError('scope must be "staff" or "everyone"', 400, 'INVALID_SCOPE');
  }
  const filter = { _id: { $ne: actor.id } };
  if (scope === 'staff') filter.role = { $in: STAFF_ROLES };

  const result = await User.updateMany(filter, { tokenValidAfter: revokeAllBefore() });

  await activityLogService.log({
    actorId: actor.id, actorRole: ROLES.SUPERADMIN,
    action: LOG_ACTIONS.CONTROL_SESSIONS_REVOKED,
    detail: { scope, accounts: result.modifiedCount },
    ip: actor.ip, userAgent: actor.userAgent,
  });
  return { accounts: result.modifiedCount, scope };
};

// ── SWITCHES ──────────────────────────────────────────────────────────────────
// patch: { platformLocked: true, maintenanceMessage: '…', … } — only whitelisted keys.
const setBranchSwitches = async (branchId, patch, actor) => {
  const branch = await Branch.findById(branchId).select('name').lean();
  if (!branch) throw new AppError('Branch not found', 404, 'BRANCH_NOT_FOUND');

  const update = {};
  for (const key of Object.keys(patch || {})) {
    if (SWITCH_KEYS.includes(key)) {
      if (typeof patch[key] !== 'boolean') throw new AppError(`${key} must be true or false`, 400, 'INVALID_SWITCH');
      update[key] = patch[key];
    } else if (key === 'maintenanceMessage') {
      const message = String(patch[key] ?? '').trim();
      if (message.length > 300) throw new AppError('The maintenance message is limited to 300 characters.', 400, 'MESSAGE_TOO_LONG');
      update.maintenanceMessage = message || 'We are currently undergoing maintenance. Please check back soon.';
    } else {
      throw new AppError(`"${key}" is not a Control Center switch`, 400, 'UNKNOWN_SWITCH');
    }
  }
  if (Object.keys(update).length === 0) throw new AppError('Nothing to change', 400, 'NO_CHANGES');

  const before = await settingsService.getSettings(branchId);

  // A shop that accepts no payment method cannot take an order at all — and the checkout
  // would give the customer no reason why.
  if (PAYMENT_KEYS.some(k => k in update) && PAYMENT_KEYS.every(k => !(k in update ? update[k] : effective(before, k)))) {
    throw new AppError('At least one payment method must stay on, or customers cannot check out.', 400, 'NO_PAYMENT_METHOD');
  }

  const changed = Object.keys(update).filter(k => (k === 'maintenanceMessage' ? before[k] !== update[k] : effective(before, k) !== update[k]));
  if (changed.length === 0) return { branchId, changed: [], switches: switchValues(before) };

  await Settings.findByIdAndUpdate(
    `settings_${branchId}`,
    { ...update, updatedAt: new Date(), updatedBy: actor.id },
    { runValidators: true }
  );
  settingsService.invalidateCache(branchId);

  const lockChanged = changed.includes('platformLocked');
  await activityLogService.log({
    actorId: actor.id, actorRole: ROLES.SUPERADMIN,
    action: lockChanged
      ? (update.platformLocked ? LOG_ACTIONS.PLATFORM_LOCKED : LOG_ACTIONS.PLATFORM_UNLOCKED)
      : LOG_ACTIONS.CONTROL_SWITCH_CHANGED,
    branchId, targetType: 'Settings',
    detail: {
      branch: branch.name,
      changes: Object.fromEntries(changed.map(k => [k, { from: k === 'maintenanceMessage' ? before[k] ?? null : effective(before, k), to: update[k] }])),
    },
    ip: actor.ip, userAgent: actor.userAgent,
  });

  const fresh = await settingsService.getSettings(branchId);
  return { branchId, changed, switches: switchValues(fresh), maintenanceMessage: fresh.maintenanceMessage };
};

// The emergency lever: lock (or unlock) every active branch at once.
const setLockAllBranches = async (locked, actor) => {
  const branches = await Branch.find({ isActive: true }).select('name').lean();
  const results = [];
  for (const b of branches) {
    // Reuses the single-branch path so each branch gets its own cache invalidation and log entry.
    results.push(await setBranchSwitches(b._id, { platformLocked: Boolean(locked) }, actor));
  }
  return { branches: branches.length, changed: results.filter(r => r.changed.length).length, locked: Boolean(locked) };
};

// ── JOBS ──────────────────────────────────────────────────────────────────────
const setJobPaused = async (name, paused, actor) => {
  const job = jobControl.JOBS.find(j => j.name === name);
  const next = await jobControl.setPaused(name, Boolean(paused));
  await activityLogService.log({
    actorId: actor.id, actorRole: ROLES.SUPERADMIN,
    action: paused ? LOG_ACTIONS.CONTROL_JOB_PAUSED : LOG_ACTIONS.CONTROL_JOB_RESUMED,
    detail: { job: name, label: job?.label },
    ip: actor.ip, userAgent: actor.userAgent,
  });
  return { pausedJobs: next };
};

module.exports = {
  SWITCHES,
  STAFF_ROLES,
  getConfigChecks,
  getOverview,
  listAccounts,
  signOutAccount,
  signOutAll,
  setBranchSwitches,
  setLockAllBranches,
  setJobPaused,
};
