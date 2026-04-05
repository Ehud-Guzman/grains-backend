const normalizeImageUrl = (url) => {
  if (!url || typeof url !== 'string') return url;

  let normalized = url.trim();
  if (!normalized) return normalized;

  normalized = normalized.replace(
    /(\/grains-shop\/products)(\/grains-shop\/products)+/g,
    '$1'
  );

  return normalized;
};

const normalizeImageUrls = (urls = []) => {
  if (!Array.isArray(urls)) return [];

  return [...new Set(
    urls
      .map(normalizeImageUrl)
      .filter(Boolean)
  )];
};

const normalizeProductImages = (product) => {
  if (!product || typeof product !== 'object') return product;

  product.imageURLs = normalizeImageUrls(product.imageURLs);

  if (Array.isArray(product.varieties)) {
    product.varieties = product.varieties.map((variety) => ({
      ...variety,
      imageURLs: normalizeImageUrls(variety.imageURLs),
    }));
  }

  return product;
};

module.exports = {
  normalizeImageUrl,
  normalizeImageUrls,
  normalizeProductImages,
};
