// URLs end up in access logs, slow-request warnings, alert emails and Sentry events. Their query strings can
// carry a customer's phone number or location (order tracking used to be GET /orders/track?phone=...), so the
// values of personal-data parameters are replaced before a URL is written anywhere (2026-10 audit, F-14).
const SENSITIVE = new Set([
  'phone', 'email', 'lat', 'lng', 'latitude', 'longitude', 'token', 'otp', 'code', 'password', 'search', 'q', 'ref',
]);

const redactQuery = (query) => {
  if (!query) return query;
  return String(query).split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0) return pair;
    const key = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' ')).toLowerCase();
    return SENSITIVE.has(key) ? `${pair.slice(0, eq)}=[redacted]` : pair;
  }).join('&');
};

const redactUrl = (url) => {
  if (!url || typeof url !== 'string') return url;
  const i = url.indexOf('?');
  if (i < 0) return url;
  let query = url.slice(i + 1);
  let hash = '';
  const h = query.indexOf('#');
  if (h >= 0) { hash = query.slice(h); query = query.slice(0, h); }
  try {
    return `${url.slice(0, i)}?${redactQuery(query)}${hash}`;
  } catch {
    return `${url.slice(0, i)}?[redacted]`; // malformed escape: drop the whole query rather than log it
  }
};

module.exports = { redactUrl, redactQuery };
