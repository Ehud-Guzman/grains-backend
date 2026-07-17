const cloudinary = require('../config/cloudinary');
const { AppError } = require('../middleware/errorHandler.middleware');
const logger = require('../utils/logger');

// Extract the full public_id from a Cloudinary delivery URL.
// URL format: https://res.cloudinary.com/<cloud>/image/upload/[transforms/]v123/grains-shop/products/<id>.jpg
// The public_id is EVERYTHING after the version segment, minus the extension —
// including every folder level. The old parser kept only the last folder
// ("products/<id>" instead of "grains-shop/products/<id>"), so destroy() always
// targeted a nonexistent id and every deletion silently no-opped, leaving
// removed images in Cloudinary forever.
const extractPublicId = (imageUrl) => {
  const [, afterUpload] = imageUrl.split(/\/upload\//);
  if (!afterUpload) return null;
  const withoutQuery = afterUpload.split(/[?#]/)[0];
  const segments = withoutQuery.split('/');
  // Drop leading transformation segments (contain '=' or ',' or start with a
  // named transform) up to and including the version segment (v<digits>).
  const versionIdx = segments.findIndex(s => /^v\d+$/.test(s));
  const pathSegments = versionIdx >= 0 ? segments.slice(versionIdx + 1) : segments;
  if (pathSegments.length === 0) return null;
  const last = pathSegments[pathSegments.length - 1];
  pathSegments[pathSegments.length - 1] = last.replace(/\.[^.]+$/, '');
  return pathSegments.join('/');
};

// Delete an image from Cloudinary by its public_id
// Called when a product image is replaced or product is deleted
const deleteImage = async (imageUrl) => {
  try {
    const publicId = extractPublicId(imageUrl);
    if (!publicId) {
      logger.warn('[Cloudinary] Could not derive public_id from URL — skipping delete', { imageUrl });
      return;
    }
    const result = await cloudinary.uploader.destroy(publicId);
    // destroy() resolves with { result: 'not found' } rather than throwing —
    // surface it, or a wrong public_id regresses into silent no-ops again.
    if (result?.result && result.result !== 'ok') {
      logger.warn('[Cloudinary] Image delete did not remove anything', { publicId, result: result.result });
    }
  } catch (err) {
    // Log but never crash on image deletion failure
    logger.error('[Cloudinary] Failed to delete image', { err: err.message });
  }
};

// Delete multiple images
const deleteImages = async (imageUrls = []) => {
  await Promise.all(imageUrls.map(url => deleteImage(url)));
};

module.exports = { deleteImage, deleteImages };
