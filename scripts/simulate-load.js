#!/usr/bin/env node
'use strict';

/**
 * simulate-load.js  —  Grains System production-level traffic simulator
 *
 * Runs weighted scenarios concurrently to produce realistic API load:
 * product browsing (most common), customer & guest orders, admin approvals,
 * driver completions, token refreshes, and more — at production ratios.
 *
 * Usage:
 *   node scripts/simulate-load.js \
 *     --branch-id=<mongodb-object-id>   (required)
 *     --admin-phone=<phone>             (required — supervisor or admin)
 *     --admin-pass=<password>           (required)
 *     [--url=http://localhost:5000/api]
 *     [--duration=120]                  seconds, default 120
 *     [--concurrency=5]                 parallel workers, default 5
 *     [--rate=10]                       target requests/second, default 10
 *     [--driver-phone=<phone>]          reuse existing driver (creates one if omitted)
 *     [--driver-pass=<password>]
 *
 * Finding your branch-id:
 *   In MongoDB: db.branches.find({}) — copy the _id of your active branch.
 *   Or in the shell:  node -e "require('./src/config/db'); require('./src/models/Branch').find().then(bs => bs.forEach(b => console.log(b._id, b.name))).catch(console.error)"
 */

const axios = require('axios');

const fs   = require('fs');
const path = require('path');

// Persisted test accounts so we never hit the auth rate limit on repeated runs
const STATE_FILE = path.join(__dirname, 'simulate-load.state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(data) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2)); } catch (_) {}
}

// ─── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)(?:=(.+))?$/);
    if (m) out[m[1]] = m[2] !== undefined ? m[2] : true;
  }
  return out;
}

const A = parseArgs(process.argv.slice(2));

if (A.help || A.h) {
  console.log(`
Usage: node scripts/simulate-load.js [options]

Required:
  --branch-id=<id>         MongoDB ObjectId of the branch to target
  --admin-phone=<phone>    Supervisor or admin phone number (e.g. 0712345678)
  --admin-pass=<pass>      Admin password

Optional:
  --url=<url>              API base URL (default: http://localhost:5000/api)
  --duration=<secs>        Run duration in seconds (default: 120)
  --concurrency=<n>        Number of parallel workers (default: 5)
  --rate=<rps>             Target requests per second (default: 10)
  --driver-phone=<phone>   Reuse existing driver account (creates fresh one if omitted)
  --driver-pass=<pass>     Password for the existing driver

Production-level example (300s, 15 concurrent, 30 rps):
  node scripts/simulate-load.js \\
    --branch-id=65f1234abc5678def0123456 \\
    --admin-phone=0712345678 \\
    --admin-pass=Admin123! \\
    --duration=300 \\
    --concurrency=15 \\
    --rate=30
`);
  process.exit(0);
}


// ─── Defaults (edit these or override with CLI flags) ─────────────────────────
const DEFAULTS = {
  url:        'http://localhost:5000/api',  // or 'https://grains-backend-b3n0.onrender.com/api'
  branchId:   '69d20e7e5dbd792a8aa6e524',  // Busia Branch (default)
  adminPhone: '0799031449',
  adminPass:  '12345678',
  duration:   '120',   // seconds
  concurrency:'5',     // parallel workers
  rate:       '10',    // target requests/second
};

const CFG = {
  baseUrl:     (A['url']          || DEFAULTS.url).replace(/\/$/, ''),
  branchId:    A['branch-id']     || DEFAULTS.branchId,
  adminPhone:  A['admin-phone']   || DEFAULTS.adminPhone,
  adminPass:   A['admin-pass']    || DEFAULTS.adminPass,
  driverPhone: A['driver-phone']  || null,
  driverPass:  A['driver-pass']   || null,
  duration:    Math.max(10,  parseInt(A['duration']    || DEFAULTS.duration,    10)),
  concurrency: Math.max(1,   parseInt(A['concurrency'] || DEFAULTS.concurrency, 10)),
  targetRps:   Math.max(0.5, parseFloat(A['rate']      || DEFAULTS.rate)),
};

// ─── HTTP client ──────────────────────────────────────────────────────────────

const http = axios.create({
  baseURL: CFG.baseUrl,
  timeout: 20000,
  validateStatus: () => true,
  headers: { 'Content-Type': 'application/json' },
});

async function api(method, path, data, token) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const t0 = Date.now();
  try {
    const res = await http({ method, url: path, data: data || undefined, headers });
    const raw = res.data;
    // Unwrap the standard { success, data, message } envelope used throughout this API
    const body = (raw && raw.data !== undefined) ? raw.data : raw;
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      body,
      ms: Date.now() - t0,
    };
  } catch (err) {
    return { ok: false, status: 0, body: null, ms: Date.now() - t0, err: err.message };
  }
}

// ─── Kenyan test data pools ───────────────────────────────────────────────────

const NAMES = [
  'Akinyi Otieno', 'Barasa Wekesa', 'Chebet Rono', 'Daudi Kamau',
  'Esther Njeri', 'Francis Omondi', 'Grace Mutua', 'Hassan Juma',
  'Imani Mwangi', 'Jackline Adhiambo', 'Kelvin Oduya', 'Lilian Koech',
  'Mwangi Gitahi', 'Nancy Wambui', 'Obiero Oloo', 'Purity Wanjiku',
  'Rashid Awuor', 'Sharon Auma', 'Timothy Mugo', 'Vivian Nafula',
  'Walter Ochieng', 'Yvonne Cheruiyot', 'Zacharia Simiyu', 'Amina Abdi',
  'Brian Mutinda', 'Caroline Wairimu', 'Dennis Omondi', 'Eunice Atieno',
  'Fred Wanyama', 'Gloria Achieng', 'Henry Mukhwana', 'Irene Nasimiyu',
];

const LOCATIONS = [
  'Bungoma Town', 'Webuye', 'Malaba', 'Tongaren', 'Chwele',
  'Kimilili', 'Naitiri', 'Bumula', 'Sirisia', 'Bokoli',
  'Kanduyi', 'Musikoma', 'Ndivisi', 'Kibingei', 'Bungoma CBD',
  'Misikhu', 'Sangalo', 'Lukusi', 'Lwandanyi',
];

const PRODUCT_QUERIES = [
  'mai', 'unga', 'mahindi', 'beans', 'millet',
  'rice', 'wheat', 'sorghum', 'peas', 'barley',
];

// Phone counter — starts at a random offset from 0722000000
// Use timestamp mod as seed so each script run starts in a different range.
// 99 million possible numbers — collisions across runs are extremely rare.
let _phoneSeq = Math.floor(Date.now() / 1000) % 99000000;

function nextPhone() {
  _phoneSeq = (_phoneSeq + Math.floor(Math.random() * 999) + 1) % 99000000;
  return '07' + String(_phoneSeq).padStart(8, '0');
}

function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rndInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function newPass() { return `Test${rndInt(10000, 99999)}!`; }

// ─── Global simulation state ──────────────────────────────────────────────────

const S = {
  admin: { token: null, refreshToken: null, expiry: 0 },
  driver: { token: null, refreshToken: null, id: null, expiry: 0 },
  // [{ phone, password, token, refreshToken, expiry }]
  customers: [],
  // Products fetched from API
  products: [],
  // Tracking for admin/driver scenarios
  pendingOrders: [],   // [{ orderId, orderRef, phone }]
  assignedOrders: [],  // [{ orderId }]
};

// ─── Stats tracker ────────────────────────────────────────────────────────────

const STATS = {
  total: 0, success: 0, failed: 0,
  byName: {},
  latencies: [],
  startedAt: Date.now(),
};

function record(name, ok, ms) {
  STATS.total++;
  if (ok) STATS.success++; else STATS.failed++;
  STATS.latencies.push(ms);
  if (!STATS.byName[name]) STATS.byName[name] = { n: 0, ok: 0, ms: [] };
  STATS.byName[name].n++;
  if (ok) STATS.byName[name].ok++;
  STATS.byName[name].ms.push(ms);
}

function pctile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(Math.floor(s.length * p), s.length - 1)];
}

function printStats() {
  const elapsed = ((Date.now() - STATS.startedAt) / 1000).toFixed(1);
  const rps = (STATS.total / +elapsed || 0).toFixed(1);
  const okPct = STATS.total ? ((STATS.success / STATS.total) * 100).toFixed(1) : '0.0';
  const med = pctile(STATS.latencies, 0.5);
  const p95 = pctile(STATS.latencies, 0.95);

  console.log(`\n${'─'.repeat(74)}`);
  console.log(`  ${elapsed}s elapsed | ${STATS.total} reqs | ${rps} rps | ${okPct}% success`);
  console.log(`  Latency  median:${med}ms  p95:${p95}ms`);
  console.log(`  State    customers:${S.customers.length}  pending orders:${S.pendingOrders.length}  assigned:${S.assignedOrders.length}`);
  console.log('');
  const rows = Object.entries(STATS.byName).sort((a, b) => b[1].n - a[1].n);
  console.log(`  ${'Scenario'.padEnd(34)} ${'Reqs'.padStart(5)}  ${'OK%'.padStart(5)}  ${'med(ms)'.padStart(8)}  ${'p95(ms)'.padStart(8)}`);
  for (const [name, s] of rows) {
    const rate = s.n ? ((s.ok / s.n) * 100).toFixed(0) : '0';
    console.log(
      `  ${name.padEnd(34)} ${String(s.n).padStart(5)}  ${(rate + '%').padStart(5)}` +
      `  ${String(pctile(s.ms, 0.5)).padStart(8)}  ${String(pctile(s.ms, 0.95)).padStart(8)}`
    );
  }
  console.log(`${'─'.repeat(74)}`);
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

async function adminLogin() {
  const r1 = await api('POST', '/auth/login', { phone: CFG.adminPhone, password: CFG.adminPass });
  if (!r1.ok) {
    console.error('[auth] Login failed:', r1.status, r1.body?.message || r1.err);
    return false;
  }

  let token, refresh;
  if (r1.body.requiresBranchSelection) {
    const r2 = await api('POST', '/auth/select-branch', {
      branchId: CFG.branchId,
      preAuthToken: r1.body.preAuthToken,
    });
    if (!r2.ok) {
      console.error('[auth] Branch selection failed:', r2.status, r2.body?.message);
      return false;
    }
    token = r2.body.accessToken;
    refresh = r2.body.refreshToken;
  } else {
    token = r1.body.accessToken;
    refresh = r1.body.refreshToken;
  }

  if (!token) {
    console.error('[auth] No token in response — check branch-id or admin role');
    return false;
  }
  S.admin.token = token;
  S.admin.refreshToken = refresh;
  S.admin.expiry = Date.now() + 12 * 60 * 1000;
  return true;
}

async function ensureAdmin() {
  if (Date.now() < S.admin.expiry && S.admin.token) return true;
  if (S.admin.refreshToken) {
    const r = await api('POST', '/auth/refresh', { refreshToken: S.admin.refreshToken });
    if (r.ok && r.body.accessToken) {
      S.admin.token = r.body.accessToken;
      S.admin.refreshToken = r.body.refreshToken;
      S.admin.expiry = Date.now() + 12 * 60 * 1000;
      return true;
    }
  }
  return adminLogin();
}

async function ensureCustomerToken(c) {
  if (!c) return false;
  if (Date.now() < (c.expiry || 0) && c.token) return true;
  if (c.refreshToken) {
    const r = await api('POST', '/auth/refresh', { refreshToken: c.refreshToken });
    if (r.ok && r.body.accessToken) {
      c.token = r.body.accessToken;
      c.refreshToken = r.body.refreshToken;
      c.expiry = Date.now() + 12 * 60 * 1000;
      return true;
    }
  }
  // Re-login
  const lr = await api('POST', '/auth/login', { phone: c.phone, password: c.password });
  if (lr.ok && lr.body.accessToken) {
    c.token = lr.body.accessToken;
    c.refreshToken = lr.body.refreshToken;
    c.expiry = Date.now() + 12 * 60 * 1000;
    return true;
  }
  return false;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap() {
  console.log('\n[boot] Logging in as admin...');
  if (!await adminLogin()) {
    console.error('[boot] Admin login failed — check --admin-phone and --admin-pass.\n');
    process.exit(1);
  }
  console.log('[boot] Admin authenticated ✓');

  console.log('[boot] Fetching products...');
  // Use admin endpoint so branch context (from JWT) is applied correctly
  const pr = await api('GET', '/admin/products?limit=100&isActive=true', null, S.admin.token);
  if (pr.ok) {
    const raw = pr.body.products || (Array.isArray(pr.body) ? pr.body : []);
    S.products = raw.filter(p => Array.isArray(p.varieties) && p.varieties.length > 0);
    console.log(`[boot] ${S.products.length} products loaded ✓`);
  } else {
    console.warn('[boot] Could not fetch products:', pr.status, pr.body?.message, '— order scenarios will be skipped');
  }

  // Driver setup
  if (CFG.driverPhone && CFG.driverPass) {
    console.log('[boot] Logging in existing driver...');
    const lr = await api('POST', '/auth/login', { phone: CFG.driverPhone, password: CFG.driverPass });
    if (lr.ok && lr.body.accessToken) {
      S.driver.token = lr.body.accessToken;
      S.driver.refreshToken = lr.body.refreshToken;
      S.driver.expiry = Date.now() + 12 * 60 * 1000;
      console.log('[boot] Driver authenticated ✓');
    } else {
      console.warn('[boot] Driver login failed:', lr.body?.message);
    }
  } else {
    console.log('[boot] Creating test driver...');
    const dPhone = nextPhone();
    const dPass = `Driver${rndInt(10000, 99999)}!`;
    const dr = await api('POST', '/admin/drivers', {
      name: `Sim Driver ${rndInt(100, 999)}`,
      phone: dPhone,
      password: dPass,
      vehicleInfo: {
        type: rnd(['Motorcycle', 'Pickup', 'Van']),
        plate: `K${rnd(['CA', 'CB', 'DA', 'DB'])} ${rndInt(100, 999)}${rnd(['A', 'B', 'C', 'D'])}`,
      },
    }, S.admin.token);

    if (dr.ok) {
      const lr = await api('POST', '/auth/login', { phone: dPhone, password: dPass });
      if (lr.ok && lr.body.accessToken) {
        S.driver.token = lr.body.accessToken;
        S.driver.refreshToken = lr.body.refreshToken;
        S.driver.id = dr.body.driver?._id;
        S.driver.expiry = Date.now() + 12 * 60 * 1000;
        console.log(`[boot] Test driver created (${dPhone}) ✓`);
      }
    } else {
      console.warn('[boot] Could not create driver:', dr.body?.message, '— driver scenarios will be no-ops');
    }
  }

  // ── Customer pool ──────────────────────────────────────────────────────────
  // Load credentials saved from previous runs so we don't re-register every time
  // (the auth endpoint has a 10 req/min rate limit — registering many customers
  //  each run would blow through it immediately).
  const saved = loadState();
  const wantCustomers = Math.min(10, Math.max(5, CFG.concurrency));

  if (saved.customers?.length) {
    console.log(`[boot] Re-logging in ${saved.customers.length} saved customers...`);
    for (const c of saved.customers) {
      const r = await api('POST', '/auth/login', { phone: c.phone, password: c.password });
      if (r.ok && r.body.accessToken) {
        S.customers.push({ ...c, token: r.body.accessToken, refreshToken: r.body.refreshToken, expiry: Date.now() + 12 * 60 * 1000 });
      }
    }
    console.log(`[boot] ${S.customers.length}/${saved.customers.length} customers re-authenticated ✓`);
  }

  if (S.customers.length < wantCustomers) {
    const need = wantCustomers - S.customers.length;
    console.log(`[boot] Creating ${need} new customers (spaced 7s apart to respect auth rate limit)...`);
    for (let i = 0; i < need; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 7000)); // 10/min limit → 1 per 6s
      let r, phone, password;
      for (let attempt = 0; attempt < 5; attempt++) {
        phone = nextPhone();
        password = newPass();
        r = await api('POST', '/auth/register', { name: rnd(NAMES), phone, password });
        if (r.status !== 409) break;
      }
      if (r.ok && r.body.accessToken) {
        S.customers.push({ phone, password, token: r.body.accessToken, refreshToken: r.body.refreshToken, expiry: Date.now() + 12 * 60 * 1000 });
        console.log(`[boot] Customer ${S.customers.length}/${wantCustomers} created (${phone}) ✓`);
      } else {
        console.warn(`[boot] Customer creation failed: ${r.status} ${r.body?.message}`);
      }
    }
  }

  // Save credentials so next run skips registration entirely
  saveState({ customers: S.customers.map(c => ({ phone: c.phone, password: c.password })) });
  console.log(`[boot] ${S.customers.length} customers ready ✓ (saved to simulate-load.state.json)`);
}

// ─── Order item builder ───────────────────────────────────────────────────────

function buildOrderItems() {
  if (!S.products.length) return null;
  const count = rndInt(1, 3);
  const items = [];
  const shuffled = [...S.products].sort(() => Math.random() - 0.5);
  for (const prod of shuffled.slice(0, count)) {
    const variety = rnd(prod.varieties);
    if (!variety?.packaging?.length) continue;
    const available = variety.packaging.filter(p => !p.quoteOnly);
    if (!available.length) continue;
    const pkg = rnd(available);
    items.push({
      productId: prod._id,
      variety: variety.varietyName,
      packaging: pkg.size,
      quantity: rndInt(1, 5),
    });
  }
  return items.length ? items : null;
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

// --- Public browsing (most common) ---

async function sc_browseProducts() {
  const r = await api('GET', `/products?limit=20&page=${rndInt(1, 4)}`);
  if (r.ok && S.products.length) {
    // Simulate clicking into a product
    const p = rnd(S.products);
    await api('GET', `/products/${p._id}`);
  }
  return r.ok;
}

async function sc_searchProducts() {
  const r = await api('GET', `/products/suggestions?q=${rnd(PRODUCT_QUERIES)}`);
  return r.ok;
}

async function sc_productCategories() {
  const r = await api('GET', '/products/categories');
  return r.ok;
}

async function sc_checkSettings() {
  const r = await api('GET', '/settings');
  return r.ok;
}

async function sc_deliveryFee() {
  // Simulate customer checking delivery fee before ordering
  const lats = [-0.5616, -0.5800, -0.5400, -0.5700];
  const lngs = [34.5608, 34.5900, 34.5300, 34.5800];
  const i = rndInt(0, lats.length - 1);
  const r = await api('GET', `/settings/delivery-fee?lat=${lats[i]}&lng=${lngs[i]}`);
  return r.ok;
}

async function sc_trackOrder() {
  if (!S.pendingOrders.length) return false;
  const o = rnd(S.pendingOrders);
  const r = await api('GET', `/orders/track?phone=${encodeURIComponent(o.phone)}&ref=${encodeURIComponent(o.orderRef)}`);
  return r.ok;
}

// --- Auth flows ---

async function sc_register() {
  const phone = nextPhone();
  const password = newPass();
  const r = await api('POST', '/auth/register', { name: rnd(NAMES), phone, password });
  if (r.ok && r.body.accessToken) {
    S.customers.push({ phone, password, token: r.body.accessToken, refreshToken: r.body.refreshToken, expiry: Date.now() + 12 * 60 * 1000 });
  }
  return r.ok;
}

async function sc_customerLogin() {
  if (!S.customers.length) return sc_register();
  const c = rnd(S.customers);
  const r = await api('POST', '/auth/login', { phone: c.phone, password: c.password });
  if (r.ok && r.body.accessToken) {
    c.token = r.body.accessToken;
    c.refreshToken = r.body.refreshToken;
    c.expiry = Date.now() + 12 * 60 * 1000;
  }
  return r.ok;
}

async function sc_refreshToken() {
  if (!S.customers.length) return false;
  const c = rnd(S.customers);
  if (!c.refreshToken) return false;
  const r = await api('POST', '/auth/refresh', { refreshToken: c.refreshToken });
  if (r.ok && r.body.accessToken) {
    c.token = r.body.accessToken;
    c.refreshToken = r.body.refreshToken;
    c.expiry = Date.now() + 12 * 60 * 1000;
  }
  return r.ok;
}

async function sc_getProfile() {
  if (!S.customers.length) return false;
  const c = rnd(S.customers);
  if (!await ensureCustomerToken(c)) return false;
  const r = await api('GET', '/auth/me', null, c.token);
  return r.ok;
}

// --- Customer order flows ---

async function sc_customerOrder() {
  if (!S.customers.length || !S.products.length) return false;
  const c = rnd(S.customers);
  if (!await ensureCustomerToken(c)) return false;

  const items = buildOrderItems();
  if (!items) return false;

  const delivery = Math.random() > 0.35;
  const r = await api('POST', '/orders', {
    orderItems: items,
    deliveryMethod: delivery ? 'delivery' : 'pickup',
    deliveryAddress: delivery ? rnd(LOCATIONS) : undefined,
    paymentMethod: Math.random() > 0.55 ? 'mpesa' : (delivery ? 'delivery' : 'pickup'),
    specialInstructions: Math.random() > 0.8 ? 'Please call on arrival' : undefined,
  }, c.token);

  if (r.ok) {
    const o = r.body.order || r.body.data?.order;
    if (o) {
      S.pendingOrders.push({ orderId: o._id, orderRef: o.orderRef, phone: c.phone });
      // Cap list size to avoid unbounded memory growth
      if (S.pendingOrders.length > 200) S.pendingOrders.shift();
    }
  }
  return r.ok;
}

async function sc_guestOrder() {
  if (!S.products.length) return false;
  const items = buildOrderItems();
  if (!items) return false;

  const phone = nextPhone();
  const delivery = Math.random() > 0.45;
  const r = await api('POST', '/orders/guest', {
    name: rnd(NAMES),
    phone,
    orderItems: items,
    deliveryMethod: delivery ? 'delivery' : 'pickup',
    deliveryAddress: delivery ? rnd(LOCATIONS) : undefined,
    paymentMethod: Math.random() > 0.55 ? 'mpesa' : (delivery ? 'delivery' : 'pickup'),
  });

  if (r.ok) {
    const o = r.body.order || r.body.data?.order;
    if (o) {
      S.pendingOrders.push({ orderId: o._id, orderRef: o.orderRef, phone, isGuest: true });
      if (S.pendingOrders.length > 200) S.pendingOrders.shift();
    }
  }
  return r.ok;
}

async function sc_myOrders() {
  if (!S.customers.length) return false;
  const c = rnd(S.customers);
  if (!await ensureCustomerToken(c)) return false;
  const r = await api('GET', '/orders/my?limit=10', null, c.token);
  return r.ok;
}

async function sc_cancelOrder() {
  // Cancel a recently placed pending order (low frequency — simulates buyer's remorse)
  const cancellable = S.pendingOrders.filter(o => !o.isGuest);
  if (!cancellable.length || !S.customers.length) return false;
  const o = rnd(cancellable);
  const c = S.customers.find(cu => cu.phone === o.phone);
  if (!c || !await ensureCustomerToken(c)) return false;
  const r = await api('PATCH', `/orders/${o.orderId}/cancel`, {}, c.token);
  if (r.ok) {
    const idx = S.pendingOrders.findIndex(p => p.orderId === o.orderId);
    if (idx !== -1) S.pendingOrders.splice(idx, 1);
  }
  return r.ok;
}

// --- Admin operations ---

async function sc_adminDashboard() {
  if (!await ensureAdmin()) return false;
  const r = await api('GET', '/admin/reports/kpis', null, S.admin.token);
  return r.ok;
}

async function sc_adminViewOrders() {
  if (!await ensureAdmin()) return false;
  const status = rnd(['pending', 'approved', 'preparing', 'out_for_delivery', 'completed']);
  const r = await api('GET', `/admin/orders?status=${status}&limit=20`, null, S.admin.token);
  return r.ok;
}

async function sc_adminApproveOrders() {
  if (!await ensureAdmin()) return false;

  const r = await api('GET', '/admin/orders?status=pending&limit=10', null, S.admin.token);
  if (!r.ok) return false;

  const orders = (r.body.orders || r.body.data?.orders || []).slice(0, 4);
  if (!orders.length) return true; // nothing to approve right now

  let approved = 0;
  for (const order of orders) {
    const ar = await api('PATCH', `/admin/orders/${order._id}/approve`, {}, S.admin.token);
    if (ar.ok) {
      approved++;
      S.assignedOrders.push({ orderId: order._id });
      if (S.assignedOrders.length > 100) S.assignedOrders.shift();

      const idx = S.pendingOrders.findIndex(o => String(o.orderId) === String(order._id));
      if (idx !== -1) S.pendingOrders.splice(idx, 1);

      // Assign driver ~60% of the time
      if (S.driver.id && Math.random() > 0.4) {
        await api('PATCH', `/admin/orders/${order._id}/assign-driver`,
          { driverId: S.driver.id }, S.admin.token);
      }
    }
  }
  return approved > 0;
}

async function sc_adminRejectOrder() {
  if (!await ensureAdmin()) return false;
  const r = await api('GET', '/admin/orders?status=pending&limit=5', null, S.admin.token);
  if (!r.ok) return false;
  const orders = r.body.orders || r.body.data?.orders || [];
  if (!orders.length) return true;
  const order = rnd(orders);
  const reasons = ['Out of stock', 'Delivery address unclear', 'Customer unreachable', 'Payment issues'];
  const rr = await api('PATCH', `/admin/orders/${order._id}/reject`,
    { reason: rnd(reasons) }, S.admin.token);
  return rr.ok;
}

async function sc_adminViewCustomers() {
  if (!await ensureAdmin()) return false;
  const r = await api('GET', `/admin/customers?limit=20&page=${rndInt(1, 3)}`, null, S.admin.token);
  return r.ok;
}

async function sc_adminViewStock() {
  if (!await ensureAdmin()) return false;
  const r = await api('GET', '/admin/stock', null, S.admin.token);
  return r.ok;
}

async function sc_adminViewReports() {
  if (!await ensureAdmin()) return false;
  const period = rnd(['today', 'week', 'month']);
  const report = rnd(['sales', 'best-sellers', 'customers', 'orders']);
  let path = `/admin/reports/${report}`;
  if (report === 'sales') path += `?period=${period}`;
  const r = await api('GET', path, null, S.admin.token);
  return r.ok;
}

async function sc_adminViewDrivers() {
  if (!await ensureAdmin()) return false;
  const r = await api('GET', '/admin/drivers', null, S.admin.token);
  return r.ok;
}

// --- Driver operations ---

async function sc_driverGetOrders() {
  if (!S.driver.token) return false;
  const r = await api('GET', '/driver/orders', null, S.driver.token);
  return r.ok;
}

async function sc_driverCompleteDelivery() {
  if (!S.driver.token) return false;

  const r = await api('GET', '/driver/orders', null, S.driver.token);
  if (!r.ok) return false;

  const orders = r.body.orders || r.body.data?.orders || [];
  const active = orders.filter(o => o.status === 'out_for_delivery');
  if (!active.length) return true; // nothing to complete right now

  const o = rnd(active);
  const cr = await api('PATCH', `/driver/orders/${o._id}/complete`, {}, S.driver.token);
  if (cr.ok) {
    const idx = S.assignedOrders.findIndex(a => String(a.orderId) === String(o._id));
    if (idx !== -1) S.assignedOrders.splice(idx, 1);
  }
  return cr.ok;
}

async function sc_driverToggleAvailability() {
  if (!S.driver.token) return false;
  // Drivers are mostly available; go unavailable occasionally
  const r = await api('PATCH', '/driver/availability',
    { isAvailable: Math.random() > 0.15 }, S.driver.token);
  return r.ok;
}

async function sc_driverProfile() {
  if (!S.driver.token) return false;
  const r = await api('GET', '/driver/me', null, S.driver.token);
  return r.ok;
}

// ─── Weighted scenario table ──────────────────────────────────────────────────
//
// Weights reflect realistic production ratios:
//   ~55% public browsing & reads
//   ~12% auth (register, login, token refresh)
//   ~19% customer orders & order checks
//   ~9%  admin operations
//   ~5%  driver operations

const SCENARIOS = [
  // ─ Public reads (high frequency) ─
  { name: 'browse_products',        weight: 22, fn: sc_browseProducts },
  { name: 'search_products',        weight: 12, fn: sc_searchProducts },
  { name: 'product_categories',     weight: 7,  fn: sc_productCategories },
  { name: 'check_settings',         weight: 5,  fn: sc_checkSettings },
  { name: 'track_order',            weight: 5,  fn: sc_trackOrder },
  { name: 'delivery_fee_check',     weight: 4,  fn: sc_deliveryFee },

  // ─ Auth ─
  { name: 'register_customer',      weight: 4,  fn: sc_register },
  { name: 'customer_login',         weight: 5,  fn: sc_customerLogin },
  { name: 'refresh_token',          weight: 2,  fn: sc_refreshToken },
  { name: 'get_profile',            weight: 1,  fn: sc_getProfile },

  // ─ Customer order flows ─
  { name: 'customer_order',         weight: 10, fn: sc_customerOrder },
  { name: 'guest_order',            weight: 5,  fn: sc_guestOrder },
  { name: 'my_orders',              weight: 3,  fn: sc_myOrders },
  { name: 'cancel_order',           weight: 1,  fn: sc_cancelOrder },

  // ─ Admin ─
  { name: 'admin_approve_orders',   weight: 3,  fn: sc_adminApproveOrders },
  { name: 'admin_view_orders',      weight: 2,  fn: sc_adminViewOrders },
  { name: 'admin_dashboard',        weight: 2,  fn: sc_adminDashboard },
  { name: 'admin_view_reports',     weight: 1,  fn: sc_adminViewReports },
  { name: 'admin_view_customers',   weight: 1,  fn: sc_adminViewCustomers },
  { name: 'admin_view_stock',       weight: 1,  fn: sc_adminViewStock },
  { name: 'admin_view_drivers',     weight: 1,  fn: sc_adminViewDrivers },
  { name: 'admin_reject_order',     weight: 1,  fn: sc_adminRejectOrder },

  // ─ Driver ─
  { name: 'driver_complete',        weight: 2,  fn: sc_driverCompleteDelivery },
  { name: 'driver_get_orders',      weight: 1,  fn: sc_driverGetOrders },
  { name: 'driver_availability',    weight: 1,  fn: sc_driverToggleAvailability },
  { name: 'driver_profile',         weight: 1,  fn: sc_driverProfile },
];

const TOTAL_WEIGHT = SCENARIOS.reduce((s, sc) => s + sc.weight, 0);

function pickScenario() {
  let r = Math.random() * TOTAL_WEIGHT;
  for (const sc of SCENARIOS) {
    r -= sc.weight;
    if (r <= 0) return sc;
  }
  return SCENARIOS[0];
}

// ─── Worker ───────────────────────────────────────────────────────────────────

let RUNNING = true;

async function worker() {
  const intervalMs = (CFG.concurrency / CFG.targetRps) * 1000;
  while (RUNNING) {
    const sc = pickScenario();
    const t0 = Date.now();
    let ok = false;
    try {
      ok = !!(await sc.fn());
    } catch (_) {
      // swallow individual errors — keep the worker alive
    }
    record(sc.name, ok, Date.now() - t0);
    // Jitter interval so workers don't fire in lockstep
    await new Promise(r => setTimeout(r, intervalMs * (0.5 + Math.random())));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('════════════════════════════════════════════════════════════════════');
  console.log('  Grains System  —  Production Load Simulator');
  console.log('════════════════════════════════════════════════════════════════════');
  console.log(`  API:         ${CFG.baseUrl}`);
  console.log(`  Branch ID:   ${CFG.branchId}`);
  console.log(`  Duration:    ${CFG.duration}s`);
  console.log(`  Workers:     ${CFG.concurrency} concurrent`);
  console.log(`  Target rate: ${CFG.targetRps} req/s`);
  console.log('════════════════════════════════════════════════════════════════════');

  await bootstrap();

  console.log('\n[sim] Starting simulation — press Ctrl+C to stop early\n');
  STATS.startedAt = Date.now();

  const statsTimer = setInterval(printStats, 15000);

  const stopTimer = setTimeout(() => {
    RUNNING = false;
    clearInterval(statsTimer);
    console.log('\n[sim] Duration reached — waiting for workers to finish...');
  }, CFG.duration * 1000);

  process.on('SIGINT', () => {
    RUNNING = false;
    clearInterval(statsTimer);
    clearTimeout(stopTimer);
    console.log('\n[sim] Interrupted.');
  });

  await Promise.allSettled(
    Array.from({ length: CFG.concurrency }, () => worker())
  );

  console.log('\n════════════════════  FINAL RESULTS  ═══════════════════════════════');
  printStats();
  process.exit(0);
}

main().catch(err => {
  console.error('[fatal]', err.message);
  process.exit(1);
});
