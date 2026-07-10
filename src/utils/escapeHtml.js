// Escapes user-controlled strings before interpolation into an HTML email —
// order/customer data (names, rejection reasons) is attacker-reachable input
// (anyone can place a guest order with an arbitrary name), so any HTML template
// that embeds it verbatim is an injection vector into the recipient's mail client.
const escapeHtml = (str) => String(str ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

module.exports = { escapeHtml };
