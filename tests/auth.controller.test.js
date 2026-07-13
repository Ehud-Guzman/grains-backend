process.env.NODE_ENV = 'test';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://grains-fronten.netlify.app';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// No DB connection needed — every case here is rejected before authController.refresh
// reaches authService.refreshToken (either by the CSRF check or the missing-token check).
const authController = require('../src/controllers/auth.controller');

const makeRes = () => {
  const res = { statusCode: 200 };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.cookie = () => res;
  return res;
};

describe('auth.controller#refresh — CSRF Origin/Referer check', () => {
  test('rejects a request whose Origin does not match FRONTEND_URL', async () => {
    const req = { headers: { origin: 'https://evil.example.com' }, cookies: {}, body: {} };
    const res = makeRes();
    await authController.refresh(req, res, () => {});
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'CSRF_ORIGIN_MISMATCH');
  });

  test('rejects a request whose Referer does not match FRONTEND_URL', async () => {
    const req = { headers: { referer: 'https://evil.example.com/attack' }, cookies: {}, body: {} };
    const res = makeRes();
    await authController.refresh(req, res, () => {});
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'CSRF_ORIGIN_MISMATCH');
  });

  test('allows a request with neither Origin nor Referer through (falls to the missing-token check)', async () => {
    const req = { headers: {}, cookies: {}, body: {} };
    const res = makeRes();
    await authController.refresh(req, res, () => {});
    assert.equal(res.body.error, 'MISSING_TOKEN');
  });

  test('allows a request whose Origin matches FRONTEND_URL through (falls to the missing-token check)', async () => {
    const req = { headers: { origin: process.env.FRONTEND_URL }, cookies: {}, body: {} };
    const res = makeRes();
    await authController.refresh(req, res, () => {});
    assert.equal(res.body.error, 'MISSING_TOKEN');
  });
});
