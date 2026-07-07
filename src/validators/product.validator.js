const { body } = require('express-validator');

const packagingValidator = [
  body('varieties.*.packaging.*.size')
    .trim()
    .notEmpty().withMessage('Packaging size is required'),

  body('varieties.*.packaging.*.priceKES')
    .optional({ nullable: true })
    .isFloat({ min: 0 }).withMessage('Price must be a positive number'),

  body('varieties.*.packaging.*.stock')
    .optional()
    .isInt({ min: 0 }).withMessage('Stock must be a non-negative integer'),

  body('varieties.*.packaging.*.lowStockThreshold')
    .optional()
    .isInt({ min: 0 }).withMessage('Low stock threshold must be a non-negative integer'),

  body('varieties.*.packaging.*.quoteOnly')
    .optional()
    .isBoolean().withMessage('quoteOnly must be true or false'),

  body('varieties.*.packaging.*.pricingTiers')
    .optional()
    .isArray().withMessage('Pricing tiers must be an array'),

  body('varieties.*.packaging.*.pricingTiers.*.minQty')
    .isInt({ min: 1 }).withMessage('Pricing tier minimum quantity must be a positive integer'),

  body('varieties.*.packaging.*.pricingTiers.*.priceKES')
    .isFloat({ min: 0 }).withMessage('Pricing tier price must be a non-negative number'),

  // Tier selection (order.service.js) picks the highest minQty a given order
  // quantity qualifies for — if tiers aren't priced strictly cheaper at higher
  // volume, that logic silently produces a worse per-unit price for buying more,
  // with no error anywhere. Duplicate minQty values are equally silent (one tier
  // is arbitrarily shadowed depending on sort order).
  body('varieties')
    .optional()
    .custom((varieties) => {
      for (const variety of varieties || []) {
        for (const pkg of (variety.packaging || [])) {
          const tiers = pkg.pricingTiers || [];
          if (tiers.length === 0) continue;
          const sorted = [...tiers].sort((a, b) => a.minQty - b.minQty);
          const seenQty = new Set();
          let prevPrice = null;
          for (const tier of sorted) {
            if (seenQty.has(tier.minQty)) {
              throw new Error(
                `Duplicate pricing tier quantity ${tier.minQty} on "${variety.varietyName}" / "${pkg.size}"`
              );
            }
            seenQty.add(tier.minQty);
            if (prevPrice !== null && tier.priceKES > prevPrice) {
              throw new Error(
                `Pricing tiers must not get more expensive at higher quantities ` +
                `("${variety.varietyName}" / "${pkg.size}")`
              );
            }
            prevPrice = tier.priceKES;
          }
        }
      }
      return true;
    })
];

const createProductValidator = [
  body('name')
    .trim()
    .notEmpty().withMessage('Product name is required')
    .isLength({ min: 2, max: 200 }).withMessage('Name must be between 2 and 200 characters'),

  body('category')
    .trim()
    .notEmpty().withMessage('Category is required'),

  body('description')
    .optional()
    .trim()
    .isLength({ max: 2000 }).withMessage('Description cannot exceed 2000 characters'),

  body('varieties')
    .isArray({ min: 1 }).withMessage('At least one variety is required'),

  body('varieties.*.varietyName')
    .trim()
    .notEmpty().withMessage('Variety name is required'),

  body('varieties.*.packaging')
    .isArray({ min: 1 }).withMessage('Each variety must have at least one packaging size'),

  ...packagingValidator,

  body('isActive')
    .optional()
    .isBoolean().withMessage('isActive must be true or false'),

  body('taxable')
    .optional()
    .isBoolean().withMessage('taxable must be true or false')
];

const updateProductValidator = [
  body('name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 200 }).withMessage('Name must be between 2 and 200 characters'),

  body('category')
    .optional()
    .trim()
    .notEmpty().withMessage('Category cannot be empty'),

  body('varieties')
    .optional()
    .isArray({ min: 1 }).withMessage('At least one variety is required'),

  body('varieties.*.varietyName')
    .optional()
    .trim()
    .notEmpty().withMessage('Variety name is required'),

  body('varieties.*.packaging')
    .optional()
    .isArray({ min: 1 }).withMessage('Each variety must have at least one packaging size'),

  ...packagingValidator,

  body('isActive')
    .optional()
    .isBoolean().withMessage('isActive must be true or false'),

  body('taxable')
    .optional()
    .isBoolean().withMessage('taxable must be true or false')
];

module.exports = { createProductValidator, updateProductValidator };
