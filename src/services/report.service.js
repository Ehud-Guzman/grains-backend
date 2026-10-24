const mongoose = require('mongoose');
const Order = require('../models/Order');
const Payment = require('../models/Payment');
const Product = require('../models/Product');
const StockLog = require('../models/StockLog');
const User = require('../models/User');
const { NAIROBI_TZ, startOfDayEAT, endOfDayEAT, startOfMonthEAT } = require('../utils/businessTime');
const { withGuestFallbackList } = require('../utils/orderGuestFallback');
const { AppError } = require('../middleware/errorHandler.middleware');
const { createTtlCache } = require('../utils/ttlCache');

// Analytical reports scan a lot of orders and change slowly, so identical requests within a minute share one
// result (per process). Live money views (cash-up) and the dashboard are NOT cached.
const reportCache = createTtlCache({ ttlMs: 60 * 1000, maxEntries: 200 });
const cached = (name, args, compute) => reportCache.wrap(`${name}:${JSON.stringify(args)}`, compute);

// ── HELPERS ───────────────────────────────────────────────────────────────────
// Day/month boundaries follow the Nairobi clock (see utils/businessTime.js) —
// the server runs in UTC, so local setHours() would shift every boundary by 3h.

const startOfDay = startOfDayEAT;
const endOfDay = endOfDayEAT;

// Revenue is counted from approved onwards — pending orders aren't committed yet,
// and cancelled/rejected orders never appear here. Used consistently across every
// report that reports "revenue"/"spend" so figures reconcile with each other —
// previously several reports (customer report/statement, margin, avg order value)
// only counted 'completed', silently producing numbers that didn't match the
// sales dashboard for the same period.
const REVENUE_STATUSES = ['approved', 'preparing', 'out_for_delivery', 'completed'];

// eTIMS only fiscalises orders once they reach out_for_delivery/completed (see
// etims.service.js submitInvoice's invoiceable-state check) — the VAT report is a
// KRA filing aid, so it must match exactly what's actually been reported to KRA,
// not the broader REVENUE_STATUSES used for merchandising figures.
const VAT_INVOICEABLE_STATUSES = ['out_for_delivery', 'completed'];

const getDateRange = (period, from, to) => {
  const now = new Date();
  // Callers (e.g. the customer-statement date pickers) send date-only strings
  // like "2026-07-07" — new Date() parses that as UTC midnight (=03:00 EAT),
  // so without snapping to EAT day boundaries the "to" date would cut off
  // right after midnight, silently excluding almost the entire final day.
  if (from && to) return { start: startOfDay(new Date(from)), end: endOfDay(new Date(to)) };
  if (period === 'today') return { start: startOfDay(now), end: endOfDay(now) };
  if (period === 'week') {
    const start = new Date(now);
    start.setDate(now.getDate() - 7);
    return { start, end: now };
  }
  if (period === 'month') {
    const start = new Date(now);
    start.setDate(now.getDate() - 30);
    return { start, end: now };
  }
  if (period === 'year') {
    const start = new Date(now);
    start.setFullYear(now.getFullYear() - 1);
    return { start, end: now };
  }
  // Default: last 30 days
  const start = new Date(now);
  start.setDate(now.getDate() - 30);
  return { start, end: now };
};

// ── DASHBOARD KPIs ────────────────────────────────────────────────────────────
// UX B1 - KPI cards visible immediately on login. NOT cached (the page re-polls every 60 s while visible).
// Orders today, pending orders, revenue today, revenue this month, low stock count
const getDashboardKPIs = async (branchId) => {
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const monthStart = startOfMonthEAT(now);
  // Like-for-like comparison: yesterday up to this same clock time, not the whole of yesterday
  // (at 9am a full-day comparison would always read as a collapse). Kenya has no DST, so
  // "24 hours earlier" is the same wall-clock time.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const yesterdayStart = new Date(todayStart.getTime() - DAY_MS);
  const sameTimeYesterday = new Date(now.getTime() - DAY_MS);

  const branchFilter = branchId ? { branchId: new mongoose.Types.ObjectId(String(branchId)) } : {};

  const ACTIVE_STATUSES = ['pending', 'approved', 'preparing', 'out_for_delivery', 'completed'];

  const [
    ordersToday,
    pendingOrders,
    revenueToday,
    revenueThisMonth,
    lowStockCount,
    recentOrders,
    cashFlow,
    ordersYesterday,
    revenueYesterday
  ] = await Promise.all([
    // Orders placed today
    Order.countDocuments({ ...branchFilter, createdAt: { $gte: todayStart, $lte: todayEnd } }),

    // Pending orders
    Order.countDocuments({ ...branchFilter, status: 'pending' }),

    // Revenue today (approved+ orders placed today)
    Order.aggregate([
      { $match: { ...branchFilter, status: { $in: REVENUE_STATUSES }, createdAt: { $gte: todayStart, $lte: todayEnd } } },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]),

    // Revenue this month (approved+ orders placed this month)
    Order.aggregate([
      { $match: { ...branchFilter, status: { $in: REVENUE_STATUSES }, createdAt: { $gte: monthStart } } },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]),

    // Low stock items count - counted in the database (this used to load every product into memory)
    Product.aggregate([
      { $match: { ...branchFilter } },
      { $unwind: '$varieties' },
      { $unwind: '$varieties.packaging' },
      { $match: {
        'varieties.packaging.quoteOnly': { $ne: true },
        $expr: { $lte: ['$varieties.packaging.stock', '$varieties.packaging.lowStockThreshold'] },
      } },
      { $count: 'n' }
    ]).then(rows => rows[0]?.n || 0),

    // Recent 10 orders for dashboard panel - UX B1
    Order.find(branchFilter)
      .populate('userId', 'name phone')
      .populate('guestId', 'name phone')
      .sort({ createdAt: -1 })
      .limit(10)
      .select('orderRef status total paymentMethod createdAt userId guestId guestName guestPhone')
      .lean(),

    // Cash flow this month: paid vs unpaid across all active orders
    Order.aggregate([
      { $match: { ...branchFilter, status: { $in: ACTIVE_STATUSES }, createdAt: { $gte: monthStart } } },
      { $group: { _id: '$paymentStatus', total: { $sum: '$total' }, count: { $sum: 1 } } }
    ]),

    // Orders placed yesterday, up to this time of day
    Order.countDocuments({ ...branchFilter, createdAt: { $gte: yesterdayStart, $lte: sameTimeYesterday } }),

    // Revenue yesterday, up to this time of day (same statuses as revenueToday)
    Order.aggregate([
      { $match: { ...branchFilter, status: { $in: REVENUE_STATUSES }, createdAt: { $gte: yesterdayStart, $lte: sameTimeYesterday } } },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ])
  ]);

  // Bucket by "paid" vs "everything else" rather than naming each non-paid
  // paymentStatus explicitly — PAYMENT_STATUSES has unpaid/pending/paid/failed/refunded,
  // and missing any of them here would silently drop that revenue from both
  // tiles (previously happened to pending/failed/refunded orders).
  const paidFlow = cashFlow.find(r => r._id === 'paid') || { total: 0, count: 0 };
  const unpaidFlow = cashFlow
    .filter(r => r._id !== 'paid')
    .reduce((acc, r) => ({ total: acc.total + r.total, count: acc.count + r.count }), { total: 0, count: 0 });

  return {
    ordersToday,
    pendingOrders,
    revenueToday: revenueToday[0]?.total || 0,
    revenueThisMonth: revenueThisMonth[0]?.total || 0,
    lowStockCount,
    // Yesterday up to this same time of day, for the dashboard's "vs yesterday" change.
    comparison: {
      ordersYesterday: ordersYesterday,
      revenueYesterday: revenueYesterday[0]?.total || 0,
    },
    recentOrders: withGuestFallbackList(recentOrders),
    cashFlow: {
      paidRevenue:    paidFlow.total,
      paidOrders:     paidFlow.count,
      unpaidRevenue:  unpaidFlow.total,
      unpaidOrders:   unpaidFlow.count,
    }
  };
};

// ── SALES REPORT ──────────────────────────────────────────────────────────────
// SRS 5.7 + UX B5 - daily/weekly/monthly totals, revenue by category
// Used for line/bar charts on dashboard
const getSalesReport = async (period, from, to, branchId) => {
  const { start, end } = getDateRange(period, from, to);
  const branchFilter = branchId ? { branchId: new mongoose.Types.ObjectId(String(branchId)) } : {};

  // The window of the same length straight before this one, for "vs previous period". today -> yesterday,
  // 7 days -> the 7 before, a calendar month -> the same number of days before its first day.
  const spanMs = end.getTime() - start.getTime();
  const prevEnd = new Date(start.getTime() - 1);
  const prevStart = new Date(start.getTime() - spanMs - 1);

  const [summary, byCategory, byDay, orderVolume, previousRows] = await Promise.all([
    // Overall summary
    Order.aggregate([
      { $match: { ...branchFilter, status: { $in: REVENUE_STATUSES }, createdAt: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$total' },
          totalOrders: { $sum: 1 },
          avgOrderValue: { $avg: '$total' },
          totalItems: { $sum: { $size: '$orderItems' } },
          // What the total is made of (2026-10 audit, F-15): total = goods - discounts + delivery + VAT.
          goodsSubtotal: { $sum: { $ifNull: ['$subtotal', 0] } },
          couponDiscounts: { $sum: { $ifNull: ['$couponDiscount', 0] } },
          deliveryFees: { $sum: { $ifNull: ['$deliveryFee', 0] } },
          vatCollected: { $sum: { $ifNull: ['$vatAmount', 0] } },
          // Collected vs still owed. "Revenue" counts orders from approval on, whether or not the money has
          // arrived (cash on delivery, pay on pickup), so the report needs to say how much of it is in hand.
          paidRevenue: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, '$total', 0] } },
          paidOrders: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, 1, 0] } }
        }
      }
    ]),

    // Revenue by product category — net of proportionally-shared coupon discount
    // (see getMarginReport's netRevenue comment) so this reconciles with summary.totalRevenue
    Order.aggregate([
      { $match: { ...branchFilter, status: { $in: REVENUE_STATUSES }, createdAt: { $gte: start, $lte: end } } },
      { $unwind: '$orderItems' },
      {
        $addFields: {
          'orderItems.netRevenue': {
            $subtract: [
              '$orderItems.lineTotal',
              {
                $multiply: [
                  { $cond: [{ $gt: ['$subtotal', 0] }, { $divide: ['$orderItems.lineTotal', '$subtotal'] }, 0] },
                  { $ifNull: ['$couponDiscount', 0] },
                ],
              },
            ],
          },
        },
      },
      // Sum per PRODUCT first, then look each product's category up once. The old shape joined every order
      // line to the products collection (100k+ lookups for a year); this joins only the distinct products.
      {
        $group: {
          _id: '$orderItems.productId',
          revenue: { $sum: '$orderItems.netRevenue' },
          unitsSold: { $sum: '$orderItems.quantity' },
          orderCount: { $sum: 1 }
        }
      },
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: '_id',
          pipeline: [{ $project: { category: 1 } }],
          as: 'product'
        }
      },
      { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: '$product.category',
          revenue: { $sum: '$revenue' },
          unitsSold: { $sum: '$unitsSold' },
          orderCount: { $sum: '$orderCount' }
        }
      },
      { $sort: { revenue: -1 } }
    ]),

    // Revenue by day (for line chart - UX B5)
    Order.aggregate([
      { $match: { ...branchFilter, status: { $in: REVENUE_STATUSES }, createdAt: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: {
            year: { $year: { date: '$createdAt', timezone: NAIROBI_TZ } },
            month: { $month: { date: '$createdAt', timezone: NAIROBI_TZ } },
            day: { $dayOfMonth: { date: '$createdAt', timezone: NAIROBI_TZ } }
          },
          revenue: { $sum: '$total' },
          orders: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
      {
        $project: {
          date: {
            $dateFromParts: {
              year: '$_id.year',
              month: '$_id.month',
              day: '$_id.day',
              timezone: NAIROBI_TZ
            }
          },
          revenue: 1,
          orders: 1,
          _id: 0
        }
      }
    ]),

    // Order volume by payment method
    Order.aggregate([
      { $match: { ...branchFilter, status: { $in: REVENUE_STATUSES }, createdAt: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: '$paymentMethod',
          count: { $sum: 1 },
          revenue: { $sum: '$total' }
        }
      }
    ]),

    // Previous period, headline figures only
    Order.aggregate([
      { $match: { ...branchFilter, status: { $in: REVENUE_STATUSES }, createdAt: { $gte: prevStart, $lte: prevEnd } } },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$total' },
          totalOrders: { $sum: 1 },
          avgOrderValue: { $avg: '$total' },
          totalItems: { $sum: { $size: '$orderItems' } }
        }
      }
    ])
  ]);

  const s = summary[0] || {};
  const prev = previousRows[0] || {};
  return {
    period: { start, end },
    summary: {
      totalRevenue: s.totalRevenue || 0,
      totalOrders: s.totalOrders || 0,
      avgOrderValue: s.avgOrderValue ? Math.round(s.avgOrderValue) : 0,
      totalItems: s.totalItems || 0,
      // How much of the revenue has actually been paid. unpaid = everything else (unpaid, processing,
      // failed, refunded), the same bucketing the dashboard's cash-flow card uses.
      paidRevenue: Math.round((s.paidRevenue || 0) * 100) / 100,
      paidOrders: s.paidOrders || 0,
      unpaidRevenue: Math.round(((s.totalRevenue || 0) - (s.paidRevenue || 0)) * 100) / 100,
      unpaidOrders: (s.totalOrders || 0) - (s.paidOrders || 0),
      // "Revenue" above is what customers paid: it includes delivery fees and VAT, which are not sales of
      // goods. The category and best-seller figures are NET goods sales. This breakdown reconciles the two.
      breakdown: {
        goodsSubtotal: Math.round((s.goodsSubtotal || 0) * 100) / 100,
        couponDiscounts: Math.round((s.couponDiscounts || 0) * 100) / 100,
        netGoods: Math.round(((s.goodsSubtotal || 0) - (s.couponDiscounts || 0)) * 100) / 100,
        deliveryFees: Math.round((s.deliveryFees || 0) * 100) / 100,
        vatCollected: Math.round((s.vatCollected || 0) * 100) / 100,
      }
    },
    previous: {
      start: prevStart,
      end: prevEnd,
      totalRevenue: prev.totalRevenue || 0,
      totalOrders: prev.totalOrders || 0,
      avgOrderValue: prev.avgOrderValue ? Math.round(prev.avgOrderValue) : 0,
      totalItems: prev.totalItems || 0,
    },
    byCategory,
    byDay,
    byPaymentMethod: orderVolume
  };
};

// ── BEST SELLERS ──────────────────────────────────────────────────────────────
// UX B5 - products ranked by units sold and revenue
const getBestSellers = async (period, from, to, limit = 10, branchId) => {
  const { start, end } = getDateRange(period, from, to);
  // ?limit=abc (or 0, or 1e9) used to reach $limit unchecked and Mongo rejected it with a 500.
  const rowLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 10));
  const branchFilter = branchId ? { branchId: new mongoose.Types.ObjectId(String(branchId)) } : {};

  const results = await Order.aggregate([
    { $match: { ...branchFilter, status: { $in: REVENUE_STATUSES }, createdAt: { $gte: start, $lte: end } } },
    { $unwind: '$orderItems' },
    // Net-of-discount revenue — see getMarginReport's netRevenue comment
    {
      $addFields: {
        'orderItems.netRevenue': {
          $subtract: [
            '$orderItems.lineTotal',
            {
              $multiply: [
                { $cond: [{ $gt: ['$subtotal', 0] }, { $divide: ['$orderItems.lineTotal', '$subtotal'] }, 0] },
                { $ifNull: ['$couponDiscount', 0] },
              ],
            },
          ],
        },
      },
    },
    {
      $group: {
        _id: {
          productId: '$orderItems.productId',
          productName: '$orderItems.productName',
          variety: '$orderItems.variety',
          packaging: '$orderItems.packaging'
        },
        unitsSold: { $sum: '$orderItems.quantity' },
        revenue: { $sum: '$orderItems.netRevenue' },
        orderCount: { $sum: 1 }
      }
    },
    { $sort: { unitsSold: -1 } },
    { $limit: rowLimit },
    {
      $project: {
        productId: '$_id.productId',
        productName: '$_id.productName',
        variety: '$_id.variety',
        packaging: '$_id.packaging',
        unitsSold: 1,
        revenue: 1,
        orderCount: 1,
        _id: 0
      }
    }
  ]);

  return { period: { start, end }, products: results };
};

// ── SLOW MOVERS ───────────────────────────────────────────────────────────────
// UX B5 - products with zero or low order frequency in last 30 days
const getSlowMovers = async (days = 30, branchId) => {
  const windowDays = Math.min(730, Math.max(1, Number.parseInt(days, 10) || 30));
  const now = Date.now();
  const cutoff = new Date(now - windowDays * 86400000);
  const branchFilter = branchId ? { branchId: new mongoose.Types.ObjectId(String(branchId)) } : {};
  const SOLD = ['approved', 'preparing', 'out_for_delivery', 'completed'];

  // Get all active products
  const allProducts = await Product.find({ isActive: true, ...branchFilter })
    .select('name category varieties')
    .lean();

  // Get products that had orders in the period (approved or beyond)
  const activeProductIds = await Order.distinct('orderItems.productId', {
    ...branchFilter,
    status: { $in: SOLD },
    createdAt: { $gte: cutoff }
  });

  const activeSet = new Set(activeProductIds.map(id => id.toString()));
  const slow = allProducts.filter(p => !activeSet.has(p._id.toString()));

  // When each of those last sold (any time before the window), so "no sale in 30 days" can say whether
  // that is 31 days or 400, or never.
  const slowIds = slow.map(p => p._id);
  const lastSold = slow.length === 0 ? [] : await Order.aggregate([
    { $match: { ...branchFilter, status: { $in: SOLD }, 'orderItems.productId': { $in: slowIds } } },
    { $unwind: '$orderItems' },
    { $match: { 'orderItems.productId': { $in: slowIds } } },
    { $group: { _id: '$orderItems.productId', last: { $max: '$createdAt' } } }
  ]);
  const lastById = new Map(lastSold.map(r => [String(r._id), r.last]));

  const slowMovers = slow.map(p => {
    // Money tied up: stock x cost price, falling back to the selling price where no cost is set
    // (flagged, the same rule as the stock valuation report). Quote-only lines hold no priced stock.
    let stockUnits = 0, stockValueKES = 0, usedRetailFallback = false;
    for (const v of p.varieties || []) {
      for (const pkg of v.packaging || []) {
        if (pkg.quoteOnly || !pkg.priceKES) continue;
        const unit = pkg.costPriceKES || pkg.priceKES;
        if (!pkg.costPriceKES && pkg.stock > 0) usedRetailFallback = true;
        stockUnits += pkg.stock || 0;
        stockValueKES += (pkg.stock || 0) * unit;
      }
    }
    const last = lastById.get(String(p._id)) || null;
    return {
      productId: p._id,
      name: p.name,
      category: p.category,
      varietyCount: (p.varieties || []).length,
      stockUnits,
      stockValueKES,
      usedRetailFallback,
      lastSoldAt: last,
      neverSold: !last,
      daysWithoutSale: last ? Math.max(windowDays, Math.floor((now - new Date(last).getTime()) / 86400000)) : null
    };
  }).sort((a, b) => b.stockValueKES - a.stockValueKES);

  return {
    days: windowDays,
    slowMovers,
    count: slowMovers.length,
    totalValueTiedUpKES: slowMovers.reduce((n, r) => n + r.stockValueKES, 0)
  };
};

// ── STOCK VALUATION ───────────────────────────────────────────────────────────
// UX B5 - current stock × cost price per size = estimated stock value (at cost,
// not retail — retail would bake the full margin into "money tied up in inventory").
// Falls back to priceKES per-row when costPriceKES isn't set, flagged via
// usedRetailFallback so the totals' completeness is visible rather than silently mixed.
const getStockValuation = async (branchId) => {
  const filter = { isActive: true };
  if (branchId) filter.branchId = branchId;
  const products = await Product.find(filter)
    .select('name category varieties')
    .lean();

  const rows = [];
  let totalValue = 0;
  let rowsMissingCostPrice = 0;

  for (const product of products) {
    for (const variety of product.varieties) {
      for (const pkg of variety.packaging) {
        if (pkg.quoteOnly || !pkg.priceKES) continue;
        const usedRetailFallback = !pkg.costPriceKES;
        const unitValue = usedRetailFallback ? pkg.priceKES : pkg.costPriceKES;
        const value = pkg.stock * unitValue;
        totalValue += value;
        if (usedRetailFallback) rowsMissingCostPrice += 1;
        rows.push({
          productName: product.name,
          category: product.category,
          varietyName: variety.varietyName,
          packagingSize: pkg.size,
          stock: pkg.stock,
          unitValueKES: unitValue,
          usedRetailFallback,
          totalValueKES: value
        });
      }
    }
  }

  // Sort by value descending
  rows.sort((a, b) => b.totalValueKES - a.totalValueKES);

  return {
    rows,
    totalStockValueKES: totalValue,
    itemCount: rows.length,
    rowsMissingCostPrice
  };
};

// ── STOCK TURNOVER REPORT ─────────────────────────────────────────────────────
// Units sold in the period vs current stock on hand, per SKU. A proxy ratio —
// no daily inventory snapshots exist, so "average inventory" isn't available;
// current stock is used as the denominator instead (standard when only point-in-time
// stock counts are on hand). Low ratio + high stock = excess/slow-moving inventory.
const getStockTurnoverReport = async (period, from, to, branchId) => {
  const { start, end } = getDateRange(period, from, to);
  const branchFilter = branchId ? { branchId: new mongoose.Types.ObjectId(String(branchId)) } : {};
  const periodDays = Math.max(1, Math.round((end - start) / (24 * 60 * 60 * 1000)));

  const sold = await Order.aggregate([
    { $match: { ...branchFilter, status: { $in: REVENUE_STATUSES }, createdAt: { $gte: start, $lte: end } } },
    { $unwind: '$orderItems' },
    {
      $group: {
        _id: {
          productId: '$orderItems.productId',
          variety: '$orderItems.variety',
          packaging: '$orderItems.packaging',
        },
        unitsSold: { $sum: '$orderItems.quantity' },
      },
    },
  ]);
  const soldMap = new Map(sold.map(s => [`${s._id.productId}::${s._id.variety}::${s._id.packaging}`, s.unitsSold]));

  const productFilter = { isActive: true };
  if (branchId) productFilter.branchId = branchId;
  const products = await Product.find(productFilter).select('name category varieties').lean();

  const rows = [];
  for (const product of products) {
    for (const variety of product.varieties) {
      for (const pkg of variety.packaging) {
        if (pkg.quoteOnly) continue;
        const key = `${product._id}::${variety.varietyName}::${pkg.size}`;
        const unitsSold = soldMap.get(key) || 0;
        const currentStock = pkg.stock || 0;
        if (unitsSold === 0 && currentStock === 0) continue;

        const turnoverRatio = currentStock > 0 ? Math.round((unitsSold / currentStock) * 100) / 100 : null;
        const dailyRate = unitsSold / periodDays;
        const daysOfSupply = dailyRate > 0 ? Math.round(currentStock / dailyRate) : null;

        rows.push({
          productId: product._id,
          productName: product.name,
          category: product.category,
          varietyName: variety.varietyName,
          packagingSize: pkg.size,
          unitsSold,
          currentStock,
          turnoverRatio, // units sold per unit currently in stock, over the period
          daysOfSupply,  // null = no sales in period, so supply is effectively infinite
        });
      }
    }
  }

  rows.sort((a, b) => (b.turnoverRatio ?? -1) - (a.turnoverRatio ?? -1));

  return { period: { start, end }, periodDays, rows };
};

// ── STOCK MOVEMENT REPORT ─────────────────────────────────────────────────────
// UX B5 - all stock changes in a date range by product
const STOCK_MOVEMENT_ROW_CAP = 10000;

const getStockMovementReport = async (period, from, to, branchId) => {
  const { start, end } = getDateRange(period, from, to);
  const filter = { timestamp: { $gte: start, $lte: end } };
  if (branchId) filter.branchId = branchId;

  // Date range is already bounded (getDateRange defaults to 30 days), but a
  // "year" period or a wide custom from/to on a busy branch could still return
  // an unbounded number of rows fully populated into memory — cap it and tell
  // the caller if the range needs narrowing, rather than truncating silently.
  const logs = await StockLog.find(filter)
    .populate('productId', 'name category')
    .populate('performedBy', 'name role')
    .sort({ timestamp: -1 })
    .limit(STOCK_MOVEMENT_ROW_CAP)
    .lean();

  // Summary by change type
  const summary = logs.reduce((acc, log) => {
    acc[log.changeType] = (acc[log.changeType] || 0) + Math.abs(log.quantityChange);
    return acc;
  }, {});

  return {
    period: { start, end },
    summary,
    logs,
    count: logs.length,
    truncated: logs.length === STOCK_MOVEMENT_ROW_CAP
  };
};

// ── CUSTOMER REPORT ───────────────────────────────────────────────────────────
// UX B5 - repeat buyers, high-value, inactive customers
const CUSTOMER_SEGMENTS = ['all', 'repeat', 'highValue', 'inactive'];
const getCustomerReport = async (branchId, { page = 1, limit = 50, all = false, segment = 'all' } = {}) => {
  if (!CUSTOMER_SEGMENTS.includes(segment)) segment = 'all';
  const branchFilter = branchId ? { branchId: new mongoose.Types.ObjectId(String(branchId)) } : {};

  // 1. Per-customer totals for EVERYONE (small rows: an id and a few numbers). The segment counts need the
  //    whole population; only the customers shown on this page are joined to their user records below.
  const stats = await Order.aggregate([
    { $match: { ...branchFilter, status: { $in: REVENUE_STATUSES }, userId: { $ne: null } } },
    {
      $group: {
        _id: '$userId',
        totalOrders: { $sum: 1 },
        totalSpend: { $sum: '$total' },
        avgOrderValue: { $avg: '$total' },
        firstOrder: { $min: '$createdAt' },
        lastOrder: { $max: '$createdAt' }
      }
    },
    { $sort: { totalSpend: -1 } }
  ]);

  // Segment customers - SRS 5.5
  const sorted = [...stats].sort((a, b) => b.totalSpend - a.totalSpend);
  const top10Threshold = sorted[Math.floor(sorted.length * 0.1)]?.totalSpend || 0;
  const now = Date.now();

  const segmentOf = (c) => {
    const daysSinceLastOrder = (now - new Date(c.lastOrder).getTime()) / 86400000;
    return {
      ...c,
      avgOrderValue: Math.round(c.avgOrderValue),
      isRepeat: c.totalOrders >= 3,
      isHighValue: c.totalSpend >= top10Threshold,
      isInactive: daysSinceLastOrder >= 30,
      daysSinceLastOrder: Math.floor(daysSinceLastOrder)
    };
  };
  const enriched = stats.map(segmentOf);

  // The list on screen can be narrowed to one segment ("who has stopped ordering?"). The counts below
  // always describe everyone, so the segment tiles stay put while the list changes. Still sorted by
  // spend, so the most valuable lapsed customers come first.
  const SEGMENT_TEST = { all: () => true, repeat: c => c.isRepeat, highValue: c => c.isHighValue, inactive: c => c.isInactive };
  const listed = enriched.filter(SEGMENT_TEST[segment]);

  // 2. Only the requested page gets user details.
  const pageSize = all ? listed.length : Math.min(Math.max(Number(limit) || 50, 1), 200);
  const pageNo = all ? 1 : Math.max(Number(page) || 1, 1);
  const slice = all ? listed : listed.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  const users = await User.find({ _id: { $in: slice.map(c => c._id) } }).select('name phone email').lean();
  const userById = new Map(users.map(u => [String(u._id), u]));
  const customers = slice
    .filter(c => userById.has(String(c._id)))
    .map(c => {
      const u = userById.get(String(c._id));
      return { ...c, name: u.name, phone: u.phone, email: u.email };
    });

  return {
    total: enriched.length,
    repeat: enriched.filter(c => c.isRepeat).length,
    highValue: enriched.filter(c => c.isHighValue).length,
    inactive: enriched.filter(c => c.isInactive).length,
    segment,
    customers,
    pagination: { page: pageNo, limit: pageSize, total: listed.length, pages: Math.max(1, Math.ceil(listed.length / (pageSize || 1))) }
  };
};

// ── ORDERS BY STATUS REPORT ───────────────────────────────────────────────────
// UX B5 - count and value of orders at each status stage
const getOrdersByStatus = async (period, from, to, branchId) => {
  const { start, end } = getDateRange(period, from, to);
  const branchFilter = branchId ? { branchId: new mongoose.Types.ObjectId(String(branchId)) } : {};

  const [byStatus, peakHours, avgOrderValue] = await Promise.all([
    // Orders grouped by status
    Order.aggregate([
      { $match: { ...branchFilter, createdAt: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalValue: { $sum: '$total' },
          avgValue: { $avg: '$total' }
        }
      },
      { $sort: { count: -1 } }
    ]),

    // Peak ordering hours - SRS 5.7
    Order.aggregate([
      { $match: { ...branchFilter, createdAt: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: { $hour: { date: '$createdAt', timezone: NAIROBI_TZ } },
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]),

    // Average order value
    Order.aggregate([
      { $match: { ...branchFilter, status: { $in: REVENUE_STATUSES }, createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, avg: { $avg: '$total' } } }
    ])
  ]);

  return {
    period: { start, end },
    byStatus,
    // The busiest five hours (Nairobi clock), kept for older clients...
    peakHours: peakHours.slice(0, 5).map(h => ({ hour: h._id, orders: h.count })),
    // ...and the whole day, hour 0-23, zeros included, so the page can draw the daily rhythm.
    byHour: Array.from({ length: 24 }, (_, hour) => ({ hour, orders: peakHours.find(h => h._id === hour)?.count || 0 })),
    avgOrderValue: avgOrderValue[0]?.avg ? Math.round(avgOrderValue[0].avg) : 0
  };
};

// ── CSV EXPORT HELPER ─────────────────────────────────────────────────────────
// SRS 5.7 - all reports exportable as CSV
// Simple CSV without external dependency
// Dates print on the Nairobi clock as "2026-10-18" (or "2026-10-18 09:45" when there is a time of
// day) instead of String(Date): that was server-timezone text ("Sat Oct 17 2026 21:00:00 GMT+0000" for
// the Nairobi day of 18 Oct on Render), i.e. a day off for anyone reading the sheet.
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;
const formatCsvDate = (date) => {
  if (Number.isNaN(date.getTime())) return '';
  const iso = new Date(date.getTime() + EAT_OFFSET_MS).toISOString();
  return iso.slice(11, 16) === '00:00' ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
};

const toCSV = (data, columns) => {
  if (!data || data.length === 0) return columns.map(c => c.label).join(',') + '\n';

  // Formula-injection guard: a TEXT cell starting with =/+/-/@ is interpreted as a formula by
  // Excel/Sheets when the CSV is opened. Several columns come from user-controlled text (product,
  // customer and driver names, adjustment reasons) — prefix those with a literal-text apostrophe so
  // they render as data, not code. Numbers and dates are never text from a user, so they are left alone:
  // guarding every cell turned legitimate negatives (stock-out quantities, a loss-making margin) into
  // the text "'-7".
  const escapeCsvCell = (val) => {
    if (val === null || val === undefined) return '';
    if (val instanceof Date) return formatCsvDate(val);
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    const str = String(val);
    return /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  };

  const header = columns.map(c => `"${c.label}"`).join(',');
  const rows = data.map(row =>
    columns.map(c => {
      const val = c.key.split('.').reduce((obj, k) => obj?.[k], row);
      return `"${escapeCsvCell(val).replace(/"/g, '""')}"`;
    }).join(',')
  );

  return [header, ...rows].join('\n');
};

// ── EXPORT REPORT ─────────────────────────────────────────────────────────────
// Returns CSV string for any report type - SRS 5.7
const exportReport = async (type, params, branchId) => {
  const { period, from, to } = params;

  switch (type) {
    case 'sales': {
      const data = await getSalesReport(period, from, to, branchId);
      const csv = toCSV(data.byDay, [
        { label: 'Date', key: 'date' },
        { label: 'Orders', key: 'orders' },
        { label: 'Revenue (KES)', key: 'revenue' }
      ]);
      return { csv, filename: `sales-report-${Date.now()}.csv` };
    }

    case 'best-sellers': {
      const data = await getBestSellers(period, from, to, 50, branchId);
      const csv = toCSV(data.products, [
        { label: 'Product', key: 'productName' },
        { label: 'Variety', key: 'variety' },
        { label: 'Packaging', key: 'packaging' },
        { label: 'Units Sold', key: 'unitsSold' },
        { label: 'Revenue (KES)', key: 'revenue' },
        { label: 'Order Count', key: 'orderCount' }
      ]);
      return { csv, filename: `best-sellers-${Date.now()}.csv` };
    }

    case 'stock-valuation': {
      const data = await getStockValuation(branchId);
      const csv = toCSV(data.rows, [
        { label: 'Product', key: 'productName' },
        { label: 'Category', key: 'category' },
        { label: 'Variety', key: 'varietyName' },
        { label: 'Packaging', key: 'packagingSize' },
        { label: 'Stock', key: 'stock' },
        { label: 'Unit Value (KES)', key: 'unitValueKES' },
        { label: 'Total Value (KES)', key: 'totalValueKES' }
      ]);
      return { csv, filename: `stock-valuation-${Date.now()}.csv` };
    }

    case 'stock-turnover': {
      const data = await getStockTurnoverReport(period, from, to, branchId);
      const csv = toCSV(data.rows, [
        { label: 'Product', key: 'productName' },
        { label: 'Category', key: 'category' },
        { label: 'Variety', key: 'varietyName' },
        { label: 'Packaging', key: 'packagingSize' },
        { label: 'Units Sold', key: 'unitsSold' },
        { label: 'Current Stock', key: 'currentStock' },
        { label: 'Turnover Ratio', key: 'turnoverRatio' },
        { label: 'Days of Supply', key: 'daysOfSupply' }
      ]);
      return { csv, filename: `stock-turnover-${Date.now()}.csv` };
    }

    case 'kpis': {
      const data = await getDashboardKPIs(branchId);
      const csv = toCSV([{
        ordersToday: data.ordersToday,
        pendingOrders: data.pendingOrders,
        revenueToday: data.revenueToday,
        revenueThisMonth: data.revenueThisMonth,
        lowStockCount: data.lowStockCount,
        paidRevenue: data.cashFlow.paidRevenue,
        paidOrders: data.cashFlow.paidOrders,
        unpaidRevenue: data.cashFlow.unpaidRevenue,
        unpaidOrders: data.cashFlow.unpaidOrders,
      }], [
        { label: 'Orders Today', key: 'ordersToday' },
        { label: 'Pending Orders', key: 'pendingOrders' },
        { label: 'Revenue Today (KES)', key: 'revenueToday' },
        { label: 'Revenue This Month (KES)', key: 'revenueThisMonth' },
        { label: 'Low Stock Items', key: 'lowStockCount' },
        { label: 'Paid Revenue This Month (KES)', key: 'paidRevenue' },
        { label: 'Paid Orders This Month', key: 'paidOrders' },
        { label: 'Unpaid Revenue This Month (KES)', key: 'unpaidRevenue' },
        { label: 'Unpaid Orders This Month', key: 'unpaidOrders' },
      ]);
      return { csv, filename: `dashboard-kpis-${Date.now()}.csv` };
    }

    case 'slow-movers': {
      const data = await getSlowMovers(params.days || 30, branchId);
      const csv = toCSV(data.slowMovers, [
        { label: 'Product', key: 'name' },
        { label: 'Category', key: 'category' },
        { label: 'Variety Count', key: 'varietyCount' },
        { label: 'Days Without Sale', key: 'daysWithoutSale' }
      ]);
      return { csv, filename: `slow-movers-${Date.now()}.csv` };
    }

    case 'margins': {
      const data = await getMarginReport(period, from, to, branchId);
      const csv = toCSV(data.rows, [
        { label: 'Product', key: 'productName' },
        { label: 'Variety', key: 'variety' },
        { label: 'Packaging', key: 'packaging' },
        { label: 'Units Sold', key: 'unitsSold' },
        { label: 'Revenue (KES)', key: 'revenue' },
        { label: 'Estimated Cost (KES)', key: 'estimatedCost' },
        { label: 'Gross Profit (KES)', key: 'grossProfit' },
        { label: 'Margin %', key: 'marginPct' }
      ]);
      return { csv, filename: `margins-report-${Date.now()}.csv` };
    }

    case 'riders': {
      const data = await getRiderReport(period, from, to, branchId);
      const csv = toCSV(data.riders, [
        { label: 'Driver', key: 'driverName' },
        { label: 'Phone', key: 'driverPhone' },
        { label: 'Deliveries', key: 'deliveries' },
        { label: 'Avg Delivery (min)', key: 'avgDeliveryMinutes' },
        { label: 'Fastest (min)', key: 'minDeliveryMinutes' },
        { label: 'Slowest (min)', key: 'maxDeliveryMinutes' },
        { label: 'Total Revenue (KES)', key: 'totalRevenue' }
      ]);
      return { csv, filename: `riders-report-${Date.now()}.csv` };
    }

    case 'customers': {
      const data = await getCustomerReport(branchId, { all: true });
      const csv = toCSV(data.customers, [
        { label: 'Name', key: 'name' },
        { label: 'Phone', key: 'phone' },
        { label: 'Email', key: 'email' },
        { label: 'Total Orders', key: 'totalOrders' },
        { label: 'Total Spend (KES)', key: 'totalSpend' },
        { label: 'Avg Order Value (KES)', key: 'avgOrderValue' },
        { label: 'Days Since Last Order', key: 'daysSinceLastOrder' },
        { label: 'Repeat', key: 'isRepeat' },
        { label: 'High Value', key: 'isHighValue' },
        { label: 'Inactive', key: 'isInactive' }
      ]);
      return { csv, filename: `customer-report-${Date.now()}.csv` };
    }

    case 'orders': {
      const data = await getOrdersByStatus(period, from, to, branchId);
      const csv = toCSV(data.byStatus, [
        { label: 'Status', key: '_id' },
        { label: 'Count', key: 'count' },
        { label: 'Total Value (KES)', key: 'totalValue' },
        { label: 'Avg Value (KES)', key: 'avgValue' }
      ]);
      return { csv, filename: `orders-report-${Date.now()}.csv` };
    }

    case 'stock-movement': {
      const data = await getStockMovementReport(period, from, to, branchId);
      const csv = toCSV(data.logs, [
        { label: 'Date', key: 'timestamp' },
        { label: 'Product', key: 'productId.name' },
        { label: 'Variety', key: 'varietyName' },
        { label: 'Packaging', key: 'packagingSize' },
        { label: 'Change Type', key: 'changeType' },
        { label: 'Quantity Change', key: 'quantityChange' },
        { label: 'Balance After', key: 'balanceAfter' },
        { label: 'Reason', key: 'reason' },
        { label: 'Performed By', key: 'performedBy.name' }
      ]);
      return { csv, filename: `stock-movement-${Date.now()}.csv` };
    }

    case 'onboarding': {
      const data = await getOnboardingAnalytics();
      const csv = toCSV(data.rows, [
        { label: 'Role', key: 'role' },
        { label: 'Users', key: 'userCount' },
        { label: 'Completed Tours', key: 'completedTours' },
        { label: 'Avg Checklist Completion (%)', key: 'avgChecklistCompletion' },
        { label: 'Help Center Opens', key: 'helpCenterOpens' },
        { label: 'Milestones Reached', key: 'milestonesReached' }
      ]);
      return { csv, filename: `onboarding-report-${Date.now()}.csv` };
    }

    case 'vat': {
      const data = await getVatReport(period, from, to, branchId);
      const csv = toCSV(data.rows.map(r => ({
        ...r,
        period: new Date(r.year, r.month - 1).toLocaleDateString('en-KE', { month: 'long', year: 'numeric' }),
      })), [
        { label: 'Month',                key: 'period'       },
        { label: 'Orders',               key: 'orders'       },
        { label: 'VAT Rate (%)',          key: 'vatRate'      },
        { label: 'Ex-VAT (KES)',          key: 'totalExVat'   },
        { label: 'VAT Collected (KES)',   key: 'totalVat'     },
        { label: 'Incl. VAT (KES)',       key: 'totalInclVat' },
      ]);
      return { csv, filename: `vat-report-${Date.now()}.csv` };
    }

    default:
      throw new AppError('Unknown report type', 400, 'UNKNOWN_REPORT_TYPE');
  }
};

const getOnboardingAnalytics = async () => {
  const users = await User.find({
    role: { $in: ['customer', 'staff', 'supervisor', 'admin'] }
  }).select('role onboarding').lean();

  const byRole = new Map();

  for (const user of users) {
    const role = user.role;
    const onboarding = user.onboarding || {};
    const checklistProgress = onboarding.checklistProgress || {};
    const checklistValues = checklistProgress instanceof Map
      ? Array.from(checklistProgress.values())
      : Object.values(checklistProgress);
    const completedChecklist = checklistValues.filter(Boolean).length;
    const checklistCompletion = checklistValues.length
      ? Math.round((completedChecklist / checklistValues.length) * 100)
      : 0;

    if (!byRole.has(role)) {
      byRole.set(role, {
        role,
        userCount: 0,
        completedTours: 0,
        avgChecklistCompletion: 0,
        helpCenterOpens: 0,
        milestonesReached: 0
      });
    }

    const row = byRole.get(role);
    row.userCount += 1;
    row.completedTours += Array.isArray(onboarding.toursCompleted) ? onboarding.toursCompleted.length : 0;
    row.avgChecklistCompletion += checklistCompletion;
    row.helpCenterOpens += onboarding.helpCenterOpenedCount || 0;
    row.milestonesReached += Array.isArray(onboarding.milestones) ? onboarding.milestones.length : 0;
  }

  const rows = Array.from(byRole.values()).map(row => ({
    ...row,
    avgChecklistCompletion: row.userCount
      ? Math.round(row.avgChecklistCompletion / row.userCount)
      : 0
  }));

  const totals = rows.reduce((acc, row) => ({
    users: acc.users + row.userCount,
    completedTours: acc.completedTours + row.completedTours,
    helpCenterOpens: acc.helpCenterOpens + row.helpCenterOpens,
    milestonesReached: acc.milestonesReached + row.milestonesReached
  }), {
    users: 0,
    completedTours: 0,
    helpCenterOpens: 0,
    milestonesReached: 0
  });

  return {
    rows,
    totals
  };
};

// ── GROSS MARGIN REPORT ───────────────────────────────────────────────────────
// Aggregates revenue and estimated cost per SKU using costPriceKES from packaging.
// Only SKUs that have costPriceKES set are included.
const getMarginReport = async (period, from, to, branchId) => {
  const { start, end } = getDateRange(period, from, to);
  const branchFilter = branchId ? { branchId: new mongoose.Types.ObjectId(String(branchId)) } : {};

  const rows = await Order.aggregate([
    {
      $match: {
        ...branchFilter,
        status: { $in: REVENUE_STATUSES },
        createdAt: { $gte: start, $lte: end },
      },
    },
    { $unwind: '$orderItems' },
    // Net-of-discount revenue per line: couponDiscount is order-level, shared
    // proportionally by each item's share of the order subtotal — same allocation
    // order.service.js/etims.service.js use — so this reconciles with order.total
    // instead of overstating revenue on orders where a coupon was applied.
    {
      $addFields: {
        'orderItems.netRevenue': {
          $subtract: [
            '$orderItems.lineTotal',
            {
              $multiply: [
                { $cond: [{ $gt: ['$subtotal', 0] }, { $divide: ['$orderItems.lineTotal', '$subtotal'] }, 0] },
                { $ifNull: ['$couponDiscount', 0] },
              ],
            },
          ],
        },
      },
    },
    {
      $group: {
        _id: {
          productId:   '$orderItems.productId',
          productName: '$orderItems.productName',
          variety:     '$orderItems.variety',
          packaging:   '$orderItems.packaging',
        },
        unitsSold: { $sum: '$orderItems.quantity' },
        revenue:   { $sum: '$orderItems.netRevenue' },
        unitPrice: { $first: '$orderItems.unitPrice' },
      },
    },
    {
      $lookup: {
        from: 'products',
        localField: '_id.productId',
        foreignField: '_id',
        as: 'product',
      },
    },
    { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        productId:   '$_id.productId',
        productName: '$_id.productName',
        variety:     '$_id.variety',
        packaging:   '$_id.packaging',
        unitsSold:   1,
        revenue:     1,
        unitPrice:   1,
        costPriceKES: {
          $let: {
            vars: {
              v: {
                $first: {
                  $filter: {
                    input: '$product.varieties',
                    cond: { $eq: ['$$this.varietyName', '$_id.variety'] },
                  },
                },
              },
            },
            in: {
              $let: {
                vars: {
                  p: {
                    $first: {
                      $filter: {
                        input: '$$v.packaging',
                        cond: { $eq: ['$$this.size', '$_id.packaging'] },
                      },
                    },
                  },
                },
                in: '$$p.costPriceKES',
              },
            },
          },
        },
      },
    },
    {
      $addFields: {
        estimatedCost: {
          $cond: [
            { $gt: ['$costPriceKES', null] },
            { $multiply: ['$costPriceKES', '$unitsSold'] },
            null,
          ],
        },
      },
    },
    {
      $addFields: {
        grossProfit: {
          $cond: [
            { $gt: ['$estimatedCost', null] },
            { $subtract: ['$revenue', '$estimatedCost'] },
            null,
          ],
        },
        marginPct: {
          $cond: [
            { $and: [{ $gt: ['$estimatedCost', null] }, { $gt: ['$revenue', 0] }] },
            {
              $multiply: [
                { $divide: [{ $subtract: ['$revenue', '$estimatedCost'] }, '$revenue'] },
                100,
              ],
            },
            null,
          ],
        },
      },
    },
    { $sort: { grossProfit: -1 } },
  ]);

  const withCost = rows.filter(r => r.estimatedCost !== null);
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  const totalCost = withCost.reduce((s, r) => s + r.estimatedCost, 0);
  const totalGrossProfit = withCost.reduce((s, r) => s + r.grossProfit, 0);
  const overallMarginPct = totalRevenue > 0
    ? Math.round((totalGrossProfit / withCost.reduce((s, r) => s + r.revenue, 0)) * 100)
    : null;

  return {
    period: { start, end },
    summary: {
      totalRevenue: Math.round(totalRevenue),
      totalCost: Math.round(totalCost),
      totalGrossProfit: Math.round(totalGrossProfit),
      overallMarginPct,
      skusWithCostData: withCost.length,
      totalSkus: rows.length,
    },
    rows: rows.map(r => ({
      ...r,
      revenue: Math.round(r.revenue),
      estimatedCost: r.estimatedCost !== null ? Math.round(r.estimatedCost) : null,
      grossProfit: r.grossProfit !== null ? Math.round(r.grossProfit) : null,
      marginPct: r.marginPct !== null ? Math.round(r.marginPct) : null,
    })),
  };
};

// ── RIDER PERFORMANCE REPORT ──────────────────────────────────────────────────
// Uses deliveredAt (set on status → completed) and driverId on Order.
const getRiderReport = async (period, from, to, branchId) => {
  const { start, end } = getDateRange(period, from, to);
  const branchFilter = branchId ? { branchId: new mongoose.Types.ObjectId(String(branchId)) } : {};

  const rows = await Order.aggregate([
    {
      $match: {
        ...branchFilter,
        status: 'completed',
        deliveryMethod: 'delivery',
        driverId: { $ne: null },
        deliveredAt: { $ne: null },
        createdAt: { $gte: start, $lte: end },
      },
    },
    {
      $addFields: {
        // From the moment the order left (status out_for_delivery) when that is on record; "created to
        // delivered" also counted the wait for approval and packing, which is not the rider's time.
        dispatchedAt: {
          $let: {
            vars: { h: { $filter: { input: { $ifNull: ['$statusHistory', []] }, as: 's', cond: { $eq: ['$$s.status', 'out_for_delivery'] } } } },
            in: { $arrayElemAt: ['$$h.changedAt', 0] },
          },
        },
      },
    },
    {
      $addFields: {
        deliveryMinutes: {
          $divide: [
            { $subtract: ['$deliveredAt', { $ifNull: ['$dispatchedAt', '$createdAt'] }] },
            60000,
          ],
        },
      },
    },
    {
      $group: {
        _id: '$driverId',
        deliveries: { $sum: 1 },
        totalRevenue: { $sum: '$total' },
        avgDeliveryMinutes: { $avg: '$deliveryMinutes' },
        minDeliveryMinutes: { $min: '$deliveryMinutes' },
        maxDeliveryMinutes: { $max: '$deliveryMinutes' },
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'driver',
      },
    },
    { $unwind: { path: '$driver', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        driverId: '$_id',
        driverName: '$driver.name',
        driverPhone: '$driver.phone',
        deliveries: 1,
        totalRevenue: 1,
        avgDeliveryMinutes: { $round: ['$avgDeliveryMinutes', 0] },
        minDeliveryMinutes: { $round: ['$minDeliveryMinutes', 0] },
        maxDeliveryMinutes: { $round: ['$maxDeliveryMinutes', 0] },
      },
    },
    { $sort: { deliveries: -1 } },
  ]);

  return {
    period: { start, end },
    riders: rows,
  };
};

// ── CASH-UP & M-PESA RECONCILIATION ──────────────────────
// One page to close the day: what came in (by method), what each driver still has to account for,
// and the payments that need a human. Without it an admin confirms cash order by order and has no
// way to see what is missing.
const STUCK_PENDING_MINUTES = 15;

const getCashUpReport = async (period, from, to, branchId) => {
  const { start, end } = getDateRange(period, from, to);
  const oid = branchId ? new mongoose.Types.ObjectId(String(branchId)) : null;
  const orderBranch = oid ? { branchId: oid } : {};
  // Payments carry their branch (Payment.branchId), so money-in queries need no join to orders; only the short
  // "needs attention" lists look the order up, after they are cut to 50 rows.
  const paymentBranch = oid ? { branchId: oid } : {};
  const joinOrder = [
    { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: 'order' } },
    { $unwind: '$order' },
  ];

  // 1. Money in. M-Pesa with no confirmedBy came from Safaricom's callback; with one, a person typed it in.
  const paid = await Payment.aggregate([
    { $match: { status: 'paid', paidAt: { $gte: start, $lte: end }, ...paymentBranch } },
    { $group: {
      _id: { method: '$method', manual: { $cond: [{ $ifNull: ['$confirmedBy', false] }, true, false] } },
      // What arrived, not what was asked for: they differ by an over-payment, and payments recorded before
      // `receivedAmount` existed fall back to the amount asked for.
      count: { $sum: 1 }, amount: { $sum: { $ifNull: ['$receivedAmount', '$amount'] } },
    } },
  ]);
  const money = (rows) => rows.reduce((a, r) => ({ count: a.count + r.count, amount: a.amount + r.amount }), { count: 0, amount: 0 });
  const mpesaRows = paid.filter(r => r._id.method === 'mpesa');
  const cashRows = paid.filter(r => r._id.method !== 'mpesa');
  const byMethod = {
    mpesaAutomatic: money(mpesaRows.filter(r => !r._id.manual)),
    mpesaManual: money(mpesaRows.filter(r => r._id.manual)),
    cash: money(cashRows),
  };
  const totalIn = byMethod.mpesaAutomatic.amount + byMethod.mpesaManual.amount + byMethod.cash.amount;

  // 2. Cash confirmed, by the person who confirmed it.
  const cashByCollector = await Payment.aggregate([
    { $match: { status: 'paid', method: { $ne: 'mpesa' }, paidAt: { $gte: start, $lte: end }, ...paymentBranch } },
    { $group: { _id: '$confirmedBy', count: { $sum: 1 }, amount: { $sum: { $ifNull: ['$receivedAmount', '$amount'] } } } },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
    { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
    { $project: { _id: 0, userId: '$_id', name: '$user.name', role: '$user.role', count: 1, amount: 1 } },
    { $sort: { amount: -1 } },
  ]);

  // 3. Per driver: cash-on-delivery orders they completed vs what has been confirmed as received.
  const drivers = await Order.aggregate([
    { $match: {
      ...orderBranch, status: 'completed', deliveryMethod: 'delivery', paymentMethod: 'delivery',
      driverId: { $ne: null }, deliveredAt: { $gte: start, $lte: end },
    } },
    { $group: {
      _id: '$driverId',
      deliveries: { $sum: 1 },
      due: { $sum: '$total' },
      confirmed: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, '$total', 0] } },
      unconfirmedOrders: { $sum: { $cond: [{ $ne: ['$paymentStatus', 'paid'] }, 1, 0] } },
    } },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'driver' } },
    { $unwind: { path: '$driver', preserveNullAndEmptyArrays: true } },
    { $project: {
      _id: 0, driverId: '$_id', driverName: '$driver.name', deliveries: 1, due: 1, confirmed: 1,
      outstanding: { $subtract: ['$due', '$confirmed'] }, unconfirmedOrders: 1,
    } },
    { $sort: { outstanding: -1, deliveries: -1 } },
  ]);

  // 4. Orders that finished with money still unconfirmed (cash orders can complete unpaid by design).
  const unpaidCompleted = await Order.find({
    ...orderBranch, status: 'completed', paymentStatus: { $ne: 'paid' }, deliveredAt: { $gte: start, $lte: end },
  }).select('orderRef total paymentMethod deliveryMethod deliveredAt driverId').populate('driverId', 'name')
    .sort({ deliveredAt: -1 }).limit(100).lean();

  // 5. M-Pesa payments that need a person: money that arrived after the attempt was given up on,
  //    and prompts sent more than a quarter of an hour ago that never resolved.
  const stuckBefore = new Date(Date.now() - STUCK_PENDING_MINUTES * 60 * 1000);
  const attention = (match) => Payment.aggregate([
    { $match: { ...match, ...paymentBranch } },
    { $sort: { createdAt: -1 } },
    { $limit: 50 },
    ...joinOrder,
    { $project: { _id: 0, paymentId: '$_id', orderId: '$order._id', orderRef: '$order.orderRef', amount: 1, mpesaPhone: 1, createdAt: 1, lateSuccessMeta: 1, receiptMismatch: 1 } },
  ]);
  // Money that arrived but was not credited stays on the list until someone closes it (resolve-exception), whatever
  // period is on screen: it is a standing item, not a figure for a window. It used to disappear when the period moved
  // on, and could never be closed, so the Control Center flagged it for ever.
  const lateSuccess = await attention({ 'lateSuccessMeta.receivedAt': { $exists: true }, 'lateSuccessMeta.resolvedAt': null });
  const stuckPending = await attention({ method: 'mpesa', status: 'pending', createdAt: { $gte: start, $lte: stuckBefore } });
  // A typed receipt that Safaricom's callback later contradicted: standing until someone compares the two and closes it.
  const receiptMismatch = await attention({ 'receiptMismatch.detectedAt': { $exists: true }, 'receiptMismatch.resolvedAt': null });

  // 6. Why "received" and "invoiced" differ. Every payment taken in the period, against the orders it paid:
  //    invoiced (the order totals, with cents) + rounded up (each prompt asks for the next whole shilling)
  //    + overpaid (more than asked was actually received) = received. Without this the two figures simply disagree.
  const [reconRow] = await Payment.aggregate([
    { $match: { status: 'paid', paidAt: { $gte: start, $lte: end }, ...paymentBranch } },
    { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', pipeline: [{ $project: { total: 1 } }], as: 'order' } },
    { $unwind: '$order' },
    { $group: {
      _id: null,
      payments: { $sum: 1 },
      invoiced: { $sum: '$order.total' },
      asked: { $sum: '$amount' },
      received: { $sum: { $ifNull: ['$receivedAmount', '$amount'] } },
    } },
  ]);
  const r2 = (n) => Math.round((n || 0) * 100) / 100;
  const reconciliation = {
    payments: reconRow?.payments || 0,
    invoiced: r2(reconRow?.invoiced),
    roundedUp: r2((reconRow?.asked || 0) - (reconRow?.invoiced || 0)),
    overpaid: r2((reconRow?.received || 0) - (reconRow?.asked || 0)),
    received: r2(reconRow?.received),
  };

  // 7. Refunds. OWED is a standing balance (money taken for an order that then closed, not yet sent back), whatever
  //    the period; SENT is what went back inside the period. The M-Pesa paybill balance and the statement include money
  //    that is owed back, so without this line the cash-up cannot be matched to the statement.
  const owedMatch = { status: 'refunded', refundSentAt: null, ...paymentBranch };
  const [owedTotals] = await Payment.aggregate([
    { $match: owedMatch },
    { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: { $ifNull: ['$receivedAmount', '$amount'] } }, oldestAt: { $min: '$refundedAt' } } },
  ]);
  const owedOrders = await Payment.aggregate([
    { $match: owedMatch },
    { $sort: { refundedAt: 1 } },
    { $limit: 50 },
    ...joinOrder,
    { $project: {
      _id: 0, paymentId: '$_id', orderId: '$order._id', orderRef: '$order.orderRef', method: 1,
      amount: { $ifNull: ['$receivedAmount', '$amount'] }, refundedAt: 1, refundReason: 1, mpesaPhone: 1,
    } },
  ]);
  const [sentTotals] = await Payment.aggregate([
    { $match: { status: 'refunded', refundSentAt: { $gte: start, $lte: end }, ...paymentBranch } },
    { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$refundSentAmount' } } },
  ]);
  const refunds = {
    owed: { count: owedTotals?.count || 0, amount: r2(owedTotals?.amount), oldestAt: owedTotals?.oldestAt || null, orders: owedOrders },
    sent: { count: sentTotals?.count || 0, amount: r2(sentTotals?.amount) },
  };

  return {
    period: { start, end },
    totalIn,
    byMethod,
    cashByCollector,
    drivers,
    reconciliation,
    refunds,
    totals: {
      cashOutstanding: drivers.reduce((s, d) => s + d.outstanding, 0),
      needsAttention: unpaidCompleted.length + lateSuccess.length + stuckPending.length + receiptMismatch.length + refunds.owed.count,
    },
    exceptions: { unpaidCompleted, lateSuccess, stuckPending, receiptMismatch },
  };
};

// ── VAT REPORT ────────────────────────────────────────────────────────────────
// Monthly VAT summary for KRA filing
const getVatReport = async (period, from, to, branchId) => {
  const { start, end } = getDateRange(period, from, to);
  const branchFilter = branchId ? { branchId: new mongoose.Types.ObjectId(String(branchId)) } : {};

  const rows = await Order.aggregate([
    {
      $match: {
        ...branchFilter,
        status: { $in: VAT_INVOICEABLE_STATUSES },
        vatEnabled: true,
        createdAt: { $gte: start, $lte: end },
      },
    },
    {
      $group: {
        _id: {
          year:  { $year:  { date: '$createdAt', timezone: NAIROBI_TZ } },
          month: { $month: { date: '$createdAt', timezone: NAIROBI_TZ } },
        },
        orders:      { $sum: 1 },
        totalExVat:  { $sum: { $subtract: ['$subtotal', { $ifNull: ['$couponDiscount', 0] }] } },
        // Goods lines flagged taxable vs exempt (before coupon discount) - the split a VAT return needs.
        taxableSales: { $sum: { $reduce: { input: { $ifNull: ['$orderItems', []] }, initialValue: 0,
          in: { $add: ['$$value', { $cond: [{ $ne: ['$$this.taxable', false] }, { $ifNull: ['$$this.lineTotal', 0] }, 0] }] } } } },
        exemptSales: { $sum: { $reduce: { input: { $ifNull: ['$orderItems', []] }, initialValue: 0,
          in: { $add: ['$$value', { $cond: [{ $eq: ['$$this.taxable', false] }, { $ifNull: ['$$this.lineTotal', 0] }, 0] }] } } } },
        deliveryFees: { $sum: { $ifNull: ['$deliveryFee', 0] } },
        totalVat:    { $sum: '$vatAmount' },
        totalInclVat:{ $sum: { $add: [{ $subtract: ['$subtotal', { $ifNull: ['$couponDiscount', 0] }] }, '$vatAmount'] } },
        vatRate:     { $first: '$vatRate' },
      },
    },
    { $sort: { '_id.year': 1, '_id.month': 1 } },
    {
      $project: {
        _id: 0,
        year:         '$_id.year',
        month:        '$_id.month',
        orders:       1,
        vatRate:      1,
        totalExVat:   { $round: ['$totalExVat',   0] },
        taxableSales: { $round: ['$taxableSales', 0] },
        exemptSales:  { $round: ['$exemptSales',  0] },
        deliveryFees: { $round: ['$deliveryFees', 0] },
        totalVat:     { $round: ['$totalVat',     0] },
        totalInclVat: { $round: ['$totalInclVat', 0] },
      },
    },
  ]);

  const summary = rows.reduce(
    (acc, r) => ({
      totalOrders:   acc.totalOrders   + r.orders,
      totalExVat:    acc.totalExVat    + r.totalExVat,
      taxableSales:  acc.taxableSales  + r.taxableSales,
      exemptSales:   acc.exemptSales   + r.exemptSales,
      deliveryFees:  acc.deliveryFees  + r.deliveryFees,
      totalVat:      acc.totalVat      + r.totalVat,
      totalInclVat:  acc.totalInclVat  + r.totalInclVat,
    }),
    { totalOrders: 0, totalExVat: 0, taxableSales: 0, exemptSales: 0, deliveryFees: 0, totalVat: 0, totalInclVat: 0 }
  );

  return { period: { start, end }, summary, rows };
};

// ── CUSTOMER STATEMENT ────────────────────────────────────────────────────────
// All completed orders for one customer in a date range (admin-downloadable)
const getCustomerStatement = async (userId, period, from, to, branchId) => {
  const { start, end } = getDateRange(period, from, to);
  const branchFilter = branchId ? { branchId: new mongoose.Types.ObjectId(String(branchId)) } : {};

  const orders = await Order.find({
    ...branchFilter,
    userId,
    status: { $in: REVENUE_STATUSES },
    createdAt: { $gte: start, $lte: end },
  })
    .select('orderRef createdAt subtotal deliveryFee vatAmount couponDiscount total paymentMethod paymentStatus')
    .sort({ createdAt: 1 })
    .lean();

  const summary = orders.reduce(
    (acc, o) => ({
      totalOrders:    acc.totalOrders + 1,
      totalSpend:     acc.totalSpend  + o.total,
      totalVat:       acc.totalVat    + (o.vatAmount || 0),
      totalDiscounts: acc.totalDiscounts + (o.couponDiscount || 0),
    }),
    { totalOrders: 0, totalSpend: 0, totalVat: 0, totalDiscounts: 0 }
  );

  return { period: { start, end }, orders, summary };
};

// Public entry points for the heavy analytical reports go through the minute cache; the CSV export and the
// live views (dashboard, cash-up) call the functions above directly and are always fresh.
const cacheable = (name, fn) => (...args) => (args[0] === 'today' ? fn(...args) : cached(name, args, () => fn(...args)));

module.exports = {
  getDashboardKPIs,
  getSalesReport: cacheable('sales', getSalesReport),
  getBestSellers: cacheable('best', getBestSellers),
  getSlowMovers,
  getStockValuation,
  getStockTurnoverReport: cacheable('turnover', getStockTurnoverReport),
  getStockMovementReport,
  getCustomerReport: cacheable('customers', getCustomerReport),
  getOrdersByStatus,
  exportReport,
  getOnboardingAnalytics,
  getMarginReport: cacheable('margin', getMarginReport),
  getRiderReport,
  getCashUpReport,
  getVatReport: cacheable('vat', getVatReport),
  getCustomerStatement,
  toCSV,
  _clearReportCache: () => reportCache.clear(),
};
