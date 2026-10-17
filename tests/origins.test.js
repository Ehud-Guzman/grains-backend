process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { allowedOrigins, isAllowedOriginValue } = require('../src/utils/origins');
const authController = require('../src/controllers/auth.controller');

const saved = {};
const KEYS = ['FRONTEND_URL', 'FRONTEND_URLS', 'COOKIE_DOMAIN', 'NODE_ENV'];
beforeEach(() => { for (const k of KEYS) saved[k] = process.env[k]; });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('allowed storefront origins', () => {
  test('FRONTEND_URL alone is allowed, and only exactly that origin', () => {
    process.env.FRONTEND_URL = 'https://shop.example.com';
    delete process.env.FRONTEND_URLS;
    assert.ok(isAllowedOriginValue('https://shop.example.com'));
    assert.ok(isAllowedOriginValue('https://shop.example.com/some/path'));
    assert.ok(!isAllowedOriginValue('https://shop.example.com.evil.com'));
    assert.ok(!isAllowedOriginValue('http://shop.example.com'));
    assert.ok(!isAllowedOriginValue('not a url'));
  });

  test('FRONTEND_URLS adds extra origins, so old and new domains can both work during a move', () => {
    process.env.FRONTEND_URL = 'https://old.netlify.app';
    process.env.FRONTEND_URLS = 'https://www.vittorios.co.ke, https://vittorios.co.ke';
    assert.deepEqual(allowedOrigins().sort(), ['https://old.netlify.app', 'https://vittorios.co.ke', 'https://www.vittorios.co.ke']);
    assert.ok(isAllowedOriginValue('https://www.vittorios.co.ke'));
    assert.ok(!isAllowedOriginValue('https://evil.co.ke'));
  });
});

describe('refresh cookie options', () => {
  test('production without COOKIE_DOMAIN stays SameSite=None (cross-site shop and API)', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.COOKIE_DOMAIN;
    const o = authController.refreshCookieOptions();
    assert.equal(o.sameSite, 'none');
    assert.equal(o.secure, true);
    assert.equal(o.domain, undefined);
  });

  test('COOKIE_DOMAIN makes the cookie first-party: Lax and scoped to the shared domain', () => {
    process.env.NODE_ENV = 'production';
    process.env.COOKIE_DOMAIN = '.vittorios.co.ke';
    const o = authController.refreshCookieOptions();
    assert.equal(o.sameSite, 'lax');
    assert.equal(o.domain, '.vittorios.co.ke');
    assert.equal(o.httpOnly, true);
  });
});
