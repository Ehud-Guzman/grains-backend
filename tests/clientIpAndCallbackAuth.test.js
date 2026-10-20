// 2026-10 audit F-11: the real client address behind Netlify/Cloudflare, and a callback proof that does not
// depend on which proxy chain delivered the request.
process.env.NODE_ENV = 'test';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://grains-fronten.netlify.app';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const { applyClientIp, pickValid } = require('../src/utils/clientIp');
const testDb = require('./helpers/testDb');
const { createBranch, createUser } = require('./helpers/fixtures');
const app = require('../src/app');
const paymentService = require('../src/services/payment.service');

describe('applyClientIp', () => {
  const run = (headers) => {
    const req = { headers, ip: '10.9.9.9' };
    applyClientIp(req, {}, () => {});
    return req.ip;
  };
  afterEach(() => { delete process.env.CLIENT_IP_HEADER; });

  test('does nothing unless CLIENT_IP_HEADER is set - a forged header cannot change req.ip by default', () => {
    assert.equal(run({ 'x-nf-client-connection-ip': '1.2.3.4' }), '10.9.9.9');
  });
  test('uses the configured header when it holds a valid address, otherwise keeps the hop-based answer', () => {
    process.env.CLIENT_IP_HEADER = 'X-NF-Client-Connection-IP';
    assert.equal(run({ 'x-nf-client-connection-ip': '41.90.1.2' }), '41.90.1.2');
    assert.equal(run({ 'x-nf-client-connection-ip': '2a00:1450::1' }), '2a00:1450::1');
    assert.equal(run({ 'x-nf-client-connection-ip': 'not-an-ip' }), '10.9.9.9');
    assert.equal(run({}), '10.9.9.9', 'no header (e.g. a Safaricom callback) -> normal resolution');
  });
  test('takes the first address of a list', () => {
    assert.equal(pickValid('41.90.1.2, 10.0.0.1'), '41.90.1.2');
    assert.equal(pickValid(undefined), null);
  });
  test('the rate limiter sees the overridden address through a real express app', async () => {
    process.env.CLIENT_IP_HEADER = 'x-nf-client-connection-ip';
    const a = express();
    a.use(applyClientIp);
    a.get('/ip', (req, res) => res.json({ ip: req.ip }));
    const server = await new Promise((r) => { const s = a.listen(0, () => r(s)); });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/ip`, { headers: { 'x-nf-client-connection-ip': '41.90.1.2' } });
      assert.equal((await res.json()).ip, '41.90.1.2');
    } finally { server.close(); }
  });
});

describe('M-Pesa callback authentication', () => {
  let server; let baseUrl; let received;
  const original = paymentService.handleCallback;
  const body = { Body: { stkCallback: { CheckoutRequestID: 'ws_CO_123', ResultCode: 0 } } };
  const post = (path) => fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  before(async () => {
    await testDb.connect();
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    paymentService.handleCallback = original;
    await new Promise((resolve) => server.close(resolve));
    await testDb.disconnect();
  });
  beforeEach(() => {
    received = 0;
    paymentService.handleCallback = async () => { received += 1; return { success: true }; };
    process.env.MPESA_ENV = 'production';       // the IP allow-list is only enforced in production
  });
  afterEach(() => { delete process.env.MPESA_ENV; delete process.env.MPESA_CALLBACK_TOKEN; });

  test('from an unknown address with no token: answered 200 but NOT processed (as before)', async () => {
    const res = await post('/api/payments/mpesa/callback');
    assert.equal(res.status, 200);
    assert.equal(received, 0);
  });

  test('with the right secret token in the URL it is processed whatever address it came from', async () => {
    process.env.MPESA_CALLBACK_TOKEN = 's3cret-token-value';
    assert.equal((await post('/api/payments/mpesa/callback/s3cret-token-value')).status, 200);
    assert.equal(received, 1);
  });

  test('a wrong token, or a token when none is configured, does not authorise anything', async () => {
    process.env.MPESA_CALLBACK_TOKEN = 's3cret-token-value';
    await post('/api/payments/mpesa/callback/not-the-token');
    await post('/api/payments/mpesa/callback');
    delete process.env.MPESA_CALLBACK_TOKEN;
    await post('/api/payments/mpesa/callback/s3cret-token-value');
    assert.equal(received, 0);
  });

  test('outside production (sandbox / dev) callbacks are accepted as before', async () => {
    delete process.env.MPESA_ENV;
    await post('/api/payments/mpesa/callback');
    assert.equal(received, 1);
  });
});

describe('network diagnostics endpoint', () => {
  before(async () => { await testDb.connect(); });
  after(async () => { await testDb.disconnect(); });

  test('superadmin only, and shows what the server resolved', async () => {
    await testDb.clearDatabase();
    const branch = await createBranch();
    const sa = await createUser(null, { role: 'superadmin', branchId: null, tokenValidAfter: new Date(Date.now() - 3600000) });
    const staff = await createUser(branch._id, { role: 'admin', tokenValidAfter: new Date(Date.now() - 3600000) });
    const tok = (u) => jwt.sign({ id: String(u._id), role: u.role, branchId: u.branchId ? String(u.branchId) : null }, process.env.JWT_ACCESS_SECRET, { expiresIn: '5m' });
    const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    try {
      const url = `http://127.0.0.1:${server.address().port}/api/admin/control-center/network`;
      assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${tok(staff)}` } })).status, 403);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${tok(sa)}`, 'X-Forwarded-For': '41.1.1.1' } });
      assert.equal(res.status, 200);
      const data = (await res.json()).data;
      assert.ok('resolvedIp' in data && 'trustProxy' in data && 'headers' in data);
    } finally { server.close(); }
  });
});
