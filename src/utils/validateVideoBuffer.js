// Same rationale as validateImageBuffer.js — multer's fileFilter only checks
// the client-supplied Content-Type, which is spoofable. Checks actual file
// bytes against known video container signatures as a second layer.
const isValidVideoBuffer = (buffer) => {
  if (!buffer || buffer.length < 12) return false;

  // MP4 / MOV / M4V — ISO base media container: bytes 4-7 spell "ftyp"
  if (buffer.slice(4, 8).toString('ascii') === 'ftyp') return true;

  // WebM / MKV — EBML header
  if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) return true;

  return false;
};

module.exports = { isValidVideoBuffer };
