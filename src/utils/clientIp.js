const net = require('net');

// Production traffic reaches the API through more than one kind of front door - browser -> Netlify's /api
// proxy -> Cloudflare -> Render for the shop, and Safaricom -> Cloudflare -> Render for M-Pesa callbacks -
// so no single `trust proxy` hop count resolves `req.ip` to the real client for both. Left alone, req.ip
// can be an edge server shared by thousands of visitors, which turns every per-IP rate limit into a
// shop-wide cap (2026-10 audit, F-11).
//
// CLIENT_IP_HEADER names a request header that carries the real client address, set by an edge the API
// trusts: e.g. `x-nf-client-connection-ip` (Netlify) or `cf-connecting-ip` (Cloudflare). When set and the
// header holds a valid IP, req.ip becomes that address for everything downstream (rate limits, logs,
// alerts). When the header is absent (a Safaricom callback, a health check) the normal hop-based answer is
// kept. Only enable it for a header your edge OVERWRITES on every request - otherwise a client can invent
// addresses to dodge rate limits. Use GET /api/admin/control-center/network to see what the server sees.
const clientIpHeader = () => String(process.env.CLIENT_IP_HEADER || '').trim().toLowerCase();

const pickValid = (value) => {
  if (!value) return null;
  const first = String(Array.isArray(value) ? value[0] : value).split(',')[0].trim();
  return net.isIP(first) ? first : null;
};

const applyClientIp = (req, _res, next) => {
  const header = clientIpHeader();
  if (header) {
    const ip = pickValid(req.headers[header]);
    if (ip) Object.defineProperty(req, 'ip', { value: ip, configurable: true, enumerable: true, writable: true });
  }
  next();
};

// What the server sees for this request - for the diagnostics endpoint.
const describeNetwork = (req) => ({
  resolvedIp: req.ip || null,
  forwardedIps: req.ips || [],
  trustProxy: req.app?.get?.('trust proxy') ?? null,
  clientIpHeader: clientIpHeader() || null,
  socketAddress: req.socket?.remoteAddress || null,
  headers: {
    'x-forwarded-for': req.headers['x-forwarded-for'] || null,
    'cf-connecting-ip': req.headers['cf-connecting-ip'] || null,
    'x-nf-client-connection-ip': req.headers['x-nf-client-connection-ip'] || null,
    'x-real-ip': req.headers['x-real-ip'] || null,
  },
});

module.exports = { applyClientIp, describeNetwork, pickValid };
