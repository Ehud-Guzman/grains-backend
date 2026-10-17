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
