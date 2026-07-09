// multer's fileFilter only checks the client-supplied Content-Type header, which
// is trivially spoofable — a non-image file can declare "image/jpeg" and pass.
// This checks the actual file bytes against known image signatures as a second
// layer before the buffer reaches Cloudinary.
const SIGNATURES = [
  { bytes: [0xFF, 0xD8, 0xFF] },                                     // JPEG
  { bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },        // PNG
  { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0, riffWebp: true },     // WEBP (RIFF....WEBP)
];

const isValidImageBuffer = (buffer) => {
  if (!buffer || buffer.length < 12) return false;

  for (const sig of SIGNATURES) {
    const matches = sig.bytes.every((byte, i) => buffer[i] === byte);
    if (!matches) continue;
    if (!sig.riffWebp) return true;
    // RIFF container — confirm it's specifically WEBP, not another RIFF format
    if (buffer.slice(8, 12).toString('ascii') === 'WEBP') return true;
  }

  return false;
};

module.exports = { isValidImageBuffer };
