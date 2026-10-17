// The storefront origin(s) allowed to call this API with credentials.
//
// FRONTEND_URL is the primary one. FRONTEND_URLS (comma-separated) adds more, which is what makes
// moving the shop onto its own domain painless: list the old netlify.app address and the new
// www./apex address together for a while, then drop the old one.
const parseOrigin = (value) => {
  try { return new URL(value).origin; } catch { return null; }
};

const allowedOrigins = () => {
  const raw = [process.env.FRONTEND_URL, ...(process.env.FRONTEND_URLS || '').split(',')];
  return [...new Set(raw.map(v => (v || '').trim()).filter(Boolean).map(parseOrigin).filter(Boolean))];
};

// Compare parsed origins, never raw strings: a prefix check would let "<FRONTEND_URL>.evil.com" pass.
const isAllowedOriginValue = (value) => {
  const origin = parseOrigin(value);
  return !!origin && allowedOrigins().includes(origin);
};

module.exports = { allowedOrigins, isAllowedOriginValue };
