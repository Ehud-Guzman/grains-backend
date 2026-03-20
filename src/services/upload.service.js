const cloudinary = require('../config/cloudinary');
const { AppError } = require('../middleware/errorHandler.middleware');

// Delete an image from Cloudinary by its public_id
// Called when a product image is replaced or product is deleted
const deleteImage = async (imageUrl) => {
  try {
    // Extract public_id from Cloudinary URL
    // URL format: https://res.cloudinary.com/cloud/image/upload/v123/grains-shop/products/public_id.jpg
    const parts = imageUrl.split('/');
    const fileWithExt = parts[parts.length - 1];
    const fileName = fileWithExt.split('.')[0];
    const folder = parts[parts.length - 2];
    const publicId = `${folder}/${fileName}`;

    await cloudinary.uploader.destroy(publicId);
  } catch (err) {
    // Log but never crash on image deletion failure
    console.error('[Cloudinary] Failed to delete image:', err.message);
  }
};

// Delete multiple images
const deleteImages = async (imageUrls = []) => {
  await Promise.all(imageUrls.map(url => deleteImage(url)));
};

module.exports = { deleteImage, deleteImages };