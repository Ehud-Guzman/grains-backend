// Structural rules for a product's varieties/packaging. One definition, used by the
// request validator, the service layer and the Excel import, so a rule can't be
// enforced on one path and missed on another.
//
// Why these exist:
//  - Stock is read and written by (variety name, packaging size). With two entries
//    sharing a key, a deduction's array filter matches BOTH (each loses the quantity)
//    while the "enough stock" guard only looks at one.
//  - priceKES is nullable (quote-only packaging has none). A packaging that is not
//    quote-only and has no price sold at KES 0.

const norm = (v) => String(v ?? '').trim().toLowerCase();

// Returns a human-readable problem, or null when the structure is fine.
const findProductRuleViolation = (varieties) => {
  if (!Array.isArray(varieties)) return null;

  const seenVarieties = new Set();
  for (const variety of varieties) {
    const vKey = norm(variety?.varietyName);
    if (vKey) {
      if (seenVarieties.has(vKey)) return `Variety "${String(variety.varietyName).trim()}" is listed more than once`;
      seenVarieties.add(vKey);
    }

    const seenSizes = new Set();
    for (const pkg of (variety?.packaging || [])) {
      const sKey = norm(pkg?.size);
      if (sKey) {
        if (seenSizes.has(sKey)) {
          return `Packaging size "${String(pkg.size).trim()}" is listed more than once for "${variety.varietyName}"`;
        }
        seenSizes.add(sKey);
      }

      const quoteOnly = pkg?.quoteOnly === true || pkg?.quoteOnly === 'true';
      if (!quoteOnly) {
        const price = Number(pkg?.priceKES);
        if (pkg?.priceKES === null || pkg?.priceKES === undefined || pkg?.priceKES === '' || !(price > 0)) {
          return `"${variety.varietyName}" / "${pkg?.size}" needs a price above 0 (or mark it quote-only)`;
        }
      }
    }
  }
  return null;
};

module.exports = { findProductRuleViolation, norm };
