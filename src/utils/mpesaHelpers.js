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
const generateTimestamp = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
         `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

// Generate STK push password: Base64(shortcode + passkey + timestamp)
const generatePassword = (shortcode, passkey, timestamp) => {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
};

// Validate that a callback is coming from Safaricom's IPs.
// Uses only req.ip — trust proxy is set to 1, so Express resolves the correct
// client IP from X-Forwarded-For via Render's load balancer. Reading the raw
// header as a fallback would allow an attacker to spoof it.
// In development/sandbox — allow all IPs.
const validateSafaricomIP = (req) => {
  if (process.env.MPESA_ENV !== 'production') return true;

  // Exact match only — ip.includes(allowedIP) would also match e.g.
  // "196.201.214.2001" or any spoofed string that merely contains an allowed IP
  // as a substring. Normalize the IPv4-mapped IPv6 form (::ffff:1.2.3.4) first,
  // since that's how some proxy/runtime configs report an IPv4 client.
  const rawIp = req.ip || '';
  const ip = rawIp.startsWith('::ffff:') ? rawIp.slice(7) : rawIp;
  const isValid = !!ip && SAFARICOM_IPS.includes(ip);

  if (!isValid) {
    const logger = require('./logger');
    logger.warn('[M-PESA] Callback from unrecognized IP', { ip: rawIp });
  }

  return isValid;
};

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

module.exports = {
  formatPhone,
  phoneVariants,
  generateTimestamp,
  generatePassword,
  validateSafaricomIP,
  parseCallbackMetadata
};