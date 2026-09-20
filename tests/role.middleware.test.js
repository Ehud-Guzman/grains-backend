process.env.NODE_ENV = 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Requiring the middleware pulls in alert.service (used by the low-privilege
// branch of requireMinRole). Stub it so no test can ever fire a real alert —
// the tests below deliberately avoid that path, but this makes it impossible
// to regress into it accidentally.
const alertServicePath = require.resolve('../src/services/alert.service');
require.cache[alertServicePath] = {
  id: alertServicePath,
  filename: alertServicePath,
  loaded: true,
  exports: { sendAlert: async () => {} },
};

const {
  requireRole,
  requireMinRole,
  requireBusinessRole,
  requireBranch,
  requireSuperadminOrPermission,
} = require('../src/middleware/role.middleware');

/** Run a guard and capture how it resolved, without needing a real response. */
const run = (guard, req) =>
  new Promise((resolve) => {
    guard(req, {}, (err) => {
      resolve(err ? { ok: false, status: err.statusCode, code: err.errorCode } : { ok: true });
    });
  });

const as = (role, extra = {}) => ({ user: { id: 'u1', role }, branchId: 'b1', ...extra });

describe('requireBusinessRole — superadmin is a view-only oversight role', () => {
  // The regression this file exists to prevent: requireBusinessRole used to
  // *admit* superadmin whenever req.branchId was set. Because the login flow
  // forces a superadmin to select a branch before they receive a token, that
  // carve-out always applied — so every business write in the admin API was
  // reachable with a superadmin token, even though the UI hides the buttons and
  // ~15 route comments say "superadmin CANNOT perform".
  test('blocks superadmin with 403 SUPERADMIN_VIEW_ONLY', async () => {
    const result = await run(requireBusinessRole('supervisor'), as('superadmin'));
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(result.code, 'SUPERADMIN_VIEW_ONLY');
  });

  test('blocks superadmin regardless of the minimum role asked for', async () => {
    for (const minRole of ['staff', 'supervisor', 'admin']) {
      const result = await run(requireBusinessRole(minRole), as('superadmin'));
      assert.equal(result.code, 'SUPERADMIN_VIEW_ONLY', `minRole=${minRole} should still block`);
    }
  });

  test('allows a supervisor at or above the minimum', async () => {
    assert.equal((await run(requireBusinessRole('supervisor'), as('supervisor'))).ok, true);
    assert.equal((await run(requireBusinessRole('staff'), as('supervisor'))).ok, true);
  });

  test('allows admin for an admin-level write', async () => {
    assert.equal((await run(requireBusinessRole('admin'), as('admin'))).ok, true);
  });

  test('rejects a role below the minimum with 403 FORBIDDEN', async () => {
    const result = await run(requireBusinessRole('admin'), as('supervisor'));
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(result.code, 'FORBIDDEN');

  });

  test('rejects staff for a supervisor-level write', async () => {
    assert.equal((await run(requireBusinessRole('supervisor'), as('staff'))).code, 'FORBIDDEN');
  });

  test('rejects an unauthenticated request with 401', async () => {
    const result = await run(requireBusinessRole('staff'), { user: null, branchId: null });
    assert.equal(result.status, 401);
    assert.equal(result.code, 'UNAUTHORIZED');
  });
})

describe('requireMinRole — reads stay open to superadmin for oversight', () => {
  // The counterpart to the rule above: oversight reads must NOT be blocked, or
  // the superadmin's "Observe (View Only)" nav would 403 on every page.
  test('allows superadmin through every read minimum', async () => {
    for (const minRole of ['staff', 'supervisor', 'admin']) {
      assert.equal((await run(requireMinRole(minRole), as('superadmin'))).ok, true, `minRole=${minRole}`);
    }
  });

  test('allows supervisor at a supervisor minimum but not staff', async () => {
    assert.equal((await run(requireMinRole('supervisor'), as('supervisor'))).ok, true);
    assert.equal((await run(requireMinRole('supervisor'), as('staff'))).code, 'FORBIDDEN');
  });

  test('allows the exact minimum role', async () => {
    assert.equal((await run(requireMinRole('admin'), as('admin'))).ok, true);
  });

  test('rejects an unauthenticated request with 401', async () => {
    assert.equal((await run(requireMinRole('staff'), { user: null })).code, 'UNAUTHORIZED');
  });
})

describe('requireRole — exact-match allow-list', () => {
  test('allows a listed role', async () => {
    assert.equal((await run(requireRole('superadmin'), as('superadmin'))).ok, true);
  });

  test('rejects a role that is higher in the hierarchy but not listed', async () => {
    // requireRole is exact-match, NOT a hierarchy check — so admin must not
    // inherit superadmin-only routes (users, backups, logs).
    assert.equal((await run(requireRole('superadmin'), as('admin'))).code, 'FORBIDDEN');
  });

  test('rejects an unauthenticated request with 401', async () => {
    assert.equal((await run(requireRole('admin'), { user: null })).code, 'UNAUTHORIZED');
  });
})

describe('requireSuperadminOrPermission — delegatable platform capabilities', () => {
  test('allows superadmin without the permission', async () => {
    assert.equal((await run(requireSuperadminOrPermission('manage_branches'), as('superadmin'))).ok, true);
  });

  test('allows a non-superadmin explicitly granted the permission', async () => {
    const req = { ...as('admin'), user: { id: 'u2', role: 'admin', customPermissions: ['manage_branches'] } };
    assert.equal((await run(requireSuperadminOrPermission('manage_branches'), req)).ok, true);
  });

  test('rejects a non-superadmin granted a DIFFERENT permission', async () => {
    const req = { ...as('admin'), user: { id: 'u3', role: 'admin', customPermissions: ['manage_etims'] } };
    const result = await run(requireSuperadminOrPermission('manage_branches'), req);
    assert.equal(result.status, 403);
    assert.equal(result.code, 'FORBIDDEN');
  });

  test('rejects a user with no customPermissions field at all', async () => {
    assert.equal((await run(requireSuperadminOrPermission('manage_etims'), as('admin'))).code, 'FORBIDDEN');
  });

  test('rejects an unauthenticated request with 401', async () => {
    assert.equal((await run(requireSuperadminOrPermission('manage_etims'), { user: null })).code, 'UNAUTHORIZED');
  });
})

describe('requireBranch — branch context required', () => {
  test('allows a request that carries a branchId', async () => {
    assert.equal((await run(requireBranch, { branchId: 'b1' })).ok, true);
  });

  test('rejects a request with no branch context', async () => {
    const result = await run(requireBranch, { branchId: null });
    assert.equal(result.status, 403);
    assert.equal(result.code, 'BRANCH_REQUIRED');
  });
})

