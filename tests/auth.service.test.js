process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const testDb = require('./helpers/testDb');
const { createBranch, createUser } = require('./helpers/fixtures');

const authService = require('../src/services/auth.service');
const User = require('../src/models/User');

before(async () => { await testDb.connect(); });
after(async () => { await testDb.disconnect(); });

const PASSWORD = 'Password1';

// login()'s OTP generation is `Math.floor(100000 + Math.random() * 900000)` —
// pinning Math.random() to 0 makes the OTP deterministic ('100000') so tests
// can verify it without ever seeing the plaintext code returned from the service.
const withFixedOtp = async (fn) => {
  const original = Math.random;
  Math.random = () => 0;
  try {
    return await fn();
  } finally {
    Math.random = original;
  }
};
const FIXED_OTP = '100000';

describe('auth.service — admin 2FA', () => {
  let branch, admin, staff;

  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
    const passwordHash = await bcrypt.hash(PASSWORD, 4); // low work factor — speed, not security, in tests
    admin = await createUser(branch._id, { role: 'admin', passwordHash, branchId: branch._id });
    staff = await createUser(branch._id, { role: 'staff', passwordHash, branchId: branch._id });
  });

  test('admin login requires 2FA and issues no tokens directly', async () => {
    const result = await withFixedOtp(() =>
      authService.login({ phone: admin.phone, password: PASSWORD }, '1.1.1.1', 'ua-1')
    );
    assert.equal(result.requiresTwoFactor, true);
    assert.ok(result.twoFactorToken);
    assert.equal(result.accessToken, undefined);
    assert.equal(result.requiresBranchSelection, undefined);

    const refreshed = await User.findById(admin._id);
    assert.ok(refreshed.twoFactorOtpHash, 'OTP hash should be stored');
    assert.ok(refreshed.twoFactorExpires);
  });

  test('staff login skips 2FA and goes straight to branch selection', async () => {
    const result = await authService.login({ phone: staff.phone, password: PASSWORD }, '1.1.1.1', 'ua-1');
    assert.equal(result.requiresTwoFactor, undefined);
    assert.equal(result.requiresBranchSelection, true);
    assert.ok(result.preAuthToken);
  });

  test('correct OTP proceeds to branch selection', async () => {
    const login = await withFixedOtp(() =>
      authService.login({ phone: admin.phone, password: PASSWORD }, '1.1.1.1', 'ua-1')
    );
    const verified = await authService.verifyTwoFactor(login.twoFactorToken, FIXED_OTP, '1.1.1.1');
    assert.equal(verified.requiresBranchSelection, true);
    assert.ok(verified.preAuthToken);

    const refreshed = await User.findById(admin._id);
    assert.equal(refreshed.twoFactorOtpHash, null, 'OTP state should be cleared after success');
  });

  test('wrong OTP can be retried (does not burn the token) up to OTP_MAX_ATTEMPTS, then locks out', async () => {
    const login = await withFixedOtp(() =>
      authService.login({ phone: admin.phone, password: PASSWORD }, '1.1.1.1', 'ua-1')
    );

    // OTP_MAX_ATTEMPTS is 5 — first 5 wrong guesses with the SAME token must
    // each be rejected but still retryable (not "already used").
    for (let i = 0; i < 5; i++) {
      await assert.rejects(
        authService.verifyTwoFactor(login.twoFactorToken, '999999', '1.1.1.1'),
        (err) => err.errorCode === 'INVALID_2FA_CODE'
      );
    }

    // Attempts now exhausted — even the correct OTP must be rejected until a fresh login.
    await assert.rejects(
      authService.verifyTwoFactor(login.twoFactorToken, FIXED_OTP, '1.1.1.1'),
      (err) => err.errorCode === 'INVALID_2FA_CODE'
    );
  });

  test('expired 2FA token is rejected', async () => {
    const login = await withFixedOtp(() =>
      authService.login({ phone: admin.phone, password: PASSWORD }, '1.1.1.1', 'ua-1')
    );
    const jwt = require('jsonwebtoken');
    const decoded = jwt.decode(login.twoFactorToken);
    const expiredToken = jwt.sign(
      { userId: decoded.userId, step: '2fa' },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: -1 } // already expired
    );
    await assert.rejects(
      authService.verifyTwoFactor(expiredToken, FIXED_OTP, '1.1.1.1'),
      (err) => err.errorCode === 'INVALID_2FA_TOKEN'
    );
  });

  test('a successfully-verified 2FA token cannot be replayed', async () => {
    const login = await withFixedOtp(() =>
      authService.login({ phone: admin.phone, password: PASSWORD }, '1.1.1.1', 'ua-1')
    );
    await authService.verifyTwoFactor(login.twoFactorToken, FIXED_OTP, '1.1.1.1');
    await assert.rejects(
      authService.verifyTwoFactor(login.twoFactorToken, FIXED_OTP, '1.1.1.1'),
      (err) => err.errorCode === 'INVALID_2FA_TOKEN'
    );
  });
});

describe('auth.service — login tracking', () => {
  let branch, admin;

  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    admin = await createUser(branch._id, { role: 'admin', passwordHash, branchId: branch._id });
  });

  test('login records lastLoginIp/lastLoginUserAgent', async () => {
    await withFixedOtp(() =>
      authService.login({ phone: admin.phone, password: PASSWORD }, '9.9.9.9', 'agent-A')
    );
    const refreshed = await User.findById(admin._id);
    assert.equal(refreshed.lastLoginIp, '9.9.9.9');
    assert.equal(refreshed.lastLoginUserAgent, 'agent-A');
  });
});
