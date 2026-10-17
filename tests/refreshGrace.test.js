process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const testDb = require('./helpers/testDb');
const { createBranch, createUser } = require('./helpers/fixtures');
const authService = require('../src/services/auth.service');
const TokenBlacklist = require('../src/models/TokenBlacklist');

before(async () => { await testDb.connect(); });
after(async () => { await testDb.disconnect(); });

const mintRefresh = (user) => jwt.sign(
  { id: String(user._id), role: user.role, branchId: String(user.branchId) },
  process.env.JWT_REFRESH_SECRET,
  { expiresIn: '7d' },
);

describe('auth.service — refresh token reuse grace window', () => {
  let user;
  beforeEach(async () => {
    await testDb.clearDatabase();
    const branch = await createBranch();
    user = await createUser(branch._id, { role: 'customer', branchId: branch._id });
  });

  test('the same refresh token presented twice in quick succession succeeds both times', async () => {
    const token = mintRefresh(user);
    const first = await authService.refreshToken(token);
    const second = await authService.refreshToken(token); // another tab, moments later
    assert.ok(first.accessToken && first.refreshToken);
    assert.ok(second.accessToken && second.refreshToken);
  });

  test('a refreshed token differs from the one it replaces, even within the same second', async () => {
    const token = mintRefresh(user);
    const { refreshToken: next } = await authService.refreshToken(token);
    assert.notEqual(next, token);
    const again = await authService.refreshToken(next); // the new token is usable, not pre-revoked
    assert.ok(again.accessToken);
  });

  test('two truly concurrent refreshes with one token both succeed', async () => {
    const token = mintRefresh(user);
    const results = await Promise.allSettled([authService.refreshToken(token), authService.refreshToken(token)]);
    assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled']);
  });

  test('a rotated token is rejected once the grace window has passed', async () => {
    const token = mintRefresh(user);
    await authService.refreshToken(token);
    await TokenBlacklist.updateOne({ token }, { rotatedAt: new Date(Date.now() - 60 * 1000) });
    await assert.rejects(() => authService.refreshToken(token), (err) => err.errorCode === 'TOKEN_REVOKED');
  });

  test('a token revoked by logout gets no grace', async () => {
    const token = mintRefresh(user);
    await authService.logout(token, null, user._id, user.role);
    await assert.rejects(() => authService.refreshToken(token), (err) => err.errorCode === 'TOKEN_REVOKED');
  });
});
