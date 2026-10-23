const { collectRoutes } = require('../utils/permissionMatrix');
const adminCatalog = require('../utils/capabilityCatalog');
const customerCatalog = require('../utils/customerCatalog');
const driverCatalog = require('../utils/driverCatalog');
const { ROLES } = require('../utils/constants');
const AssistantQuestion = require('../models/AssistantQuestion');
const logger = require('../utils/logger');

// The help assistant: answers "can the system do X, and how?" for the person asking.
//
// There is one engine and three catalogues — admin (staff to superadmin), customer (shoppers,
// signed in or not) and driver. It answers only from the caller's catalogue and decides who
// may do what by reading the real route guards, so it never invents a feature and never
// promises a role something the server would refuse. There is no model behind it: matching is
// plain keyword scoring, which is instant, free and cannot hallucinate.

const ROLE_LABEL = { staff: 'staff', supervisor: 'supervisors', admin: 'admins', superadmin: 'superadmins' };

const adminBlocked = (doc, user) => {
  const { roles, grantedBy } = doc.access;
  if (!roles.length) return 'This cannot be done from the admin panel with any role.';
  if (user.role === ROLES.SUPERADMIN) {
    return 'Superadmin is a view-only role for day-to-day shop operations. Sign in with a branch admin or staff account to do this.';
  }
  const who = roles.map((r) => ROLE_LABEL[r] || r).join(' and ');
  const lowest = roles[0];
  const permission = grantedBy.length ? ` A superadmin can also grant you the "${grantedBy.join('" or "')}" permission.` : '';
  return `Only ${who} can do this — you are signed in as ${user.role}. Ask your ${lowest === 'superadmin' ? 'superadmin' : lowest} to do it.${permission}`;
};

const customerBlocked = (doc, user) => (
  user.role === ROLES.GUEST && doc.access.roles.includes(ROLES.CUSTOMER)
    ? 'You need to sign in first — or create a free account — to do this.'
    : 'This is not something you can do yourself. Contact the shop and they can help.'
);

const driverBlocked = () => 'This is handled by the office. Call your supervisor or admin.';

const AUDIENCES = {
  admin: {
    catalog: adminCatalog,
    roles: [ROLES.STAFF, ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.SUPERADMIN],
    blockedReason: adminBlocked,
  },
  customer: {
    catalog: customerCatalog,
    roles: [ROLES.GUEST, ROLES.CUSTOMER],
    blockedReason: customerBlocked,
  },
  driver: {
    catalog: driverCatalog,
    roles: [ROLES.DRIVER],
    blockedReason: driverBlocked,
  },
};

const MIN_SCORE = 0.35;       // below this the best guess is not worth showing as an answer
const MAX_RESULTS = 3;
const SUGGEST_FLOOR = 0.12;   // "did you mean" candidates

// ── TEXT NORMALISING ──────────────────────────────────────────────────────────
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'i', 'we', 'you', 'me', 'my', 'our', 'to', 'of', 'for', 'in', 'on', 'at', 'is', 'are', 'am',
  'be', 'can', 'could', 'do', 'does', 'did', 'how', 'what', 'when', 'why', 'which', 'who', 'should',
  'would', 'will', 'able', 'possible', 'system', 'it', 'this', 'that', 'and', 'or', 'with', 'from', 'by',
  'there', 'way', 'please', 'want', 'need', 'like', 'get', 'go', 'about', 'if', 'any', 'some', 'us', 'just',
  'help', 'show', 'tell', 'does', 'make', 'sure',
]);

// Light stemming: enough that "approving", "approved" and "approve" meet, applied
// identically to the question and to the catalogue so they always agree.
function stem(word) {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(sses|ches|shes|xes)$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

// Words people use interchangeably. Keys and values are stemmed on load.
const SYNONYMS = Object.fromEntries(Object.entries({
  add: 'create', new: 'create', remove: 'delete', erase: 'delete', edit: 'update',
  change: 'update', modify: 'update', amend: 'update', block: 'lock', ban: 'lock', suspend: 'lock',
  freeze: 'lock', unblock: 'unlock', unban: 'unlock', disable: 'deactivate', hide: 'deactivate',
  enable: 'activate', rider: 'driver', courier: 'driver', client: 'customer', buyer: 'customer',
  accept: 'approve', decline: 'reject', refuse: 'reject', texting: 'sms', inventory: 'stock',
}).map(([k, v]) => [stem(k), stem(v)]));

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !STOP_WORDS.has(w))
    .map((w) => {
      const s = stem(w);
      return SYNONYMS[s] || s;
    })
    .filter(Boolean);
}

function editDistanceAtMostOne(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}

// ── INDEX ─────────────────────────────────────────────────────────────────────
// Built once per app and audience: the catalogue, tokenised, with who may use each entry.
const indexCache = new WeakMap();

function routeKey(method, path) { return `${method.toUpperCase()} ${path}`; }

function audienceOf(name) {
  const audience = AUDIENCES[name];
  if (!audience) throw new Error(`Unknown assistant audience "${name}"`);
  return audience;
}

// Which of the audience's roles may use an entry.
//   • every route in `routes` must admit the role (so the answer is the intersection);
//   • a public route admits everyone, a signed-in-only route admits everyone but a visitor;
//   • an entry with no routes (`clientOnly`) is open to all, or to signed-in roles with `signedIn`.
function resolveAccess(entry, routeIndex, audience) {
  const universe = audience.roles;
  const signedIn = universe.filter((r) => r !== ROLES.GUEST);
  const missing = [];
  const grantedBy = new Set();

  if (!entry.routes || entry.routes.length === 0) {
    return { roles: entry.signedIn ? signedIn : universe.slice(), grantedBy: [], missing };
  }

  let roles = null;
  for (const key of entry.routes) {
    const route = routeIndex.get(key);
    if (!route) { missing.push(key); continue; }
    let routeRoles;
    if (route.auth === false) routeRoles = universe;
    else if (!route.roles) routeRoles = signedIn;
    else routeRoles = route.roles.filter((r) => universe.includes(r));
    roles = roles ? roles.filter((r) => routeRoles.includes(r)) : routeRoles.slice();
    if (route.grantedBy) grantedBy.add(route.grantedBy);
  }
  return { roles: roles || [], grantedBy: [...grantedBy], missing };
}

function addTokens(map, tokens, weight) {
  for (const t of tokens) if (!map.has(t) || map.get(t) < weight) map.set(t, weight);
}

function buildDoc(entry, kind, areas, extra) {
  const weights = new Map();
  addTokens(weights, tokenize(areas[entry.area] || ''), 1);
  addTokens(weights, tokenize(entry.summary || entry.answer || ''), 1);
  addTokens(weights, tokenize([...(entry.steps || []), ...(entry.notes || []), entry.workaround || ''].join(' ')), 0.5);
  const phrases = entry.keywords.map(tokenize).filter((t) => t.length);
  for (const phrase of phrases) addTokens(weights, phrase, 2.5);
  addTokens(weights, tokenize(entry.title), 3);
  return { entry, kind, weights, phrases, ...extra };
}

function buildIndex(app, audienceName = 'admin') {
  let perApp = indexCache.get(app);
  if (!perApp) { perApp = new Map(); indexCache.set(app, perApp); }
  if (perApp.has(audienceName)) return perApp.get(audienceName);

  const audience = audienceOf(audienceName);
  const { CAPABILITIES, NOT_SUPPORTED, AREAS } = audience.catalog;

  const routeIndex = new Map();
  for (const route of collectRoutes(app)) {
    const key = routeKey(route.method, route.path);
    if (!routeIndex.has(key)) routeIndex.set(key, route);
  }

  const docs = [
    ...CAPABILITIES.map((entry) => buildDoc(entry, 'capability', AREAS, { access: resolveAccess(entry, routeIndex, audience) })),
    ...NOT_SUPPORTED.map((entry) => buildDoc(entry, 'not_supported', AREAS, { access: null })),
  ];

  // How many entries each word appears in: a word in every entry ("order", "customer")
  // says little, a rare one ("etims", "backup") says a lot.
  const docFrequency = new Map();
  for (const doc of docs) for (const t of doc.weights.keys()) docFrequency.set(t, (docFrequency.get(t) || 0) + 1);

  const index = { audience: audienceName, config: audience, docs, docFrequency, byId: new Map(docs.map((d) => [d.entry.id, d])), routeIndex };
  perApp.set(audienceName, index);
  return index;
}

// ── ACCESS ────────────────────────────────────────────────────────────────────
function canUse(doc, user) {
  const { roles, grantedBy } = doc.access;
  if (roles.includes(user.role)) return true;
  return grantedBy.some((permission) => (user.customPermissions || []).includes(permission));
}

function presentCapability(doc, user, index) {
  const { entry, access } = doc;
  const allowed = canUse(doc, user);
  return {
    id: entry.id,
    kind: 'capability',
    area: entry.area,
    areaLabel: index.config.catalog.AREAS[entry.area],
    title: entry.title,
    summary: entry.summary,
    allowed,
    requiredRoles: access.roles,
    requiredPermission: access.grantedBy[0] || null,
    blockedReason: allowed ? null : index.config.blockedReason(doc, user),
    // How-to detail is only handed to someone who can actually do it.
    page: allowed ? entry.page || null : null,
    steps: allowed ? entry.steps : [],
    notes: allowed ? entry.notes || [] : [],
  };
}

function presentNotSupported(doc) {
  const { entry } = doc;
  return {
    id: entry.id,
    kind: 'not_supported',
    title: entry.title,
    summary: entry.answer,
    workaround: entry.workaround,
    allowed: false,
  };
}

const present = (doc, user, index) => (doc.kind === 'capability' ? presentCapability(doc, user, index) : presentNotSupported(doc));

// ── MATCHING ──────────────────────────────────────────────────────────────────
function scoreDoc(doc, queryTokens, index) {
  const total = index.docs.length;
  let earned = 0;
  let possible = 0;
  for (const q of queryTokens) {
    const idf = Math.log(1 + total / (index.docFrequency.get(q) || 1));
    possible += 3 * idf;
    let best = doc.weights.get(q) || 0;
    if (!best && q.length >= 5) {
      for (const [t, w] of doc.weights) {
        if (t.length >= 5 && editDistanceAtMostOne(q, t)) best = Math.max(best, w * 0.8);
      }
    }
    earned += best * idf;
  }
  if (!possible) return 0;

  // A whole keyword phrase being present ("bulk approve", "reset password") is a much
  // stronger signal than the same words scattered about.
  const qset = new Set(queryTokens);
  let phraseBonus = 0;
  for (const phrase of doc.phrases) {
    if (phrase.length > 1 && phrase.every((t) => qset.has(t))) phraseBonus = Math.max(phraseBonus, 0.25);
  }
  return Math.min(1, earned / possible) + phraseBonus;
}

const GREETING = /^(hi|hello|hey|help|menu|start|what can (you|i) do|what do you do|what can the system do|what is this)\b/i;

function suggestionsFor(index, user, limit = 4) {
  const allowed = index.docs.filter((d) => d.kind === 'capability' && canUse(d, user));
  const preferred = (index.config.catalog.STARTERS || []).map((id) => index.byId.get(id)).filter((d) => d && allowed.includes(d));
  const rest = allowed.filter((d) => !preferred.includes(d));
  return [...preferred, ...rest].slice(0, limit).map((d) => ({ id: d.entry.id, title: d.entry.title }));
}

function messageFor(outcome) {
  if (outcome === 'answered') return 'Yes — you can do that. Here is how:';
  if (outcome === 'not_supported') return 'No, the system cannot do that.';
  return 'The system can do that, but not with your role.';
}

function outcomeOf(result) {
  if (result.kind === 'not_supported') return 'not_supported';
  return result.allowed ? 'answered' : 'needs_role';
}

function ask(app, user, { q, topicId }, audienceName = 'admin') {
  const index = buildIndex(app, audienceName);

  if (topicId) {
    const doc = index.byId.get(topicId);
    if (!doc) return { outcome: 'no_match', message: 'I could not find that topic.', results: [], suggestions: suggestionsFor(index, user) };
    const result = present(doc, user, index);
    const outcome = outcomeOf(result);
    return { outcome, message: messageFor(outcome), results: [result], suggestions: [] };
  }

  const text = String(q || '').trim();
  // A bare greeting or "what can you do?" — but not "help me approve an order".
  if (GREETING.test(text) && tokenize(text.replace(GREETING, '')).length === 0) {
    return { outcome: 'intro', message: index.config.catalog.INTRO, results: [], suggestions: suggestionsFor(index, user) };
  }

  const queryTokens = [...new Set(tokenize(text))];
  const scored = queryTokens.length
    ? index.docs.map((doc) => ({ doc, score: scoreDoc(doc, queryTokens, index) })).sort((a, b) => b.score - a.score)
    : [];
  const top = scored[0];
  const normalized = groupingKey(text);

  if (!top || top.score < MIN_SCORE) {
    const near = scored.filter((s) => s.score >= SUGGEST_FLOOR && s.doc.kind === 'capability' && canUse(s.doc, user)).slice(0, 4);
    return {
      outcome: 'no_match',
      message: 'I could not find anything that matches that. Try different words, or pick one of these. If it is something you expected, it has been noted for the team.',
      results: [],
      suggestions: near.length
        ? near.map((s) => ({ id: s.doc.entry.id, title: s.doc.entry.title }))
        : suggestionsFor(index, user),
      normalized,
    };
  }

  const cutoff = Math.max(MIN_SCORE, top.score * 0.7);
  const results = scored.filter((s) => s.score >= cutoff).slice(0, MAX_RESULTS).map((s) => present(s.doc, user, index));
  const outcome = outcomeOf(results[0]);
  return { outcome, message: messageFor(outcome), results, suggestions: [], topMatchId: results[0].id, normalized };
}

// ── TOPICS ────────────────────────────────────────────────────────────────────
function topics(app, user, audienceName = 'admin') {
  const index = buildIndex(app, audienceName);
  const areas = Object.entries(index.config.catalog.AREAS).map(([key, label]) => {
    const items = index.docs
      .filter((d) => d.kind === 'capability' && d.entry.area === key)
      .map((d) => ({ id: d.entry.id, title: d.entry.title, allowed: canUse(d, user) }))
      .sort((a, b) => Number(b.allowed) - Number(a.allowed));
    return { key, label, items };
  }).filter((a) => a.items.length);

  return {
    areas,
    notSupported: index.docs.filter((d) => d.kind === 'not_supported').map((d) => ({ id: d.entry.id, title: d.entry.title })),
    suggestions: suggestionsFor(index, user),
    intro: index.config.catalog.INTRO,
  };
}

// ── UNANSWERED LOG ────────────────────────────────────────────────────────────
// A to-do list for the team: wording the catalogue misses and features people expect.
//   • One row per distinct (audience, question, outcome) with a count — never one row per ask —
//     so a visitor hammering the box cannot grow the collection, and nothing ties a question to a
//     person.
//   • Phone numbers, emails, order references and M-Pesa codes are masked before storing.
//   • Only misses and "the system cannot do that" are kept; answered questions never are.
const MAX_DISTINCT_QUESTIONS = 5000;

function maskPersonalData(text) {
  return String(text)
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')
    .replace(/\b[A-Za-z]{2,4}-\d{4}-\d{3,6}\b/g, '[order]')
    .replace(/\b(?=[A-Z0-9]{10}\b)(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{10}\b/g, '[code]')
    .replace(/\+?\d[\d\s-]{4,}\d/g, '[number]')
    .slice(0, 300);
}

// What "the same question" means when counting: the sorted word stems of the masked text, so
// "delete order" and "order delete" group together, and "...0712345678" and "...0799999999" do
// too. Built from the masked text and never from digits, so it cannot carry a phone number,
// email or reference into the database.
function groupingKey(text) {
  const words = tokenize(maskPersonalData(text)).filter((t) => !/\d/.test(t));
  return [...new Set(words)].sort().join(' ').slice(0, 300);
}

async function recordUnanswered(audience, user, text, result) {
  if (!['no_match', 'not_supported'].includes(result.outcome) || !result.normalized) return;
  const now = new Date();
  const key = { audience, normalized: result.normalized, outcome: result.outcome };
  const bump = {
    $inc: { count: 1 },
    $set: { lastAskedAt: now, example: maskPersonalData(text), topMatchId: result.topMatchId || null },
    $addToSet: { roles: user.role },
  };
  try {
    const seen = await AssistantQuestion.updateOne(key, bump);
    if (seen.matchedCount) return;
    if ((await AssistantQuestion.estimatedDocumentCount()) >= MAX_DISTINCT_QUESTIONS) return;
    await AssistantQuestion.updateOne(key, { ...bump, $setOnInsert: { firstAskedAt: now } }, { upsert: true });
  } catch (err) {
    // Telemetry must never break a help answer (and a lost race on the unique key is harmless).
    if (err.code !== 11000) logger.warn('[assistant] could not record question', { err: err.message });
  }
}

async function getUnanswered({ days = 90, limit = 50, audience = null } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const filter = { lastAskedAt: { $gte: since } };
  if (audience && AUDIENCES[audience]) filter.audience = audience;
  const rows = await AssistantQuestion.find(filter)
    .sort({ count: -1, lastAskedAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 200))
    .lean();
  return rows.map((r) => ({
    audience: r.audience,
    outcome: r.outcome,
    example: r.example,
    count: r.count,
    lastAsked: r.lastAskedAt,
    roles: r.roles,
    topMatchId: r.topMatchId,
  }));
}

module.exports = {
  AUDIENCES, ask, topics, recordUnanswered, getUnanswered, buildIndex, tokenize, maskPersonalData, MIN_SCORE,
};
