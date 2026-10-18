// ── M-PESA HELPER UTILITIES ───────────────────────────────────────────────────

// Safaricom callback IP whitelist (from Daraja docs)
const SAFARICOM_IPS = [
  '196.201.214.200', '196.201.214.206', '196.201.213.114',
  '196.201.214.207', '196.201.214.208', '196.201.213.44',
  '196.201.212.127', '196.201.212.138', '196.201.212.129',
  '196.201.212.136', '196.201.212.74',  '196.201.212.69'
];

// Format phone to Daraja format: 2547XXXXXXXX
// Accepts: 07XXXXXXXX, +2547XXXXXXXX, 2547XXXXXXXX
const formatPhone = (phone) => {
  const cleaned = phone.replace(/\s+/g, '').replace(/[^0-9+]/g, '');

  if (cleaned.startsWith('+254')) return cleaned.slice(1);           // +254... → 254...
  if (cleaned.startsWith('254'))  return cleaned;                     // already correct
  if (cleaned.startsWith('07'))   return '254' + cleaned.slice(1);   // 07... → 2547...
  if (cleaned.startsWith('01'))   return '254' + cleaned.slice(1);   // 01... → 2541...
  if (cleaned.startsWith('7'))    return '254' + cleaned;            // 7... → 2547...

  throw new Error(`Cannot format phone number: ${phone}`);
};

// Generate timestamp in YYYYMMDDHHmmss format (Daraja requirement)
// Daraja expects Nairobi time (UTC+3, no DST). Render runs in UTC, and the old
// local-clock version sent a timestamp three hours behind.
const generateTimestamp = (now = new Date()) => {
  const d = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
         `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
};

// Generate STK push password: Base64(shortcode + passkey + timestamp)
const generatePassword = (shortcode, passkey, timestamp) => {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
};

// Safaricom occasionally adds callback addresses. Rather than waiting for a code change, the owner
// can append them (comma-separated) in MPESA_CALLBACK_EXTRA_IPS on Render.
const allowedCallbackIps = () => [
  ...SAFARICOM_IPS,
  ...String(process.env.MPESA_CALLBACK_EXTRA_IPS || '').split(',').map((s) => s.trim()).filter(Boolean),
];

// What the server knows about who is calling - logged and emailed whenever a callback is turned
// away, so a wrong guess about Render's proxy chain is visible in minutes instead of silently
// swallowing every real payment confirmation.
const describeCallbackSource = (req) => ({
  'Resolved IP (req.ip)': req.ip || 'none',
  'X-Forwarded-For': req.headers?.['x-forwarded-for'] || 'none',
  'Socket address': req.socket?.remoteAddress || 'none',
  'Trusted proxy hops': String(req.app?.get?.('trust proxy') ?? 'unknown'),
});

// Validate that a callback is coming from Safaricom's IPs.
// Uses only req.ip — Express resolves the client IP from X-Forwarded-For using the `trust proxy`
// hop count (TRUST_PROXY_HOPS, default 1). Reading the raw header as a fallback would allow an
// attacker to spoof it.
// In development/sandbox — allow all IPs.
const validateSafaricomIP = (req) => {
  if (process.env.MPESA_ENV !== 'production') return true;

  // Exact match only — ip.includes(allowedIP) would also match e.g.
  // "196.201.214.2001" or any spoofed string that merely contains an allowed IP
  // as a substring. Normalize the IPv4-mapped IPv6 form (::ffff:1.2.3.4) first,
  // since that's how some proxy/runtime configs report an IPv4 client.
  const rawIp = req.ip || '';
  const ip = rawIp.startsWith('::ffff:') ? rawIp.slice(7) : rawIp;
  return !!ip && allowedCallbackIps().includes(ip);
};

// Daraja caps the STK push AccountReference at 12 alphanumeric characters (and the TransactionDesc
// at 13). Our order references are longer than 12 once the hyphens are counted - 'NAI-2026-0153'
// is 13 - and Daraja answers an over-long reference with "Bad Request - Invalid AccountReference",
// so every payment would fail at the first live push. The reference is informational only (payments
// are matched by CheckoutRequestID), so a compact form is enough: NAI-2026-0153 -> NAI20260153.
const toAccountReference = (orderRef) => {
  const compact = String(orderRef || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!compact) return 'ORDER';
  return compact.length <= 12 ? compact : compact.slice(-12); // keep the year + sequence tail
};

const STK_TRANSACTION_DESC = 'Order payment'; // exactly 13 characters

// Parse M-Pesa callback result items into a flat object
const parseCallbackMetadata = (items = []) => {
  const result = {};
  items.forEach(item => {
    result[item.Name] = item.Value;
  });
  return result;
};

// Guest.phone is stored in whatever format the checkout form submitted
// (07..., +254..., or the canonical 254... used since this helper started
// being applied at write time). Given any input phone, return every stored
// form it could match so a lookup works regardless of when the Guest doc
// was created — without needing a one-off DB migration.
const phoneVariants = (phone) => {
  const canonical = formatPhone(phone); // 2547XXXXXXXX
  return [...new Set([
    canonical,
    `+${canonical}`,
    `0${canonical.slice(3)}`,
  ])];
};

// The one stored form for NEW accounts: local format, 0XXXXXXXXX. Login, register,
// reset and the duplicate check all go through phoneVariants() so accounts stored
// in the older +254 / 254 forms are still found; this keeps new ones consistent.
const toLocalPhone = (phone) => `0${formatPhone(String(phone)).slice(3)}`;

module.exports = {
  formatPhone,
  toLocalPhone,
  phoneVariants,
  generateTimestamp,
  generatePassword,
  validateSafaricomIP,
  describeCallbackSource,
  toAccountReference,
  STK_TRANSACTION_DESC,
  parseCallbackMetadata
};