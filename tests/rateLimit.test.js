process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'a'.repeat(64);

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { publicLimiter } = require('../src/middleware/rateLimit.middleware');
const { RATE_LIMITS } = require('../src/utils/constants');

const listen = () => new Promise((resolve) => {
  const app = express();
  app.use('/api', publicLimiter);
  app.get('/api/ping', (req, res) => res.json({ ok: true }));
  const server = app.listen(0, () => resolve(server));
});

const get = (server, headers = {}) => new Promise((resolve, reject) => {
  http.get({ port: server.address().port, path: '/api/ping', headers, agent: false }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  }).on('error', reject);
});

const burst = async (server, n, headers) => {
  const codes = [];
  for (let i = 0; i < n; i++) codes.push(await get(server, headers));
  return codes;
};

test('anonymous traffic is capped per IP', async () => {
  const server = await listen();
  try {
    const codes = await burst(server, RATE_LIMITS.PUBLIC_MAX + 5);
    assert.equal(codes.filter(c => c === 200).length, RATE_LIMITS.PUBLIC_MAX);
    assert.equal(codes.at(-1), 429);
  } finally { server.close(); }
});

test('a signed-in user is not locked out by anonymous traffic from the same IP', async () => {
  const server = await listen();
  try {
    await burst(server, RATE_LIMITS.PUBLIC_MAX + 5); // exhaust the anonymous bucket
    const token = jwt.sign({ id: 'user-1', role: 'admin' }, process.env.JWT_ACCESS_SECRET);
    const codes = await burst(server, 50, { Authorization: `Bearer ${token}` });
    assert.ok(codes.every(c => c === 200), `signed-in requests were throttled: ${codes.filter(c => c !== 200).length}`);
  } finally { server.close(); }
});

test('a forged token gets no extra allowance', async () => {
  const server = await listen();
  try {
    const forged = jwt.sign({ id: 'user-2', role: 'admin' }, 'x'.repeat(64));
    const codes = await burst(server, RATE_LIMITS.PUBLIC_MAX + 5, { Authorization: `Bearer ${forged}` });
    assert.equal(codes.at(-1), 429);
  } finally { server.close(); }
});

// ── a client-chosen ?branchId= must never buy a fresh bucket ───────────────────
// The key used to include any well-formed 24-hex ?branchId= from the query string, so appending a
// new random one to every request gave every request its own bucket: 14/14 login attempts and 9/9
// STK pushes got through. Only the verified JWT may contribute a branch to the key.
const crypto = require('node:crypto');
const { authLimiter, stkLimiter, guestOrderLimiter } = require('../src/middleware/rateLimit.middleware');

const listenWith = (limiter) => new Promise((resolve) => {
  const app = express();
  app.post('/api/limited', limiter, (req, res) => res.json({ ok: true }));
  const server = app.listen(0, () => resolve(server));
});

const post = (server, query = '') => new Promise((resolve, reject) => {
  const req = http.request(
    { port: server.address().port, path: `/api/limited${query}`, method: 'POST', agent: false },
    (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }
  );
  req.on('error', reject);
  req.end();
});

const randomHex = () => crypto.randomBytes(12).toString('hex');

for (const [name, limiter, max] of [
  ['login/auth limiter', authLimiter, RATE_LIMITS.AUTH_MAX],
  ['STK push limiter', stkLimiter, RATE_LIMITS.STK_MAX],
  ['guest order limiter', guestOrderLimiter, RATE_LIMITS.GUEST_ORDER_MAX],
]) {
  test(`${name} cannot be bypassed with a random ?branchId= on every request`, async () => {
    const server = await listenWith(limiter);
    try {
      const codes = [];
      for (let i = 0; i < max + 4; i++) codes.push(await post(server, `?branchId=${randomHex()}`));
      assert.equal(codes.filter(c => c === 200).length, max, `expected exactly ${max} allowed, got ${codes.join(',')}`);
      assert.equal(codes.at(-1), 429);
    } finally { server.close(); }
  });
}

test('the anonymous limiter cannot be bypassed with a random ?branchId= either', async () => {
  const server = await listen();
  try {
    const codes = [];
    for (let i = 0; i < RATE_LIMITS.PUBLIC_MAX + 5; i++) {
      codes.push(await new Promise((resolve, reject) => {
        http.get({ port: server.address().port, path: `/api/ping?branchId=${randomHex()}`, agent: false }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        }).on('error', reject);
      }));
    }
    // Earlier tests in this file share the per-IP bucket, so it may already be partly used - the
    // bypass shows as MORE than PUBLIC_MAX requests getting through, never fewer.
    assert.ok(codes.filter(c => c === 200).length <= RATE_LIMITS.PUBLIC_MAX, 'random ?branchId= minted fresh buckets');
    assert.equal(codes.at(-1), 429);
  } finally { server.close(); }
});
