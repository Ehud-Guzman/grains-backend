// 2026-10 audit F-07 / F-08 / F-13 / F-39 / F-46: credentials never reach a response, one-time codes are
// not bcrypt-hashed, branch staff only see their own branch's customers, notes are atomic.
process.env.NODE_ENV = 'test';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://grains-fronten.netlify.app';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const testDb = require('./helpers/testDb');
const { createBranch, createSettings, createUser } = require('./helpers/fixtures');
const app = require('../src/app');
const User = require('../src/models/User');
const customerService = require('../src/services/customer.service');
const driverService = require('../src/services/driver.service');
const passwordHash = require('../src/utils/passwordHash');
const { MIGRATIONS } = require('../src/utils/migrations');
const Order = require('../src/models/Order');

let server; let baseUrl;
before(async () => {
  await testDb.connect();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testDb.disconnect();
});
beforeEach(async () => { await testDb.clearDatabase(); });

const SECRET_KEYS = [
  'passwordHash', 'passwordResetOtpHash', 'passwordResetExpires', 'passwordResetAttempts',
  'twoFactorOtpHash', 'twoFactorExpires', 'twoFactorAttempts', 'lastLoginIp', 'lastLoginUserAgent',
  'tokenValidAfter', 'loginLockedUntil', 'failedLoginCount', 'orderHistory',
];
const findSecrets = (value, path = '$', found = []) => {
  if (Array.isArray(value)) value.forEach((v, i) => findSecrets(v, `${path}[${i}]`, found));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.includes(k)) found.push(`${path}.${k}`);
      findSecrets(v, `${path}.${k}`, found);
    }
  }
  return found;
};

const tokenFor = (u) => jwt.sign(
  { id: String(u._id), role: u.role, branchId: u.branchId ? String(u.branchId) : null },
  process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' }
);
const get = async (url, user) => {
  const res = await fetch(`${baseUrl}${url}`, { headers: { Authorization: `Bearer ${tokenFor(user)}` } });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const send = async (method, url, user, body) => {
  const res = await fetch(`${baseUrl}${url}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(user)}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

// Fully populated credential state, exactly what a real account looks like mid-reset.
const loadedUser = async (branchId, overrides) => createUser(branchId, {
  passwordHash: await bcrypt.hash('Password1', 4),
  passwordResetOtpHash: await bcrypt.hash('123456', 4),
  passwordResetExpires: new Date(Date.now() + 600000),
  twoFactorOtpHash: 'h1$abc',
  twoFactorExpires: new Date(Date.now() + 600000),
  lastLoginIp: '10.1.2.3',
  lastLoginUserAgent: 'secret-agent',
  tokenValidAfter: new Date(Date.now() - 3600000),
  failedLoginCount: 2,
  phone: `07${Math.floor(10000000 + Math.random() * 89999999)}`,
  ...overrides,
});

describe('credential fields are never returned (F-08)', () => {
  test('a plain query returns none of them, and toJSON strips them even when selected', async () => {
    const branch = await createBranch();
    const u = await loadedUser(branch._id, { role: 'customer', branchId: null });
    const plain = await User.findById(u._id).lean();
    for (const k of ['passwordHash', 'passwordResetOtpHash', 'twoFactorOtpHash', 'lastLoginIp']) {
      assert.equal(plain[k], undefined, `${k} must not be selected by default`);
    }
    const explicit = await User.findById(u._id).select('+passwordHash +passwordResetOtpHash +twoFactorOtpHash');
    assert.ok(explicit.passwordHash, 'explicit +select still works for the auth code that needs it');
    const json = JSON.parse(JSON.stringify(explicit));
    for (const k of ['passwordHash', 'passwordResetOtpHash', 'twoFactorOtpHash', 'twoFactorExpires']) {
      assert.equal(json[k], undefined, `${k} must not serialise`);
    }
  });

  test('customer profile + list, drivers, /driver/me, /auth/me and the staff list carry no secrets', async () => {
    const branch = await createBranch();
    await createSettings(branch._id);
    const supervisor = await loadedUser(branch._id, { role: 'supervisor' });
    const superadmin = await loadedUser(null, { role: 'superadmin', branchId: null });
    const customer = await loadedUser(null, { role: 'customer', branchId: null, orderedBranchIds: [branch._id] });
    const driver = await loadedUser(branch._id, { role: 'driver', vehicleInfo: { type: 'Van', plate: 'KAA 111A' } });

    const checks = [
      ['/api/admin/customers', supervisor],
      [`/api/admin/customers/${customer._id}`, supervisor],
      ['/api/admin/drivers', supervisor],
      [`/api/admin/drivers/${driver._id}`, supervisor],
      ['/api/driver/me', driver],
      ['/api/auth/me', customer],
      ['/api/auth/me', superadmin],
      ['/api/admin/users', superadmin],
    ];
    for (const [url, user] of checks) {
      const r = await get(url, user);
      assert.equal(r.status, 200, `${url} -> ${r.status}`);
      assert.deepEqual(findSecrets(r.json), [], `${url} leaked a credential/internal field`);
    }
  });
});

describe('one-time codes and password hashing (F-07)', () => {
  test('OTP hashes are HMACs bound to person + purpose, and verify in constant time', async () => {
    const h = passwordHash.hashOtp('reset:u1', '123456');
    assert.ok(h.startsWith('h1$'));
    assert.equal(await passwordHash.verifyOtp('reset:u1', '123456', h), true);
    assert.equal(await passwordHash.verifyOtp('reset:u1', '123457', h), false);
    assert.equal(await passwordHash.verifyOtp('reset:u2', '123456', h), false, 'not valid for another user');
    assert.equal(await passwordHash.verifyOtp('2fa:u1', '123456', h), false, 'not valid for another purpose');
    assert.equal(await passwordHash.verifyOtp('reset:u1', '123456', null), false);
  });

  test('a code stored in the old bcrypt format still verifies (rolling deploy)', async () => {
    const legacy = await bcrypt.hash('654321', 4);
    assert.equal(await passwordHash.verifyOtp('reset:u1', '654321', legacy), true);
    assert.equal(await passwordHash.verifyOtp('reset:u1', '000000', legacy), false);
  });

  test('password hashes interoperate with bcryptjs and never run more than the cap at once', async () => {
    const h = await passwordHash.hashPassword('Password1', 4);
    assert.equal(await bcrypt.compare('Password1', h), true);
    assert.equal(await passwordHash.comparePassword('Password1', h), true);
    assert.equal(await passwordHash.comparePassword('nope', h), false);
    assert.equal(await passwordHash.comparePassword(undefined, h), false);

    let peak = 0;
    const sample = setInterval(() => { peak = Math.max(peak, passwordHash._state().running); }, 1);
    await Promise.all(Array.from({ length: 12 }, () => passwordHash.hashPassword('Password1', 8)));
    clearInterval(sample);
    assert.ok(peak <= passwordHash._state().max, `peak concurrency ${peak} exceeded the cap`);
    assert.equal(passwordHash._state().running, 0);
  });
});

describe('hash worker lifecycle', () => {
  test('a script that hashes a password and does nothing else still exits promptly (the worker is not left holding the process open)', async () => {
    const { execFile } = require('child_process');
    const path = require('path');
    const script = `
      const ph = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'utils', 'passwordHash.js'))});
      (async () => {
        const h = await ph.hashPassword('Password1', 4);
        if (!(await ph.comparePassword('Password1', h))) process.exit(2);
      })();`;
    const started = Date.now();
    await new Promise((resolve, reject) => {
      execFile(process.execPath, ['-e', script], { timeout: 20000 }, (err) => (err ? reject(err) : resolve()));
    });
    assert.ok(Date.now() - started < 15000, 'exited well inside the timeout (a lingering worker would hold it for minutes)');
  });
});

describe('branch staff only see their own branch customers (F-13)', () => {
  let a; let b; let supA; let superadmin; let custA; let custB;
  beforeEach(async () => {
    a = await createBranch({ name: 'A', slug: 'a' });
    b = await createBranch({ name: 'B', slug: 'b' });
    await createSettings(a._id); await createSettings(b._id);
    supA = await loadedUser(a._id, { role: 'supervisor' });
    superadmin = await loadedUser(null, { role: 'superadmin', branchId: null });
    custA = await loadedUser(null, { role: 'customer', branchId: null, name: 'Alice A', orderedBranchIds: [a._id] });
    custB = await loadedUser(null, { role: 'customer', branchId: null, name: 'Bob B', orderedBranchIds: [b._id] });
  });

  test('list and profile are limited to the branch', async () => {
    const list = await get('/api/admin/customers', supA);
    assert.deepEqual(list.json.data.customers.map((c) => c.name), ['Alice A']);
    assert.equal((await get(`/api/admin/customers/${custA._id}`, supA)).status, 200);
    assert.equal((await get(`/api/admin/customers/${custB._id}`, supA)).status, 404);
  });

  test('lock, notes and b2b cannot touch another branch\'s customer', async () => {
    assert.equal((await send('PATCH', `/api/admin/customers/${custB._id}/lock`, supA)).status, 404);
    assert.equal((await send('POST', `/api/admin/customers/${custB._id}/notes`, supA, { note: 'hello there' })).status, 404);
    assert.equal((await send('PATCH', `/api/admin/customers/${custB._id}/b2b`, supA)).status, 404);
    const fresh = await User.findById(custB._id).lean();
    assert.equal(fresh.isLocked, false);
    assert.equal(fresh.isB2B, false);
    assert.ok(!fresh.notes);
    // ...and works for their own customer
    assert.equal((await send('PATCH', `/api/admin/customers/${custA._id}/lock`, supA)).status, 200);
  });

  test('a superadmin keeps the platform-wide view', async () => {
    const list = await get('/api/admin/customers', superadmin);
    assert.equal(list.json.data.customers.length, 2);
    assert.equal((await get(`/api/admin/customers/${custB._id}`, superadmin)).status, 200);
  });

  test('migration backfills orderedBranchIds from existing orders', async () => {
    const legacy = await loadedUser(null, { role: 'customer', branchId: null, name: 'Legacy' });
    await Order.collection.insertOne({ userId: legacy._id, branchId: a._id, status: 'completed', total: 100, orderRef: 'OLD-1', createdAt: new Date() });
    await MIGRATIONS[0].run();
    const fresh = await User.findById(legacy._id).lean();
    assert.deepEqual(fresh.orderedBranchIds.map(String), [String(a._id)]);
  });
});

describe('customer notes (F-46)', () => {
  test('concurrent notes are all kept, each with its author', async () => {
    const branch = await createBranch();
    const sup = await loadedUser(branch._id, { role: 'supervisor', name: 'Sue Supervisor' });
    const cust = await loadedUser(null, { role: 'customer', branchId: null, orderedBranchIds: [branch._id] });
    await Promise.all(Array.from({ length: 8 }, (_, i) =>
      customerService.addNote(cust._id, `note number ${i}`, sup._id, 'supervisor', branch._id)));
    const fresh = await User.findById(cust._id).select('notes').lean();
    const lines = fresh.notes.split('\n');
    assert.equal(lines.length, 8);
    for (let i = 0; i < 8; i++) assert.ok(lines.some((l) => l.includes(`note number ${i}`)), `note ${i} lost`);
    assert.ok(lines.every((l) => l.includes('Sue Supervisor:')));
  });

  test('notes stop at the size cap instead of growing without limit', async () => {
    const branch = await createBranch();
    const sup = await loadedUser(branch._id, { role: 'supervisor' });
    const cust = await loadedUser(null, { role: 'customer', branchId: null, orderedBranchIds: [branch._id], notes: 'x'.repeat(20000) });
    await assert.rejects(
      customerService.addNote(cust._id, 'one more', sup._id, 'supervisor', branch._id),
      (e) => e.errorCode === 'NOTES_FULL'
    );
  });
});

describe('public riders list (F-39)', () => {
  test('first name and vehicle type only - no surname, phone or plate', async () => {
    const branch = await createBranch();
    await loadedUser(branch._id, {
      role: 'driver', name: 'John Kamau Mwangi', vehicleInfo: { type: 'Motorcycle', plate: 'KMFA 123B' },
      isAvailableForDelivery: true, isLocked: false,
    });
    const riders = await driverService.getAvailablePublic(branch._id);
    assert.equal(riders.length, 1);
    assert.deepEqual(Object.keys(riders[0]).sort(), ['_id', 'name', 'vehicleInfo']);
    assert.equal(riders[0].name, 'John');
    assert.deepEqual(riders[0].vehicleInfo, { type: 'Motorcycle' });
    const res = await fetch(`${baseUrl}/api/branches/${branch._id}/riders`);
    const body = await res.json();
    assert.equal(body.data.length, 1);
    assert.deepEqual(Object.keys(body.data[0]).sort(), ['_id', 'name', 'vehicleInfo']);
    assert.deepEqual(body.data[0].vehicleInfo, { type: 'Motorcycle' });
    const text = JSON.stringify(body);
    assert.ok(!text.includes('KMFA') && !text.includes('Mwangi') && !text.includes('phone'));
  });
});

describe('driver stats (F-43)', () => {
  test('cancelled and rejected orders are not "pending" work', async () => {
    const Order = require('../src/models/Order');
    const branch = await createBranch();
    const driver = await createUser(branch._id, { role: 'driver' });
    const make = (status, n) => Order.create({
      orderRef: `ORD-DS-${n}-${Math.random()}`, orderItems: [], subtotal: 1, total: 1, branchId: branch._id,
      driverId: driver._id, status, deliveryMethod: 'delivery', paymentMethod: 'delivery',
    });
    for (const [i, st] of ['completed', 'out_for_delivery', 'preparing', 'cancelled', 'rejected'].entries()) await make(st, i);
    const stats = await driverService.getDriverStats(driver._id, branch._id);
    assert.deepEqual(stats, { total: 5, completed: 1, active: 1, cancelled: 2, pending: 1 });
  });
});
