process.env.NODE_ENV = 'test';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://grains-fronten.netlify.app';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const testDb = require('./helpers/testDb');
const { createBranch, createUser } = require('./helpers/fixtures');

const app = require('../src/app');
const AssistantQuestion = require('../src/models/AssistantQuestion');
const { buildPermissionMatrix } = require('../src/utils/permissionMatrix');

let server;
let baseUrl;
let branch;

before(async () => {
  await testDb.connect();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testDb.disconnect();
});
beforeEach(async () => {
  await testDb.clearDatabase();
  branch = await createBranch();
});

const userOf = (role, extra = {}) => createUser(branch._id, {
  role,
  phone: `07${Math.floor(10000000 + Math.random() * 89999999)}`,
  ...extra,
});
const tokenFor = (user, extra = {}) => jwt.sign(
  { id: String(user._id), role: user.role, branchId: String(branch._id), ...extra },
  process.env.JWT_ACCESS_SECRET,
  { expiresIn: '10m' }
);
const call = async (method, url, { user, body, token } = {}) => {
  const res = await fetch(`${baseUrl}/api/admin/assistant${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(user || token ? { Authorization: `Bearer ${token || tokenFor(user)}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
};
// The question log is written after the response, so wait for it rather than guess.
const settled = async (predicate) => {
  for (let i = 0; i < 40; i += 1) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('assistant API — access', () => {
  test('needs a sign-in', async () => {
    assert.equal((await call('POST', '/ask', { body: { q: 'approve an order' } })).status, 401);
    assert.equal((await call('GET', '/topics')).status, 401);
  });

  test('customers and drivers are refused', async () => {
    for (const role of ['customer', 'driver']) {
      const user = await userOf(role);
      assert.equal((await call('POST', '/ask', { user, body: { q: 'approve an order' } })).status, 403, role);
      assert.equal((await call('GET', '/topics', { user })).status, 403, role);
    }
  });

  test('every admin role may ask', async () => {
    for (const role of ['staff', 'supervisor', 'admin', 'superadmin']) {
      const user = await userOf(role);
      const res = await call('POST', '/ask', { user, body: { q: 'view orders' } });
      assert.equal(res.status, 200, role);
      assert.equal(res.json.data.results[0].id, 'orders-view');
    }
  });

  test('the unanswered list is superadmin only', async () => {
    for (const role of ['staff', 'supervisor', 'admin']) {
      assert.equal((await call('GET', '/unanswered', { user: await userOf(role) })).status, 403, role);
    }
    assert.equal((await call('GET', '/unanswered', { user: await userOf('superadmin') })).status, 200);
  });
});

describe('assistant API — answers', () => {
  test('a staff member asking about approvals is told who can, without the how-to', async () => {
    const res = await call('POST', '/ask', { user: await userOf('staff'), body: { q: 'how do I approve an order?' } });
    assert.equal(res.status, 200);
    const { data } = res.json;
    assert.equal(data.outcome, 'needs_role');
    assert.deepEqual(data.results[0].steps, []);
    assert.match(data.results[0].blockedReason, /supervisors and admins/);
    // Internal bookkeeping stays server-side.
    assert.equal('normalized' in data, false);
    assert.equal('topMatchId' in data, false);
  });

  test('a supervisor gets the steps and a link', async () => {
    const res = await call('POST', '/ask', { user: await userOf('supervisor'), body: { q: 'how do I approve an order?' } });
    const result = res.json.data.results[0];
    assert.equal(res.json.data.outcome, 'answered');
    assert.ok(result.steps.length > 0);
    assert.equal(result.page, '/admin/orders');
  });

  test('a permission carried in the token is honoured', async () => {
    const staff = await userOf('staff');
    const without = await call('POST', '/ask', { user: staff, body: { q: 'set up kra etims' } });
    assert.equal(without.json.data.outcome, 'needs_role');
    const withGrant = await call('POST', '/ask', { token: tokenFor(staff, { customPermissions: ['manage_etims'] }), body: { q: 'set up kra etims' } });
    assert.equal(withGrant.json.data.outcome, 'answered');
  });

  test('topics lists what the role can and cannot do', async () => {
    const res = await call('GET', '/topics', { user: await userOf('staff') });
    assert.equal(res.status, 200);
    const items = res.json.data.areas.flatMap((a) => a.items);
    assert.equal(items.find((i) => i.id === 'orders-view').allowed, true);
    assert.equal(items.find((i) => i.id === 'platform-users').allowed, false);
    assert.ok(res.json.data.notSupported.length > 0);
  });

  test('a topic can be opened directly', async () => {
    const res = await call('POST', '/ask', { user: await userOf('admin'), body: { topicId: 'products-create' } });
    assert.equal(res.json.data.results[0].id, 'products-create');
    assert.equal(res.json.data.outcome, 'answered');
  });

  test('rejects an empty, missing, oversized or non-text question', async () => {
    const user = await userOf('admin');
    assert.equal((await call('POST', '/ask', { user, body: {} })).status, 400);
    assert.equal((await call('POST', '/ask', { user, body: { q: ' ' } })).status, 400);
    assert.equal((await call('POST', '/ask', { user, body: { q: 'x'.repeat(301) } })).status, 400);
    assert.equal((await call('POST', '/ask', { user, body: { q: ['a', 'b'] } })).status, 400);
  });
});

describe('assistant API — the unanswered log', () => {
  test('answered questions are not stored', async () => {
    await call('POST', '/ask', { user: await userOf('admin'), body: { q: 'approve an order' } });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await AssistantQuestion.countDocuments(), 0);
  });

  test('misses and "cannot do that" answers are stored, with personal data masked', async () => {
    const admin = await userOf('admin');
    await call('POST', '/ask', { user: admin, body: { q: 'purple elephants for 0712345678 kamau@example.com' } });
    await call('POST', '/ask', { user: admin, body: { q: 'can I delete an order' } });
    await settled(async () => (await AssistantQuestion.countDocuments()) === 2);

    const rows = await AssistantQuestion.find().lean();
    assert.equal(rows.length, 2);
    const miss = rows.find((r) => r.outcome === 'no_match');
    assert.ok(miss);
    assert.ok(!/0712345678|kamau@/.test(miss.example), miss.example);
    assert.equal(miss.audience, 'admin');
    assert.deepEqual(miss.roles, ['admin']);
    // Nothing ties a question to a person.
    assert.equal('userId' in miss, false);
    assert.equal(rows.find((r) => r.outcome === 'not_supported').topMatchId, 'no-delete-order');
  });

  test('a topic tap and an introduction are never logged', async () => {
    const admin = await userOf('admin');
    await call('POST', '/ask', { user: admin, body: { topicId: 'no-such-topic' } });
    await call('POST', '/ask', { user: admin, body: { q: 'hello' } });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await AssistantQuestion.countDocuments(), 0);
  });

  test('the superadmin sees repeated misses grouped, most asked first', async () => {
    const admin = await userOf('admin');
    const staff = await userOf('staff');
    await call('POST', '/ask', { user: admin, body: { q: 'purple elephants' } });
    await call('POST', '/ask', { user: staff, body: { q: 'elephants purple' } });
    await call('POST', '/ask', { user: staff, body: { q: 'zebra stripes' } });
    await settled(async () => (await AssistantQuestion.countDocuments()) === 3);

    const res = await call('GET', '/unanswered', { user: await userOf('superadmin') });
    assert.equal(res.status, 200);
    const rows = res.json.data;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].count, 2);
    assert.deepEqual([...rows[0].roles].sort(), ['admin', 'staff']);
    assert.equal(rows[0].audience, 'admin');
    assert.equal(rows[1].count, 1);
  });
});

describe('shop assistant API (/api/help) - open to visitors', () => {
  const help = async (method, url, { token, user, body } = {}) => {
    const res = await fetch(`${baseUrl}/api/help${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(user || token ? { Authorization: `Bearer ${token || tokenFor(user)}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
  };

  test('a visitor with no sign-in can ask and browse', async () => {
    const ask = await help('POST', '/ask', { body: { q: 'how do I pay with mpesa' } });
    assert.equal(ask.status, 200);
    assert.equal(ask.json.data.outcome, 'answered');
    assert.equal(ask.json.data.results[0].id, 'pay-mpesa');

    const topics = await help('GET', '/topics');
    assert.equal(topics.status, 200);
    assert.ok(topics.json.data.areas.length > 0);
  });

  test('a visitor is told to sign in for account features; a customer is not', async () => {
    const asVisitor = await help('POST', '/ask', { body: { q: 'cancel my order' } });
    assert.equal(asVisitor.json.data.outcome, 'needs_role');
    assert.match(asVisitor.json.data.results[0].blockedReason, /sign in/i);
    assert.deepEqual(asVisitor.json.data.results[0].steps, []);

    const customer = await userOf('customer');
    const asCustomer = await help('POST', '/ask', { user: customer, body: { q: 'cancel my order' } });
    assert.equal(asCustomer.json.data.outcome, 'answered');
    assert.ok(asCustomer.json.data.results[0].steps.length > 0);
  });

  test('a staff token on the storefront is just a visitor, not staff', async () => {
    const res = await help('POST', '/ask', { user: await userOf('admin'), body: { q: 'cancel my order' } });
    assert.equal(res.json.data.outcome, 'needs_role');
  });

  test('a bad token does not break it', async () => {
    const res = await help('POST', '/ask', { token: 'not-a-real-token', body: { q: 'track my order' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.results[0].id, 'track-order');
  });

  test('answers come from the shop catalogue only', async () => {
    const res = await help('POST', '/ask', { user: await userOf('customer'), body: { q: 'approve an order' } });
    assert.ok(res.json.data.results.every((r) => !r.id.startsWith('orders-')));
  });

  test('rejects an empty, oversized or non-text question', async () => {
    assert.equal((await help('POST', '/ask', { body: {} })).status, 400);
    assert.equal((await help('POST', '/ask', { body: { q: 'x'.repeat(301) } })).status, 400);
    assert.equal((await help('POST', '/ask', { body: { q: ['a'] } })).status, 400);
  });

  test('a visitor miss is logged once per wording, masked and without any identity', async () => {
    await help('POST', '/ask', { body: { q: 'purple elephants for NAI-2026-0001 and 0712345678' } });
    await help('POST', '/ask', { body: { q: 'elephants purple for NAI-2026-0002 and 0799999999' } });
    await settled(async () => {
      const row = await AssistantQuestion.findOne({ audience: 'customer' }).lean();
      return row && row.count === 2;
    });

    const rows = await AssistantQuestion.find({ audience: 'customer' }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 2);
    assert.ok(!/NAI-2026|0712|0799/.test(rows[0].example), rows[0].example);
    assert.deepEqual(rows[0].roles, ['guest']);
    assert.equal('userId' in rows[0], false);
  });

  test('answered questions and topic taps are not logged', async () => {
    await help('POST', '/ask', { body: { q: 'track my order' } });
    await help('POST', '/ask', { body: { topicId: 'checkout' } });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await AssistantQuestion.countDocuments(), 0);
  });

  test('the superadmin sees every assistant misses and can filter by audience', async () => {
    await help('POST', '/ask', { body: { q: 'zebra stripes' } });
    await call('POST', '/ask', { user: await userOf('admin'), body: { q: 'giraffe spots' } });
    await settled(async () => (await AssistantQuestion.countDocuments()) === 2);

    const superadmin = await userOf('superadmin');
    const all = await call('GET', '/unanswered', { user: superadmin });
    assert.deepEqual(all.json.data.map((r) => r.audience).sort(), ['admin', 'customer']);

    const shopOnly = await call('GET', '/unanswered?audience=customer', { user: superadmin });
    assert.equal(shopOnly.json.data.length, 1);
    assert.equal(shopOnly.json.data[0].audience, 'customer');
  });
});

describe('driver assistant API (/api/driver/assistant)', () => {
  const driverCall = async (method, url, { user, body, token } = {}) => {
    const res = await fetch(`${baseUrl}/api/driver/assistant${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(user || token ? { Authorization: `Bearer ${token || tokenFor(user)}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
  };

  test('only a signed-in driver may use it', async () => {
    assert.equal((await driverCall('POST', '/ask', { body: { q: 'mark delivered' } })).status, 401);
    for (const role of ['customer', 'staff', 'admin', 'superadmin']) {
      assert.equal((await driverCall('POST', '/ask', { user: await userOf(role), body: { q: 'mark delivered' } })).status, 403, role);
      assert.equal((await driverCall('GET', '/topics', { user: await userOf(role) })).status, 403, role);
    }
  });

  test('a driver gets driver answers', async () => {
    const driver = await userOf('driver');
    const res = await driverCall('POST', '/ask', { user: driver, body: { q: 'how do I mark a delivery as done?' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.outcome, 'answered');
    assert.equal(res.json.data.results[0].id, 'driver-complete');
    assert.equal(res.json.data.results[0].page, '/driver/dashboard');

    const topics = await driverCall('GET', '/topics', { user: driver });
    assert.equal(topics.status, 200);
    assert.ok(topics.json.data.areas.flatMap((a) => a.items).every((i) => i.allowed));
  });

  test('it keeps working while the branch is write-locked', async () => {
    const Settings = require('../src/models/Settings');
    const settingsService = require('../src/services/settings.service');
    await Settings.create({ _id: `settings_${branch._id}`, branchId: branch._id, platformLocked: true });
    settingsService.invalidateCache(branch._id);

    const driver = await userOf('driver');
    const res = await driverCall('POST', '/ask', { user: driver, body: { q: 'collect cash' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.results[0].id, 'driver-collect-payment');
  });

  test('a driver miss is logged under the driver audience', async () => {
    await driverCall('POST', '/ask', { user: await userOf('driver'), body: { q: 'purple elephants' } });
    await settled(async () => (await AssistantQuestion.countDocuments({ audience: 'driver' })) === 1);
    const row = await AssistantQuestion.findOne({ audience: 'driver' }).lean();
    assert.deepEqual(row.roles, ['driver']);
  });
});

describe('assistant API — permission matrix', () => {
  test('the new area appears in the Control Center matrix with the right roles', () => {
    const { areas } = buildPermissionMatrix(app, ['customer', 'driver', 'staff', 'supervisor', 'admin', 'superadmin']);
    const area = areas.find((a) => a.mount === '/api/admin/assistant');
    assert.ok(area);
    assert.equal(area.label, 'Help assistant');
    assert.equal(area.cells.customer.write, false);
    assert.equal(area.cells.staff.write, true);
    const unanswered = area.routes.find((r) => r.path.endsWith('/unanswered'));
    assert.deepEqual(unanswered.roles, ['superadmin']);

    const shop = areas.find((a) => a.mount === '/api/help');
    assert.ok(shop && shop.public, 'the shop assistant is open to everyone');
    const driver = areas.find((a) => a.mount === '/api/driver/assistant');
    assert.ok(driver);
    assert.equal(driver.cells.driver.write, true);
    assert.equal(driver.cells.customer.write, false);
    assert.equal(driver.cells.staff.write, false);
  });
});
