const PriceLog = require('../models/PriceLog');

// ── LOG A PRICE CHANGE ────────────────────────────────────────────────────────
const logChange = async ({ productId, branchId, varietyName, packaging, oldPrice, newPrice, changedBy, note, seasonTag }) => {
  return PriceLog.create({
    productId, branchId, varietyName, packaging, oldPrice, newPrice, changedBy,
    note: note || null,
    seasonTag: seasonTag || null,
  });
};

// ── GET PRICE HISTORY FOR A PRODUCT/VARIETY/PACKAGING ─────────────────────────
const getHistory = async (productId, { varietyName, packaging } = {}) => {
  const filter = { productId };
  if (varietyName) filter.varietyName = varietyName;
  if (packaging)   filter.packaging   = packaging;

  return PriceLog.find(filter)
    .populate('changedBy', 'name role')
    .sort({ changedAt: -1 })
    .limit(200)
    .lean();
};

// ── BEST-TIME-TO-BUY BADGE ────────────────────────────────────────────────────
// Returns { isBestTime, avg90d, currentPrice, percentBelow } for a specific packaging.
// "Best time" = current price is at least 5 % below the 90-day average.
// Returns null if there are fewer than 3 data points in the window (not enough history).
const getBestTimeBadge = async (productId, varietyName, packaging, currentPrice) => {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const logs = await PriceLog.find({
    productId,
    varietyName,
    packaging,
    changedAt: { $gte: cutoff },
  }).select('newPrice changedAt').lean();

  if (logs.length < 3) return null; // too little history

  const avg90d = logs.reduce((sum, l) => sum + l.newPrice, 0) / logs.length;
  const percentBelow = ((avg90d - currentPrice) / avg90d) * 100;
  const isBestTime = percentBelow >= 5;

  return { isBestTime, avg90d: Math.round(avg90d), currentPrice, percentBelow: Math.round(percentBelow) };
};

// ── BATCH PRICE CHANGES (for product card badges) ────────────────────────────
// Returns { [productId]: { pct, direction } } for the first SKU of each product.
// Compares the latest recorded price to the price that was current 30 days ago.
const getBatchPriceChanges = async (productIds) => {
  if (!productIds || !productIds.length) return {};
  const mongoose = require('mongoose');
  const mongoIds = productIds.map(id => new mongoose.Types.ObjectId(String(id)));
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Most recent price entry per product (any SKU — picks the one changed most recently)
  const latestEntries = await PriceLog.aggregate([
    { $match: { productId: { $in: mongoIds } } },
    { $sort: { changedAt: -1 } },
    { $group: {
      _id: '$productId',
      newPrice: { $first: '$newPrice' },
      varietyName: { $first: '$varietyName' },
      packaging: { $first: '$packaging' },
    }},
  ]);

  // For each, find the same SKU's price as of 30 days ago
  const baselineResults = await Promise.all(
    latestEntries.map(l =>
      PriceLog.findOne({
        productId: l._id,
        varietyName: l.varietyName,
        packaging: l.packaging,
        changedAt: { $lte: thirtyDaysAgo },
      })
        .sort({ changedAt: -1 })
        .select('newPrice')
        .lean()
    )
  );

  const out = {};
  latestEntries.forEach((l, i) => {
    const baseline = baselineResults[i];
    if (!baseline) return;
    const pct = Math.round(((l.newPrice - baseline.newPrice) / baseline.newPrice) * 100);
    if (pct === 0) return;
    out[l._id.toString()] = {
      pct: Math.abs(pct),
      direction: pct > 0 ? 'up' : 'down',
    };
  });
  return out;
};

module.exports = { logChange, getHistory, getBestTimeBadge, getBatchPriceChanges };
