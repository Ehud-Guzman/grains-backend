// Escapes regex metacharacters so user-supplied search text is treated as a
// literal substring match, not a pattern — untrusted input built into a live
// $regex query can otherwise pin CPU (ReDoS) or match unintended documents.
const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = { escapeRegex };
