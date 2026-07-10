// JWT `iat` claims are truncated to whole seconds (jsonwebtoken computes
// Math.floor(Date.now() / 1000)), but a plain `new Date()` has millisecond
// precision. If tokenValidAfter is set with millisecond precision and a fresh
// token is then minted a few milliseconds later in the SAME wall-clock second
// (e.g. auth.service.js#changePassword reissuing a token right after bumping
// tokenValidAfter, in the same request), the truncated iat can compare as
// strictly earlier than tokenValidAfter even though the token was actually
// issued after it — auth.middleware.js's revocation check then rejects a
// token that was never supposed to be revoked. Flooring tokenValidAfter to
// the same second-granularity as iat closes that race: any token minted in
// the same second or later always passes.
const bumpTokenValidAfter = () => new Date(Math.floor(Date.now() / 1000) * 1000);

module.exports = { bumpTokenValidAfter };
