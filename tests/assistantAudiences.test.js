process.env.NODE_ENV = 'test';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://grains-fronten.netlify.app';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../src/app');
const assistant = require('../src/services/assistant.service');
const { collectRoutes } = require('../src/utils/permissionMatrix');
const customerCatalog = require('../src/utils/customerCatalog');
const driverCatalog = require('../src/utils/driverCatalog');
const { readFrontendPages } = require('./helpers/frontendRoutes');

const guest = { id: null, role: 'guest', customPermissions: [] };
const customer = { id: 'c1', role: 'customer', customPermissions: [] };
const driver = { id: 'd1', role: 'driver', customPermissions: [] };

const askAs = (audience, user, q) => assistant.ask(app, user, { q }, audience);
const topId = (audience, user, q) => askAs(audience, user, q).results[0]?.id;

// Routes under an audience's mounts that the catalogue deliberately does not describe, each
// with the reason. Anything else missing fails — add an entry rather than extending these
// unless the route is genuinely not something the audience does.
const UNLISTED = {
  customer: new Map([
    ['POST /api/auth/refresh', 'silent token renewal, not a task'],
    ['POST /api/auth/logout', 'sign-out button'],
    ['POST /api/auth/verify-2fa', 'staff sign-in step'],
    ['POST /api/auth/select-branch', 'staff sign-in step'],
    ['POST /api/auth/switch-branch', 'staff branch switcher'],
    ['GET /api/auth/onboarding', 'internal progress tracking for the Help Center checklist'],
    ['PATCH /api/auth/onboarding', 'internal progress tracking for the Help Center checklist'],
    ['POST /api/auth/avatar', 'no avatar upload on the customer profile page'],
    ['GET /api/products/price-changes', 'small price-change badges on the home page'],
    ['GET /api/products/batch', 'bulk lookup used by the cart to refresh prices'],
    ['GET /api/products/:id/best-time', 'a "good time to buy" badge on the product page'],
    ['POST /api/payments/mpesa/callback', 'called by Safaricom, not by a person'],
    ['POST /api/payments/mpesa/callback/:token', 'called by Safaricom, not by a person'],
    ['GET /api/branches/:branchId/riders', 'fills the Preferred Rider list at checkout'],
  ]),
  driver: new Map(),
};

const AUDIENCES = [
  ['customer', customerCatalog],
  ['driver', driverCatalog],
];

for (const [name, catalog] of AUDIENCES) {
  describe(`${name} catalogue stays true to the server`, () => {
    const routes = collectRoutes(app);
    const keys = new Set(routes.map((r) => `${r.method} ${r.path}`));

    test('ids are unique and every entry is complete', () => {
      const ids = [...catalog.CAPABILITIES, ...catalog.NOT_SUPPORTED].map((e) => e.id);
      assert.equal(new Set(ids).size, ids.length, 'duplicate catalogue id');
      for (const entry of catalog.CAPABILITIES) {
        assert.ok(catalog.AREAS[entry.area], `${entry.id}: unknown area ${entry.area}`);
        assert.ok(entry.title && entry.summary, `${entry.id}: needs a title and summary`);
        assert.ok(entry.keywords.length >= 3, `${entry.id}: add the words people actually type`);
        assert.ok(entry.steps.length >= 1, `${entry.id}: needs how-to steps`);
        if (entry.clientOnly) assert.equal((entry.routes || []).length, 0, `${entry.id}: clientOnly entries have no routes`);
        else assert.ok(entry.routes && entry.routes.length >= 1, `${entry.id}: name the routes that implement it, or mark it clientOnly`);
      }
      for (const entry of catalog.NOT_SUPPORTED) {
        assert.ok(entry.answer && entry.workaround && entry.keywords.length >= 3, `${entry.id}: incomplete`);
      }
      for (const id of catalog.STARTERS) assert.ok(ids.includes(id), `starter "${id}" does not exist`);
      assert.ok(catalog.INTRO.length > 20);
    });

    test('every route an entry names exists', () => {
      for (const entry of catalog.CAPABILITIES) {
        for (const route of [...(entry.routes || []), ...(entry.covers || [])]) {
          assert.ok(keys.has(route), `${entry.id}: no such route "${route}"`);
        }
      }
    });

    test('every route under the audience\'s mounts is described (or listed with a reason)', () => {
      const covered = new Set(catalog.CAPABILITIES.flatMap((e) => [...(e.routes || []), ...(e.covers || [])]));
      const unlisted = UNLISTED[name];
      const missing = routes
        .map((r) => `${r.method} ${r.path}`)
        .filter((k) => catalog.MOUNTS.some((m) => k.split(' ')[1].startsWith(m)))
        .filter((k) => !k.includes('/assistant'))
        .filter((k) => !covered.has(k) && !unlisted.has(k));
      assert.deepEqual(missing, [], `routes with no ${name} help entry — add them to the catalogue`);
    });

    test('nothing marked unlisted is described now', () => {
      const covered = new Set(catalog.CAPABILITIES.flatMap((e) => [...(e.routes || []), ...(e.covers || [])]));
      for (const key of UNLISTED[name].keys()) assert.ok(!covered.has(key), `${key} is described now — remove it from UNLISTED`);
    });

    test('every entry is usable by at least one role', () => {
      const index = assistant.buildIndex(app, name);
      for (const doc of index.docs.filter((d) => d.kind === 'capability')) {
        assert.deepEqual(doc.access.missing, [], `${doc.entry.id}: unresolved routes`);
        assert.ok(doc.access.roles.length > 0, `${doc.entry.id}: no role can do this — are its routes contradictory?`);
      }
    });

    test('every page link opens for every role the assistant offers it to', () => {
      const pages = readFrontendPages();
      if (!pages) return; // backend checked out on its own
      const index = assistant.buildIndex(app, name);
      for (const doc of index.docs.filter((d) => d.kind === 'capability' && d.entry.page)) {
        const page = pages.get(doc.entry.page);
        assert.ok(page, `${doc.entry.id}: ${doc.entry.page} is not a page in App.jsx`);
        if (page.roles === null || page.permission) continue;
        for (const role of doc.access.roles) {
          assert.ok(page.roles.includes(role), `${doc.entry.id}: offered to ${role} but ${doc.entry.page} is closed to them — link a page they can open`);
        }
      }
    });
  });
}

describe('customer assistant — finding the answer', () => {
  const cases = [
    ['how do I pay with mpesa', 'pay-mpesa'],
    ['i did not get the mpesa prompt', 'pay-problem'],
    ['my payment failed, can i pay on delivery instead', 'pay-problem'],
    ['where is my order', 'track-order'],
    ['how long will my order take to be approved', 'order-statuses'],
    ['what does out for delivery mean', 'order-statuses'],
    ['how do i cancel my order', 'cancel-order'],
    ['i want to order the same things again', 'reorder'],
    ['how do i make an order', 'checkout'],
    ['can i buy without an account', 'checkout'],
    ['how much do you charge for delivery', 'delivery-fee'],
    ['do you have a minimum order', 'delivery-fee'],
    ['i have a discount code', 'coupon'],
    ['how do i register', 'register'],
    ['i forgot my password', 'forgot-password'],
    ['change my password', 'change-password'],
    ['save my address', 'addresses'],
    ['stop the promotional sms', 'promo-sms'],
    ['tell me when maize is back in stock', 'stock-alerts'],
    ['save a shopping list', 'saved-lists'],
    ['i need a receipt', 'receipt'],
    ['how can i contact you', 'contact-shop'],
    ['search for rice', 'shop-browse'],
    ['how much is a 90kg bag', 'product-details'],
    ['has the price of maize gone up', 'price-trends'],
    ['which branch am i buying from', 'branch-pick'],
    ['what is my loyalty tier', 'loyalty'],
  ];
  for (const [question, expected] of cases) {
    test(`"${question}" → ${expected}`, () => {
      assert.equal(topId('customer', customer, question), expected);
    });
  }

  test('things the shop does not offer are said plainly, with what to do instead', () => {
    for (const [q, id] of [
      ['can i pay by visa card', 'no-card-payments'],
      ['edit my order after i placed it', 'no-edit-placed-order'],
      ['cancel an order that was approved', 'no-cancel-after-approval'],
      ['i want a refund', 'no-self-refund'],
      ['choose the delivery time', 'no-time-slot'],
      ['delete my account', 'no-delete-account'],
      ['change my phone number', 'no-change-phone'],
    ]) {
      const r = askAs('customer', customer, q);
      assert.equal(r.outcome, 'not_supported', q);
      assert.equal(r.results[0].id, id, q);
      assert.ok(r.results[0].workaround);
    }
  });

  test('nonsense gets suggestions, never a confident wrong answer', () => {
    for (const q of ['purple elephants dancing', 'who won the football', 'asdf qwerty']) {
      const r = askAs('customer', customer, q);
      assert.equal(r.outcome, 'no_match', q);
      assert.ok(r.suggestions.length > 0);
    }
  });

  test('a greeting gets the customer introduction', () => {
    const r = askAs('customer', guest, 'hi');
    assert.equal(r.outcome, 'intro');
    assert.match(r.message, /shopping with us/);
  });
});

describe('customer assistant — visitors versus signed-in customers', () => {
  test('a visitor can be told how to order, track, browse and pay', () => {
    for (const q of ['how do i place an order', 'track my order', 'search for maize', 'pay with mpesa', 'delivery fee', 'use a coupon', 'create an account']) {
      assert.equal(askAs('customer', guest, q).outcome, 'answered', q);
    }
  });

  test('a visitor is told to sign in for things that need an account, without the steps', () => {
    for (const [q, id] of [
      ['cancel my order', 'cancel-order'],
      ['see my past orders', 'my-orders'],
      ['save a shopping list', 'saved-lists'],
      ['alert me when the price drops', 'stock-alerts'],
      ['change my password', 'change-password'],
      ['update my profile', 'profile-edit'],
    ]) {
      const r = askAs('customer', guest, q);
      assert.equal(r.outcome, 'needs_role', q);
      assert.equal(r.results[0].id, id, q);
      assert.match(r.results[0].blockedReason, /sign in/i);
      assert.deepEqual(r.results[0].steps, []);
      assert.equal(r.results[0].page, null);
    }
  });

  test('the same questions get full answers once signed in', () => {
    for (const q of ['cancel my order', 'see my past orders', 'save a shopping list', 'update my profile']) {
      const r = askAs('customer', customer, q);
      assert.equal(r.outcome, 'answered', q);
      assert.ok(r.results[0].steps.length > 0);
      assert.ok(r.results[0].page);
    }
  });

  test('a business role browsing the shop is treated as a visitor, never as staff', () => {
    const { asCustomerOrGuest } = require('../src/controllers/assistant.controller');
    assert.equal(asCustomerOrGuest({ user: { id: 's1', role: 'admin' } }).role, 'guest');
    assert.equal(asCustomerOrGuest({ user: { id: 'c1', role: 'customer' } }).role, 'customer');
    assert.equal(asCustomerOrGuest({ user: null }).role, 'guest');
  });

  test('the topic list marks what needs an account', () => {
    const list = assistant.topics(app, guest, 'customer');
    const all = list.areas.flatMap((a) => a.items);
    assert.equal(all.find((i) => i.id === 'checkout').allowed, true);
    assert.equal(all.find((i) => i.id === 'cancel-order').allowed, false);
    assert.match(list.intro, /shopping with us/);
    assert.ok(list.notSupported.length > 0);
  });

  test('the customer assistant never mentions admin-only things', () => {
    const text = JSON.stringify(assistant.buildIndex(app, 'customer').docs.map((d) => d.entry));
    assert.ok(!/\/api\/admin\//.test(text));
  });
});

describe('driver assistant — finding the answer', () => {
  const cases = [
    ['how do i mark a delivery as done', 'driver-complete'],
    ['take a photo as proof of delivery', 'driver-complete'],
    ['do i collect cash from the customer', 'driver-collect-payment'],
    ['the order says not marked paid', 'driver-collect-payment'],
    ['how do i go offline', 'driver-availability'],
    ['i am on a break', 'driver-availability'],
    ['where are my orders', 'driver-orders'],
    ['how do i get directions to the customer', 'driver-navigate'],
    ['call the customer', 'driver-navigate'],
    ['how many deliveries have i done today', 'driver-dashboard'],
    ['i forgot my password', 'driver-forgot-password'],
    ['change my profile photo', 'driver-photo'],
    ['how do i log in', 'driver-login'],
  ];
  for (const [question, expected] of cases) {
    test(`"${question}" → ${expected}`, () => {
      assert.equal(topId('driver', driver, question), expected);
    });
  }

  test('what the office does is said plainly, with who to call', () => {
    for (const [q, id] of [
      ['can i decline an order', 'no-driver-decline'],
      ['mark the order out for delivery', 'no-driver-start-delivery'],
      ['confirm the customer paid me', 'no-driver-confirm-payment'],
      ['cancel the delivery the customer moved', 'no-driver-cancel'],
      ['how much will i earn', 'no-driver-earnings'],
      ['update my vehicle plate', 'no-driver-edit-details'],
      ['see other drivers orders', 'no-driver-other-orders'],
    ]) {
      const r = askAs('driver', driver, q);
      assert.equal(r.outcome, 'not_supported', q);
      assert.equal(r.results[0].id, id, q);
      assert.ok(r.results[0].workaround);
    }
  });

  test('every driver feature is open to a driver, with steps and a page', () => {
    const list = assistant.topics(app, driver, 'driver');
    const all = list.areas.flatMap((a) => a.items);
    assert.ok(all.length >= 8);
    assert.ok(all.every((i) => i.allowed));
    const r = askAs('driver', driver, 'mark a delivery as done');
    assert.equal(r.outcome, 'answered');
    assert.ok(r.results[0].steps.length > 0);
    assert.equal(r.results[0].page, '/driver/dashboard');
  });

  test('a greeting gets the driver introduction', () => {
    assert.match(askAs('driver', driver, 'help').message, /driver portal/);
  });
});

describe('the three assistants stay separate', () => {
  test('a customer question is not answered from the admin or driver catalogue', () => {
    const r = askAs('customer', customer, 'approve an order');
    assert.notEqual(r.results[0]?.id, 'orders-approve');
    assert.ok(r.results.every((x) => !x.id.startsWith('orders-')));
  });

  test('a driver question is not answered from the customer catalogue', () => {
    const r = askAs('driver', driver, 'track an order');
    assert.ok(r.results.every((x) => x.id !== 'track-order'));
  });

  test('an unknown audience is rejected rather than falling back', () => {
    assert.throws(() => assistant.ask(app, customer, { q: 'hello' }, 'nobody'), /Unknown assistant audience/);
  });

  test('the key used to group repeated questions never carries personal data', () => {
    const a = askAs('customer', guest, 'purple elephants for kamau@example.com 0712345678 NAI-2026-0001 QDK14KSHD7');
    const b = askAs('customer', guest, 'elephants purple for wanjiru@example.org 0799999999 NAI-2026-0042 ABC12DEF3G');
    assert.equal(a.outcome, 'no_match');
    assert.equal(a.normalized, b.normalized, 'same question, different personal details, should group');
    assert.ok(!/\d|kamau|wanjiru|example|qdk14/i.test(a.normalized), a.normalized);
  });

  test('masking also covers order references and M-Pesa codes', () => {
    const masked = assistant.maskPersonalData('order NAI-2026-0001 paid with QDK14KSHD7 by 0712 345 678');
    assert.ok(!/NAI-2026|QDK14KSHD7|0712/.test(masked), masked);
    assert.match(masked, /\[order\]/);
    assert.match(masked, /\[code\]/);
    assert.match(masked, /\[number\]/);
  });
});
