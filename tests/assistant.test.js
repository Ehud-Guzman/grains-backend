process.env.NODE_ENV = 'test';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://grains-fronten.netlify.app';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../src/app');
const assistant = require('../src/services/assistant.service');
const { collectRoutes } = require('../src/utils/permissionMatrix');
const { readFrontendPages } = require('./helpers/frontendRoutes');
const { AREAS, CAPABILITIES, NOT_SUPPORTED } = require('../src/utils/capabilityCatalog');

const as = (role, customPermissions = []) => ({ id: 'u1', role, branchId: null, customPermissions });
const ask = (role, q, customPermissions) => assistant.ask(app, as(role, customPermissions), { q });
const topId = (role, q) => ask(role, q, []).results[0]?.id;

// Admin routes the catalogue deliberately does not describe, each with the reason. Anything
// else under /api/admin that is missing from the catalogue fails the test below — add an
// entry rather than extending this list unless the route is genuinely not user-facing.
const UNLISTED = new Map([
  ['GET /api/admin/backups/jobs/:jobId', 'progress polling for a backup the user already started'],
  ['POST /api/admin/stock/batch', 'no screen uses it; API only'],
  ['POST /api/admin/settings/test-email', 'no screen uses it; API only'],
  ['GET /api/admin/coupons/:id', 'detail read behind the coupon list'],
]);

describe('capability catalogue stays true to the server', () => {
  const routes = collectRoutes(app);
  const keys = new Set(routes.map((r) => `${r.method} ${r.path}`));

  test('ids are unique and every entry is complete', () => {
    const ids = [...CAPABILITIES, ...NOT_SUPPORTED].map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate catalogue id');
    for (const entry of CAPABILITIES) {
      assert.ok(AREAS[entry.area], `${entry.id}: unknown area ${entry.area}`);
      assert.ok(entry.title && entry.summary, `${entry.id}: needs a title and summary`);
      assert.ok(entry.keywords.length >= 3, `${entry.id}: add the words people actually type`);
      assert.ok(entry.routes.length >= 1, `${entry.id}: name the routes that implement it`);
      assert.ok(entry.steps.length >= 1, `${entry.id}: needs how-to steps`);
    }
    for (const entry of NOT_SUPPORTED) {
      assert.ok(entry.answer && entry.workaround && entry.keywords.length >= 3, `${entry.id}: incomplete`);
    }
  });

  test('every route an entry names exists', () => {
    for (const entry of CAPABILITIES) {
      for (const route of entry.routes) assert.ok(keys.has(route), `${entry.id}: no such route "${route}"`);
    }
  });

  test('every admin route is described by an entry (or listed above with a reason)', () => {
    const covered = new Set(CAPABILITIES.flatMap((e) => e.routes));
    const missing = routes
      .map((r) => `${r.method} ${r.path}`)
      .filter((k) => /\/api\/admin\//.test(k) && !k.includes('/api/admin/assistant'))
      .filter((k) => !covered.has(k) && !UNLISTED.has(k));
    assert.deepEqual(missing, [], 'admin routes with no help entry — add them to utils/capabilityCatalog.js');
  });

  test('no entry points at an unlisted route the test claims is unused', () => {
    const covered = new Set(CAPABILITIES.flatMap((e) => e.routes));
    for (const key of UNLISTED.keys()) assert.ok(!covered.has(key), `${key} is described now — remove it from UNLISTED`);
  });

  // "Take me there" must never send someone to a page the app then bounces them from. The
  // API and the React route guards are written separately, so check them against each other.
  test('every page link opens for every role the assistant offers it to', () => {
    const pages = readFrontendPages();
    if (!pages) return; // backend checked out on its own
    assert.ok(pages.size > 10, 'could not read the routes from App.jsx');

    const index = assistant.buildIndex(app);
    for (const doc of index.docs.filter((d) => d.kind === 'capability' && d.entry.page)) {
      const page = pages.get(doc.entry.page);
      assert.ok(page, `${doc.entry.id}: ${doc.entry.page} is not a page in App.jsx`);
      if (page.roles === null || page.permission) continue;
      for (const role of doc.access.roles) {
        assert.ok(page.roles.includes(role), `${doc.entry.id}: offered to ${role} but ${doc.entry.page} is closed to them — link a page they can open`);
      }
    }
  });

  test('every entry is usable by at least one role', () => {
    const index = assistant.buildIndex(app);
    for (const doc of index.docs.filter((d) => d.kind === 'capability')) {
      assert.deepEqual(doc.access.missing, [], `${doc.entry.id}: unresolved routes`);
      assert.ok(doc.access.roles.length > 0 || doc.access.grantedBy.length > 0, `${doc.entry.id}: no role can do this — are its routes contradictory?`);
    }
  });
});

describe('finding the right answer', () => {
  const cases = [
    ['admin', 'how do I approve an order', 'orders-approve'],
    ['admin', 'can the system reject an order?', 'orders-reject'],
    ['admin', 'approve many orders at once', 'orders-bulk'],
    ['admin', 'How do I cancel an order', 'orders-cancel'],
    ['admin', 'how do I assign a rider to a delivery', 'orders-assign-driver'],
    ['admin', 'the customer paid cash, how do I record it', 'payments-confirm-manual'],
    ['admin', 'can I change a product price', 'products-edit'],
    ['admin', 'add a new product', 'products-create'],
    ['admin', 'upload products from excel', 'products-import-export'],
    ['admin', 'we got new stock delivered', 'stock-delivery'],
    ['admin', 'fix the wrong stock count', 'stock-adjust'],
    ['admin', 'a truck arrived with raw sacks', 'stock-intake'],
    ['admin', 'ban a customer', 'customers-lock'],
    ['admin', 'create a discount code', 'coupons-manage'],
    ['admin', 'send an sms to all customers', 'broadcast-sms'],
    ['admin', 'end of day cash up', 'reports-cashup'],
    ['admin', 'change delivery fee', 'settings-delivery'],
    ['admin', 'turn on vat', 'settings-tax'],
    ['superadmin', 'make a backup', 'platform-backups'],
    ['superadmin', 'create a new branch', 'platform-branches'],
    ['superadmin', 'put the shop in maintenance mode', 'platform-control-switches'],
    ['superadmin', 'who changed this? I need the audit trail', 'platform-logs'],
    ['superadmin', 'force everyone to log out', 'platform-control-accounts'],
    ['superadmin', 'make someone an admin', 'platform-users'],
    ['admin', 'customer says they were charged twice', 'payments-troubleshoot'],
    ['admin', 'mpesa not working', 'payments-troubleshoot'],
    ['admin', 'print receipt', 'orders-packing-slip'],
    ['admin', 'reset driver password', 'drivers-manage'],
    ['admin', 'customer forgot password', 'no-reset-customer-password'],
    ['admin', 'change my password', 'no-own-password-screen'],
    ['admin', 'export customers', 'no-export-customers'],
    ['admin', 'aprove an order', 'orders-approve'], // typo
    ['admin', 'APPROVING ORDERS!!!', 'orders-approve'],
  ];
  for (const [role, question, expected] of cases) {
    test(`${role}: "${question}" → ${expected}`, () => {
      assert.equal(topId(role, question), expected);
    });
  }

  test('a greeting or "what can you do" gets an introduction, not a guess', () => {
    for (const q of ['hi', 'help', 'what can you do?', 'what can the system do']) {
      const r = ask('staff', q);
      assert.equal(r.outcome, 'intro', q);
      assert.ok(r.suggestions.length > 0);
    }
  });

  test('"help me approve an order" is a real question, not a greeting', () => {
    assert.equal(topId('admin', 'help me approve an order'), 'orders-approve');
  });

  test('nonsense gets "no match" with suggestions, never a confident wrong answer', () => {
    for (const q of ['purple elephants dancing', 'asdfgh qwerty', 'what is the weather in Nairobi']) {
      const r = ask('admin', q);
      assert.equal(r.outcome, 'no_match', q);
      assert.equal(r.results.length, 0);
      assert.ok(r.suggestions.length > 0);
    }
  });

  test('things the system cannot do are said plainly, with a workaround', () => {
    for (const [q, id] of [['can I delete an order', 'no-delete-order'], ['edit the items on an order', 'no-edit-placed-order'], ['refund a customer on mpesa', 'no-auto-refund'], ['delete a staff account', 'no-delete-user']]) {
      const r = ask('admin', q);
      assert.equal(r.outcome, 'not_supported', q);
      assert.equal(r.results[0].id, id);
      assert.ok(r.results[0].workaround);
    }
  });

  test('asking by topic returns that topic', () => {
    const r = assistant.ask(app, as('admin'), { topicId: 'orders-approve' });
    assert.equal(r.results[0].id, 'orders-approve');
    assert.equal(assistant.ask(app, as('admin'), { topicId: 'does-not-exist' }).outcome, 'no_match');
  });
});

describe('answers follow the caller\'s role', () => {
  test('staff can move an order along but not approve it', () => {
    assert.equal(ask('staff', 'update order status').outcome, 'answered');
    const r = ask('staff', 'approve an order');
    assert.equal(r.outcome, 'needs_role');
    assert.equal(r.results[0].id, 'orders-approve');
    assert.equal(r.results[0].allowed, false);
    assert.match(r.results[0].blockedReason, /supervisors and admins/);
    assert.match(r.results[0].blockedReason, /signed in as staff/);
  });

  test('how-to detail is withheld from a role that cannot do the thing', () => {
    const r = ask('staff', 'approve an order').results[0];
    assert.deepEqual(r.steps, []);
    assert.equal(r.page, null);
    const ok = ask('supervisor', 'approve an order');
    assert.equal(ok.outcome, 'answered');
    assert.ok(ok.results[0].steps.length > 0);
    assert.equal(ok.results[0].page, '/admin/orders');
  });

  test('a supervisor can approve and confirm payments but not add products', () => {
    assert.equal(ask('supervisor', 'confirm a cash payment').outcome, 'answered');
    assert.equal(ask('supervisor', 'add a new product').outcome, 'needs_role');
  });

  test('superadmin is told it is view-only for shop operations, not just "no"', () => {
    const r = ask('superadmin', 'approve an order');
    assert.equal(r.outcome, 'needs_role');
    assert.match(r.results[0].blockedReason, /view-only/i);
    assert.match(r.results[0].blockedReason, /branch admin or staff account/);
  });

  test('superadmin can still read business pages and run the platform', () => {
    assert.equal(ask('superadmin', 'view and search orders').outcome, 'answered');
    assert.equal(ask('superadmin', 'create a backup').outcome, 'answered');
  });

  test('platform tools are not offered to branch staff', () => {
    const r = ask('admin', 'restore a backup');
    assert.equal(r.outcome, 'needs_role');
    assert.deepEqual(r.results[0].steps, []);
    assert.deepEqual(r.results[0].requiredRoles, ['superadmin']);
  });

  test('a granted permission opens a superadmin-only tool', () => {
    assert.equal(ask('staff', 'set up kra etims credentials').outcome, 'needs_role');
    const granted = ask('staff', 'set up kra etims credentials', ['manage_etims']);
    assert.equal(granted.outcome, 'answered');
    assert.equal(granted.results[0].id, 'settings-etims');
  });

  test('the topic list marks what the caller can and cannot do', () => {
    const staffTopics = assistant.topics(app, as('staff'));
    const all = staffTopics.areas.flatMap((a) => a.items);
    assert.equal(all.find((i) => i.id === 'orders-view').allowed, true);
    assert.equal(all.find((i) => i.id === 'orders-approve').allowed, false);
    assert.equal(all.find((i) => i.id === 'platform-backups').allowed, false);
    assert.ok(staffTopics.notSupported.length > 0);
    // Allowed items are listed first within an area.
    const orders = staffTopics.areas.find((a) => a.key === 'orders').items;
    const firstBlocked = orders.findIndex((i) => !i.allowed);
    assert.ok(orders.slice(firstBlocked).every((i) => !i.allowed));
  });
});

describe('privacy of the unanswered log', () => {
  test('phone numbers and emails are masked before storing', () => {
    const masked = assistant.maskPersonalData('why did 0712 345 678 and kamau@example.com get locked, ref +254712345678');
    assert.ok(!/0712|345|kamau@|254712/.test(masked), masked);
    assert.match(masked, /\[number\]/);
    assert.match(masked, /\[email\]/);
  });

  test('"delete order" and "order delete" normalise to the same key', () => {
    const a = ask('admin', 'purple delete order');
    const b = ask('admin', 'order delete purple');
    assert.equal(a.normalized, b.normalized);
  });
});
