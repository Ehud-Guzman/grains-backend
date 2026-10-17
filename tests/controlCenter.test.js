process.env.NODE_ENV = 'test';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://grains-fronten.netlify.app';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const path = require('path');
const os = require('os');
process.env.BACKUP_STORAGE_DIR = path.join(os.tmpdir(), `grains-cc-test-${Date.now()}`);

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const express = require('express');

const testDb = require('./helpers/testDb');
const { createBranch, createSettings, createUser, createProduct, objectId } = require('./helpers/fixtures');

const app = require('../src/app');
const User = require('../src/models/User');
const Order = require('../src/models/Order');
const ActivityLog = require('../src/models/ActivityLog');
const GlobalSettings = require('../src/models/GlobalSettings');
const settingsService = require('../src/services/settings.service');
const controlCenter = require('../src/services/controlCenter.service');
const jobControl = require('../src/services/jobControl.service');
const integrity = require('../src/services/integrity.service');
const { csvCell } = require('../src/services/controlCenterAudit.service');
const { buildPermissionMatrix } = require('../src/utils/permissionMatrix');
const { requireRole, requireMinRole, requireBusinessRole, requireSuperadminOrPermission } = require('../src/middleware/role.middleware');
const { verifyToken } = require('../src/middleware/auth.middleware');

const PASSWORD = 'Correct-Horse-9';
let server;
let baseUrl;

before(async () => {
  await testDb.connect();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testDb.disconnect();
  await fs.rm(process.env.BACKUP_STORAGE_DIR, { recursive: true, force: true });
});
beforeEach(async () => { await testDb.clearDatabase(); });

// ── helpers ───────────────────────────────────────────────────────────────────
const staff = async (branchId, role, overrides = {}) => createUser(branchId, {
  role,
  name: `${role} user`,
  passwordHash: await bcrypt.hash(PASSWORD, 4),
  phone: `07${Math.floor(10000000 + Math.random() * 89999999)}`,
  ...overrides,
});
const tokenFor = (user, extra = {}) => jwt.sign(
  { id: String(user._id), role: user.role, branchId: user.branchId ? String(user.branchId) : null, ...extra },
  process.env.JWT_ACCESS_SECRET,
  { expiresIn: '10m' }
);
const call = async (method, url, { user, body, token } = {}) => {
  const res = await fetch(`${baseUrl}/api/admin/control-center${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(user || token ? { Authorization: `Bearer ${token || tokenFor(user)}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* CSV or empty */ }
  return { status: res.status, json, text };
};
const actor = (user) => ({ id: user._id, ip: '127.0.0.1', userAgent: 'test' });

// ── access control ────────────────────────────────────────────────────────────
describe('Control Center API — access', () => {
  test('anonymous callers get 401', async () => {
    const res = await call('GET', '/overview');
    assert.equal(res.status, 401);
  });

  test('no role below superadmin can reach any route', async () => {
    const branch = await createBranch();
    for (const role of ['customer', 'driver', 'staff', 'supervisor', 'admin']) {
      const user = await staff(branch._id, role);
      for (const [method, url] of [['GET', '/overview'], ['GET', '/accounts'], ['POST', '/accounts/sign-out-all'], ['GET', '/integrity'], ['GET', '/permissions'], ['GET', '/audit/export']]) {
        const res = await call(method, url, { user, body: method === 'POST' ? {} : undefined });
        assert.equal(res.status, 403, `${role} ${method} ${url} should be refused`);
      }
    }
  });

  test('a superadmin gets the overview', async () => {
    const branch = await createBranch();
    await createSettings(branch._id);
    const sa = await staff(branch._id, 'superadmin');
    const res = await call('GET', '/overview', { user: sa });
    assert.equal(res.status, 200);
    assert.equal(res.json.success, true);
    assert.ok(Array.isArray(res.json.data.attention));
    assert.equal(res.json.data.branches.length, 1);
    assert.equal(res.json.data.health.database.connected, true);
  });

  test('works while a branch is platform-locked — the lock lever must stay reachable', async () => {
    const branch = await createBranch();
    await createSettings(branch._id, { platformLocked: true });
    const sa = await staff(branch._id, 'superadmin');
    const res = await call('PUT', `/branches/${branch._id}/switches`, { user: sa, body: { platformLocked: false, password: PASSWORD } });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.switches.platformLocked, false);
  });
});

// ── sessions ──────────────────────────────────────────────────────────────────
describe('Control Center — sign-out', () => {
  test('signing an account out kills its existing tokens, and only its', async () => {
    const branch = await createBranch();
    const sa = await staff(branch._id, 'superadmin');
    const victim = await staff(branch._id, 'admin');
    const bystander = await staff(branch._id, 'admin');
    const victimToken = tokenFor(victim);
    const bystanderToken = tokenFor(bystander);

    // The token works before…
    const before = await fetch(`${baseUrl}/api/admin/users`, { headers: { Authorization: `Bearer ${victimToken}` } });
    assert.equal(before.status, 403); // authenticated but not superadmin — i.e. the token itself was accepted

    const out = await call('POST', `/accounts/${victim._id}/sign-out`, { user: sa });
    assert.equal(out.status, 200);

    // …and is revoked after, even though it was minted in the very same second.
    const after = await fetch(`${baseUrl}/api/admin/users`, { headers: { Authorization: `Bearer ${victimToken}` } });
    assert.equal(after.status, 401);
    assert.equal((await after.json()).error, 'TOKEN_REVOKED');

    const other = await fetch(`${baseUrl}/api/admin/users`, { headers: { Authorization: `Bearer ${bystanderToken}` } });
    assert.equal(other.status, 403);
  });

  test('a superadmin cannot sign themselves out through this endpoint', async () => {
    const branch = await createBranch();
    const sa = await staff(branch._id, 'superadmin');
    const res = await call('POST', `/accounts/${sa._id}/sign-out`, { user: sa });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'CANNOT_MODIFY_SELF');
  });

  test('sign-out-all needs the password', async () => {
    const branch = await createBranch();
    const sa = await staff(branch._id, 'superadmin');
    const none = await call('POST', '/accounts/sign-out-all', { user: sa, body: {} });
    assert.equal(none.status, 403);
    assert.equal(none.json.error, 'PASSWORD_REQUIRED');
    const wrong = await call('POST', '/accounts/sign-out-all', { user: sa, body: { password: 'nope-nope-nope' } });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.json.error, 'PASSWORD_INCORRECT');
  });

  test('sign-out-all spares the caller; "staff" scope spares customers', async () => {
    const branch = await createBranch();
    const sa = await staff(branch._id, 'superadmin');
    const admin = await staff(branch._id, 'admin');
    const driver = await staff(branch._id, 'driver');
    const customer = await staff(null, 'customer');

    const res = await call('POST', '/accounts/sign-out-all', { user: sa, body: { password: PASSWORD } });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.accounts, 2);

    const fresh = async (u) => (await User.findById(u._id).lean()).tokenValidAfter;
    assert.equal(await fresh(sa), null);
    assert.ok(await fresh(admin));
    assert.ok(await fresh(driver));
    assert.equal(await fresh(customer), null);

    const all = await call('POST', '/accounts/sign-out-all', { user: sa, body: { password: PASSWORD, scope: 'everyone' } });
    assert.equal(all.json.data.accounts, 3);
    assert.ok(await fresh(customer));
  });

  test('writes an activity-log entry', async () => {
    const branch = await createBranch();
    const sa = await staff(branch._id, 'superadmin');
    const victim = await staff(branch._id, 'staff');
    await controlCenter.signOutAccount(victim._id, actor(sa));
    const entry = await ActivityLog.findOne({ action: 'CONTROL_SESSIONS_REVOKED' }).lean();
    assert.ok(entry);
    assert.equal(String(entry.targetId), String(victim._id));
  });
});

// ── switches ──────────────────────────────────────────────────────────────────
describe('Control Center — branch switches', () => {
  test('a change takes effect immediately (cache invalidated) and is logged with before/after', async () => {
    const branch = await createBranch();
    await createSettings(branch._id);
    const sa = await staff(branch._id, 'superadmin');
    await settingsService.getSettings(branch._id); // warm the cache

    const result = await controlCenter.setBranchSwitches(branch._id, { allowGuestOrders: false }, actor(sa));
    assert.deepEqual(result.changed, ['allowGuestOrders']);
    assert.equal((await settingsService.getSettings(branch._id)).allowGuestOrders, false);

    const entry = await ActivityLog.findOne({ action: 'CONTROL_SWITCH_CHANGED' }).lean();
    assert.deepEqual(entry.detail.changes.allowGuestOrders, { from: true, to: false });
  });

  test('platformLocked uses the dedicated PLATFORM_LOCKED / UNLOCKED log actions', async () => {
    const branch = await createBranch();
    await createSettings(branch._id);
    const sa = await staff(branch._id, 'superadmin');
    await controlCenter.setBranchSwitches(branch._id, { platformLocked: true }, actor(sa));
    await controlCenter.setBranchSwitches(branch._id, { platformLocked: false }, actor(sa));
    assert.equal(await ActivityLog.countDocuments({ action: 'PLATFORM_LOCKED' }), 1);
    assert.equal(await ActivityLog.countDocuments({ action: 'PLATFORM_UNLOCKED' }), 1);
  });

  test('setting a switch to the value it already has changes and logs nothing', async () => {
    const branch = await createBranch();
    await createSettings(branch._id);
    const sa = await staff(branch._id, 'superadmin');
    const result = await controlCenter.setBranchSwitches(branch._id, { allowMpesa: true, smsEnabled: false }, actor(sa));
    assert.deepEqual(result.changed, []);
    assert.equal(await ActivityLog.countDocuments({}), 0);
  });

  test('rejects unknown keys, non-booleans and an overlong message', async () => {
    const branch = await createBranch();
    await createSettings(branch._id);
    const sa = await staff(branch._id, 'superadmin');
    await assert.rejects(controlCenter.setBranchSwitches(branch._id, { shopName: 'Hacked' }, actor(sa)), { errorCode: 'UNKNOWN_SWITCH' });
    await assert.rejects(controlCenter.setBranchSwitches(branch._id, { allowMpesa: 'yes' }, actor(sa)), { errorCode: 'INVALID_SWITCH' });
    await assert.rejects(controlCenter.setBranchSwitches(branch._id, { maintenanceMessage: 'x'.repeat(301) }, actor(sa)), { errorCode: 'MESSAGE_TOO_LONG' });
    await assert.rejects(controlCenter.setBranchSwitches(branch._id, {}, actor(sa)), { errorCode: 'NO_CHANGES' });
  });

  test('refuses to switch off the last payment method', async () => {
    const branch = await createBranch();
    await createSettings(branch._id, { allowMpesa: false, allowCashOnDelivery: false });
    const sa = await staff(branch._id, 'superadmin');
    await assert.rejects(
      controlCenter.setBranchSwitches(branch._id, { allowPayOnPickup: false }, actor(sa)),
      { errorCode: 'NO_PAYMENT_METHOD' }
    );
    // …but turning one off while another stays on is fine.
    const ok = await controlCenter.setBranchSwitches(branch._id, { allowMpesa: true, allowPayOnPickup: false }, actor(sa));
    assert.ok(ok.changed.includes('allowPayOnPickup'));
  });

  test('platform lock and maintenance mode need the password over HTTP; plain switches do not', async () => {
    const branch = await createBranch();
    await createSettings(branch._id);
    const sa = await staff(branch._id, 'superadmin');
    const noPw = await call('PUT', `/branches/${branch._id}/switches`, { user: sa, body: { maintenanceMode: true } });
    assert.equal(noPw.status, 403);
    assert.equal((await settingsService.getSettings(branch._id)).maintenanceMode, false);

    const plain = await call('PUT', `/branches/${branch._id}/switches`, { user: sa, body: { smsEnabled: true } });
    assert.equal(plain.status, 200);
    assert.equal(plain.json.data.switches.smsEnabled, true);
  });

  test('lock-all locks every active branch and leaves inactive ones alone', async () => {
    const a = await createBranch({ name: 'A', isDefault: true });
    const b = await createBranch({ name: 'B', isDefault: false });
    const c = await createBranch({ name: 'C', isDefault: false, isActive: false });
    for (const br of [a, b, c]) await createSettings(br._id);
    const sa = await staff(a._id, 'superadmin');

    const res = await call('PUT', '/lock-all', { user: sa, body: { locked: true, password: PASSWORD } });
    assert.equal(res.status, 200);
    assert.equal((await settingsService.getSettings(a._id)).platformLocked, true);
    assert.equal((await settingsService.getSettings(b._id)).platformLocked, true);
    assert.equal((await settingsService.getSettings(c._id)).platformLocked, false);
  });

  test('platformLocked really does freeze a branch admin (end-to-end with the existing lock middleware)', async () => {
    const branch = await createBranch();
    await createSettings(branch._id);
    const sa = await staff(branch._id, 'superadmin');
    const admin = await staff(branch._id, 'admin');
    await controlCenter.setBranchSwitches(branch._id, { platformLocked: true }, actor(sa));

    const res = await fetch(`${baseUrl}/api/admin/coupons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(admin)}` },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 423);
  });
});

// ── jobs ──────────────────────────────────────────────────────────────────────
describe('Control Center — jobs', () => {
  test('a paused job is skipped and recorded as skipped; resuming runs it again', async () => {
    let runs = 0;
    await jobControl.runGuarded('cleanup', async () => { runs += 1; });
    assert.equal(runs, 1);

    await jobControl.setPaused('cleanup', true);
    await jobControl.runGuarded('cleanup', async () => { runs += 1; });
    assert.equal(runs, 1);
    const paused = (await jobControl.listJobs()).find(j => j.name === 'cleanup');
    assert.equal(paused.paused, true);
    assert.equal(paused.lastRun.outcome, 'skipped');

    await jobControl.setPaused('cleanup', false);
    await jobControl.runGuarded('cleanup', async () => { runs += 1; });
    assert.equal(runs, 2);
  });

  test('a throwing job is recorded as failed and never throws out of runGuarded', async () => {
    await jobControl.runGuarded('etims-retry', async () => { throw new Error('KRA unreachable'); });
    const job = (await jobControl.listJobs()).find(j => j.name === 'etims-retry');
    assert.equal(job.lastRun.outcome, 'failed');
    assert.equal(job.lastRun.error, 'KRA unreachable');
  });

  test('the pause list is read from the database, not a per-process cache', async () => {
    await GlobalSettings.findByIdAndUpdate('global', { pausedJobs: ['auto-cancel'] }, { upsert: true });
    let ran = false;
    await jobControl.runGuarded('auto-cancel', async () => { ran = true; });
    assert.equal(ran, false);
  });

  test('unknown job names are refused, over HTTP and in the service', async () => {
    const branch = await createBranch();
    const sa = await staff(branch._id, 'superadmin');
    await assert.rejects(jobControl.setPaused('keep-alive', true), { errorCode: 'UNKNOWN_JOB' });
    const res = await call('PUT', '/jobs/keep-alive', { user: sa, body: { paused: true } });
    assert.equal(res.status, 400);
  });

  test('pausing writes the activity log', async () => {
    const branch = await createBranch();
    const sa = await staff(branch._id, 'superadmin');
    await controlCenter.setJobPaused('auto-cancel', true, actor(sa));
    assert.equal(await ActivityLog.countDocuments({ action: 'CONTROL_JOB_PAUSED' }), 1);
  });
});

// ── overview ──────────────────────────────────────────────────────────────────
describe('Control Center — overview attention list', () => {
  const find = (overview, idPart) => overview.attention.find(a => a.id.includes(idPart));

  test('flags a locked branch, a lone superadmin and a missing backup', async () => {
    const branch = await createBranch();
    await createSettings(branch._id, { platformLocked: true });
    await staff(branch._id, 'superadmin');
    const overview = await controlCenter.getOverview();
    assert.ok(find(overview, 'locked-'));
    assert.ok(find(overview, 'one-superadmin'));
    assert.equal(find(overview, 'backup-never').severity, 'high');
  });

  test('flags orders left pending for over a day as high severity, with the right count', async () => {
    const branch = await createBranch();
    await createSettings(branch._id);
    const sa = await staff(branch._id, 'superadmin');
    const old = new Date(Date.now() - 30 * 60 * 60 * 1000);
    await Order.create([1, 2].map(i => ({
      orderRef: `ORD-T-${i}`, orderItems: [], subtotal: 100, total: 100,
      deliveryMethod: 'pickup', paymentMethod: 'pickup', branchId: branch._id, status: 'pending', createdAt: old,
    })));
    const overview = await controlCenter.getOverview();
    const item = find(overview, 'pending-');
    assert.equal(item.severity, 'high');
    assert.match(item.detail, /2 pending/);
    assert.equal(overview.branches[0].figures.pendingOrders, 2);
    assert.ok(sa);
  });

  test('counts delivered-but-unconfirmed cash-on-delivery orders', async () => {
    const branch = await createBranch();
    await createSettings(branch._id);
    await Order.create({
      orderRef: 'ORD-COD-1', orderItems: [], subtotal: 5000, total: 5000, deliveryMethod: 'delivery',
      paymentMethod: 'delivery', paymentStatus: 'unpaid', status: 'completed', branchId: branch._id,
      deliveredAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    });
    const overview = await controlCenter.getOverview();
    assert.equal(overview.branches[0].figures.codUnsettledCount, 1);
    assert.equal(find(overview, 'cod-').severity, 'medium'); // oldest is >7 days
  });

  test('one broken section does not blank the page', async () => {
    const branch = await createBranch();
    await createSettings(branch._id);
    const backupService = require('../src/services/backup.service');
    const original = backupService.getBackupStorageSummary;
    backupService.getBackupStorageSummary = async () => { throw new Error('disk gone'); };
    try {
      const overview = await controlCenter.getOverview();
      assert.match(overview.backups.error, /disk gone/);
      assert.equal(overview.branches.length, 1); // everything else still answered
    } finally {
      backupService.getBackupStorageSummary = original;
    }
  });

  test('never leaks a secret value in the config checks', async () => {
    process.env.GMAIL_APP_PASSWORD = 'super-secret-app-password';
    process.env.CLOUDINARY_API_SECRET = 'cloud-secret-value';
    process.env.BACKUP_ENCRYPTION_KEY = 'f'.repeat(64);
    const checks = controlCenter.getConfigChecks();
    const text = JSON.stringify(checks);
    assert.ok(!text.includes('super-secret-app-password'));
    assert.ok(!text.includes('cloud-secret-value'));
    assert.ok(!text.includes('f'.repeat(64)));
    delete process.env.GMAIL_APP_PASSWORD;
    delete process.env.CLOUDINARY_API_SECRET;
    delete process.env.BACKUP_ENCRYPTION_KEY;
  });
});

// ── integrity scan ────────────────────────────────────────────────────────────
describe('Integrity scan', () => {
  test('a clean database reports no problems', async () => {
    const branch = await createBranch();
    await createSettings(branch._id);
    const scan = await integrity.runScan();
    assert.equal(scan.problems, 0, JSON.stringify(scan.checks.filter(c => !c.ok)));
  });

  test('finds a reservation held for a cancelled order, negative stock, and an orphaned staff account', async () => {
    const branch = await createBranch();
    await createSettings(branch._id);
    const owner = await staff(branch._id, 'superadmin');
    await createProduct(branch._id, owner._id, { packaging: { stock: -3 } });
    await staff(null, 'staff');
    await Order.create({
      orderRef: 'ORD-LEAK-1', orderItems: [], subtotal: 100, total: 100, deliveryMethod: 'pickup',
      paymentMethod: 'pickup', branchId: branch._id, status: 'cancelled', stockReservationStatus: 'held',
    });

    const scan = await integrity.runScan();
    const by = (id) => scan.checks.find(c => c.id === id);
    assert.equal(by('leaked-reservation').count, 1);
    assert.equal(by('leaked-reservation').examples[0].label, 'ORD-LEAK-1');
    assert.equal(by('negative-stock').count, 1);
    assert.equal(by('staff-branch').count, 1);
  });

  test('finds an order marked paid with no payment behind it', async () => {
    const branch = await createBranch();
    await createSettings(branch._id);
    await Order.create({
      orderRef: 'ORD-GHOST-1', orderItems: [], subtotal: 100, total: 100, deliveryMethod: 'pickup',
      paymentMethod: 'mpesa', paymentStatus: 'paid', branchId: branch._id, status: 'approved',
    });
    const scan = await integrity.runScan();
    assert.equal(scan.checks.find(c => c.id === 'paid-without-payment').count, 1);
  });

  test('is read-only', async () => {
    const branch = await createBranch();
    await createSettings(branch._id);
    const order = await Order.create({
      orderRef: 'ORD-RO-1', orderItems: [], subtotal: 100, total: 100, deliveryMethod: 'pickup',
      paymentMethod: 'pickup', branchId: branch._id, status: 'rejected', stockReservationStatus: 'held',
    });
    await integrity.runScan();
    const after = await Order.findById(order._id).lean();
    assert.equal(after.stockReservationStatus, 'held');
  });
});

// ── audit export ──────────────────────────────────────────────────────────────
describe('Audit export', () => {
  test('neutralises spreadsheet formulas and escapes quotes', () => {
    assert.equal(csvCell('=HYPERLINK("http://evil")'), '"\'=HYPERLINK(""http://evil"")"');
    assert.equal(csvCell('+254700000000'), '"\'+254700000000"');
    assert.equal(csvCell('plain'), '"plain"');
    assert.equal(csvCell(null), '""');
    assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
  });

  test('streams a CSV over HTTP and logs the export', async () => {
    const branch = await createBranch();
    const sa = await staff(branch._id, 'superadmin');
    await ActivityLog.create({ actorId: sa._id, actorRole: 'superadmin', action: 'ADMIN_LOGIN', ip: '1.2.3.4', detail: { note: '=cmd' } });

    const res = await call('GET', '/audit/export', { user: sa });
    assert.equal(res.status, 200);
    const lines = res.text.trim().split('\r\n');
    assert.match(lines[0], /^timestamp,action,/);
    assert.equal(lines.length, 2);
    assert.ok(lines[1].includes('ADMIN_LOGIN'));
    assert.equal(await ActivityLog.countDocuments({ action: 'CONTROL_AUDIT_EXPORTED' }), 1);
  });

  test('a bad filter gets a clean JSON error, not a half-written file', async () => {
    const branch = await createBranch();
    const sa = await staff(branch._id, 'superadmin');
    const res = await call('GET', '/audit/export?from=not-a-date', { user: sa });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'INVALID_DATE');
  });

  test('security feed groups failed sign-ins by IP', async () => {
    const branch = await createBranch();
    const sa = await staff(branch._id, 'superadmin');
    const victim = await staff(branch._id, 'admin');
    for (let i = 0; i < 3; i += 1) {
      await ActivityLog.create({ actorId: victim._id, actorRole: 'admin', action: 'FAILED_LOGIN', ip: '9.9.9.9', detail: {} });
    }
    const res = await call('GET', '/security?days=7', { user: sa });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.failedLoginsByIp[0].ip, '9.9.9.9');
    assert.equal(res.json.data.failedLoginsByIp[0].attempts, 3);
    assert.equal(res.json.data.failedLoginsByAccount[0].name, victim.name);
  });

  test('raw entry lookup rejects malformed ids and unknown entries', async () => {
    const branch = await createBranch();
    const sa = await staff(branch._id, 'superadmin');
    assert.equal((await call('GET', '/audit/not-an-id', { user: sa })).status, 400);
    assert.equal((await call('GET', `/audit/${objectId()}`, { user: sa })).status, 404);
  });
});

// ── permission matrix ─────────────────────────────────────────────────────────
describe('Permission matrix', () => {
  const ROLES = ['customer', 'driver', 'staff', 'supervisor', 'admin', 'superadmin'];

  test('reads the guards on a small router correctly', () => {
    const mini = express();
    const router = express.Router();
    router.use(verifyToken, requireMinRole('supervisor'));
    router.get('/', (req, res) => res.end());
    router.post('/', requireRole('admin', 'superadmin'), (req, res) => res.end());
    mini.use('/api/thing', router);

    const priv = express.Router();
    priv.use(verifyToken, requireBusinessRole('staff'));
    priv.post('/', (req, res) => res.end());
    mini.use('/api/biz', priv);

    const grant = express.Router();
    grant.use(verifyToken, requireSuperadminOrPermission('manage_etims'));
    grant.get('/', (req, res) => res.end());
    mini.use('/api/grant', grant);

    mini.get('/api/open', (req, res) => res.end());

    const { areas } = buildPermissionMatrix(mini, ROLES);
    const area = (m) => areas.find(a => a.mount === m);

    const thing = area('/api/thing');
    assert.equal(thing.cells.staff.read, false);
    assert.equal(thing.cells.supervisor.read, true);
    assert.equal(thing.cells.supervisor.write, false);     // POST narrowed to admin+
    assert.equal(thing.cells.supervisor.partial, false);
    assert.equal(thing.cells.admin.write, true);

    const biz = area('/api/biz');
    assert.equal(biz.cells.superadmin.write, false);        // view-only oversight role
    assert.equal(biz.cells.admin.write, true);
    assert.equal(biz.cells.customer.write, false);

    const g = area('/api/grant');
    assert.equal(g.cells.superadmin.read, true);
    assert.equal(g.cells.admin.read, false);
    assert.deepEqual(g.grantedBy, ['manage_etims']);

    assert.equal(area('/api/open').public, true);
  });

  test('on the real app: control-center is superadmin-only, and superadmin cannot write business data', () => {
    const { areas } = buildPermissionMatrix(app, ROLES);
    const cc = areas.find(a => a.mount === '/api/admin/control-center');
    assert.ok(cc, 'control-center must appear in the matrix');
    for (const role of ROLES.filter(r => r !== 'superadmin')) {
      assert.equal(cc.cells[role].read || cc.cells[role].write, false, `${role} must have no access`);
    }
    assert.equal(cc.cells.superadmin.read, true);
    assert.equal(cc.cells.superadmin.write, true);

    const orders = areas.find(a => a.mount === '/api/admin/orders');
    assert.equal(orders.cells.superadmin.write === false || orders.cells.superadmin.partial, true);
    assert.equal(orders.cells.admin.write, true);
  });

  test('every mounted router appears; none is silently missing', () => {
    const { areas } = buildPermissionMatrix(app, ROLES);
    const mounts = areas.map(a => a.mount);
    for (const expected of ['/api/auth', '/api/orders', '/api/admin/users', '/api/admin/backups', '/api/admin/branches', '/api/admin/control-center']) {
      assert.ok(mounts.includes(expected), `${expected} missing`);
    }
  });

  test('guards still enforce exactly what they did (metadata does not alter behaviour)', async () => {
    const run = (guard, role) => new Promise((resolve) => guard({ user: { id: 'x', role } }, {}, (err) => resolve(err ? err.statusCode : 'ok')));
    assert.equal(await run(requireRole('admin'), 'admin'), 'ok');
    assert.equal(await run(requireRole('admin'), 'staff'), 403);
    assert.equal(await run(requireMinRole('supervisor'), 'admin'), 'ok');
    assert.equal(await run(requireMinRole('supervisor'), 'staff'), 403);
    assert.equal(await run(requireBusinessRole('staff'), 'superadmin'), 403);
    assert.equal(await run(requireSuperadminOrPermission('x'), 'superadmin'), 'ok');
    assert.equal(await run(requireSuperadminOrPermission('x'), 'admin'), 403);
  });
});
