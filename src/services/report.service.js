const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const StockLog = require('../models/StockLog');
const User = require('../models/User');

// ── HELPERS ───────────────────────────────────────────────────────────────────

const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const endOfDay = (date) => {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
};

const getDateRange = (period, from, to) => {
  const now = new Date();
  if (from && to) return { start: new Date(from), end: new Date(to) };
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
// UX B1 - KPI cards visible immediately on login, cached 60s
// Orders today, pending orders, revenue today, revenue this month, low stock count
const getDashboardKPIs = async () => {
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    ordersToday,
    pendingOrders,
    revenueToday,
    revenueThisMonth,
    lowStockCount,
    recentOrders
  ] = await Promise.all([
    // Orders placed today
    Order.countDocuments({ createdAt: { $gte: todayStart, $lte: todayEnd } }),

    // Pending orders
    Order.countDocuments({ status: 'pending' }),

    // Revenue today (completed orders only)
    Order.aggregate([
      { $match: { status: 'completed', updatedAt: { $gte: todayStart, $lte: todayEnd } } },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]),

    // Revenue this month
    Order.aggregate([
      { $match: { status: 'completed', updatedAt: { $gte: monthStart } } },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]),

    // Low stock items count
    (async () => {
      const products = await Product.find({}).lean();
      let count = 0;
      for (const p of products) {
        for (const v of p.varieties) {
          for (const pkg of v.packaging) {
            if (!pkg.quoteOnly && pkg.stock <= pkg.lowStockThreshold) count++;
          }
        }
      }
      return count;
    })(),

    // Recent 10 orders for dashboard panel - UX B1
    Order.find({})
      .populate('userId', 'name phone')
      .populate('guestId', 'name phone')
      .sort({ createdAt: -1 })
      .limit(10)
      .select('orderRef status total paymentMethod createdAt userId guestId')
      .lean()
  ]);

  return {
    ordersToday,
    pendingOrders,
    revenueToday: revenueToday[0]?.total || 0,
    revenueThisMonth: revenueThisMonth[0]?.total || 0,
    lowStockCount,
    recentOrders
  };
};

// ── SALES REPORT ──────────────────────────────────────────────────────────────
// SRS 5.7 + UX B5 - daily/weekly/monthly totals, revenue by category
// Used for line/bar charts on dashboard
const getSalesReport = async (period, from, to) => {
  const { start, end } = getDateRange(period, from, to);

  const [summary, byCategory, byDay, orderVolume] = await Promise.all([
    // Overall summary
    Order.aggregate([
      { $match: { status: 'completed', updatedAt: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$total' },
          totalOrders: { $sum: 1 },
          avgOrderValue: { $avg: '$total' },
          totalItems: { $sum: { $size: '$orderItems' } }
        }
      }
    ]),

    // Revenue by product category
    Order.aggregate([
      { $match: { status: 'completed', updatedAt: { $gte: start, $lte: end } } },
      { $unwind: '$orderItems' },
      {
        $lookup: {
          from: 'products',
          localField: 'orderItems.productId',
          foreignField: '_id',
          as: 'product'
        }
      },
      { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: '$product.category',
          revenue: { $sum: '$orderItems.lineTotal' },
          unitsSold: { $sum: '$orderItems.quantity' },
          orderCount: { $sum: 1 }
        }
      },
      { $sort: { revenue: -1 } }
    ]),

    // Revenue by day (for line chart - UX B5)
    Order.aggregate([
      { $match: { status: 'completed', updatedAt: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: {
            year: { $year: '$updatedAt' },
            month: { $month: '$updatedAt' },
            day: { $dayOfMonth: '$updatedAt' }
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
              day: '$_id.day'
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
      { $match: { status: 'completed', updatedAt: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: '$paymentMethod',
          count: { $sum: 1 },
          revenue: { $sum: '$total' }
        }
      }
    ])
  ]);

  const s = summary[0] || {};
  return {
    period: { start, end },
    summary: {
      totalRevenue: s.totalRevenue || 0,
      totalOrders: s.totalOrders || 0,
      avgOrderValue: s.avgOrderValue ? Math.round(s.avgOrderValue) : 0,
      totalItems: s.totalItems || 0
    },
    byCategory,
    byDay,
    byPaymentMethod: orderVolume
  };
};

// ── BEST SELLERS ──────────────────────────────────────────────────────────────
// UX B5 - products ranked by units sold and revenue
const getBestSellers = async (period, from, to, limit = 10) => {
  const { start, end } = getDateRange(period, from, to);

  const results = await Order.aggregate([
    { $match: { status: 'completed', createdAt: { $gte: start, $lte: end } } },
    { $unwind: '$orderItems' },
    {
      $group: {
        _id: {
          productId: '$orderItems.productId',
          productName: '$orderItems.productName',
          variety: '$orderItems.variety',
          packaging: '$orderItems.packaging'
        },
        unitsSold: { $sum: '$orderItems.quantity' },
        revenue: { $sum: '$orderItems.lineTotal' },
        orderCount: { $sum: 1 }
      }
    },
    { $sort: { unitsSold: -1 } },
    { $limit: Number(limit) },
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
const getSlowMovers = async (days = 30) => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  // Get all active products
  const allProducts = await Product.find({ isActive: true })
    .select('name category varieties')
    .lean();

  // Get products that had orders in the period
  const activeProductIds = await Order.distinct('orderItems.productId', {
    status: 'completed',
    createdAt: { $gte: cutoff }
  });

  const activeSet = new Set(activeProductIds.map(id => id.toString()));

  const slowMovers = allProducts
    .filter(p => !activeSet.has(p._id.toString()))
    .map(p => ({
      productId: p._id,
      name: p.name,
      category: p.category,
      varietyCount: p.varieties.length,
      daysWithoutSale: days
    }));

  return { days, slowMovers, count: slowMovers.length };
};

// ── STOCK VALUATION ───────────────────────────────────────────────────────────
// UX B5 - current stock × price per size = estimated stock value
const getStockValuation = async () => {
  const products = await Product.find({ isActive: true })
    .select('name category varieties')
    .lean();

  const rows = [];
  let totalValue = 0;

  for (const product of products) {
    for (const variety of product.varieties) {
      for (const pkg of variety.packaging) {
        if (pkg.quoteOnly || !pkg.priceKES) continue;
        const value = pkg.stock * pkg.priceKES;
        totalValue += value;
        rows.push({
          productName: product.name,
          category: product.category,
          varietyName: variety.varietyName,
          packagingSize: pkg.size,
          stock: pkg.stock,
          priceKES: pkg.priceKES,
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
    itemCount: rows.length
  };
};

// ── STOCK MOVEMENT REPORT ─────────────────────────────────────────────────────
// UX B5 - all stock changes in a date range by product
const getStockMovementReport = async (period, from, to) => {
  const { start, end } = getDateRange(period, from, to);

  const logs = await StockLog.find({
    timestamp: { $gte: start, $lte: end }
  })
    .populate('productId', 'name category')
    .populate('performedBy', 'name role')
    .sort({ timestamp: -1 })
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
    count: logs.length
  };
};

// ── CUSTOMER REPORT ───────────────────────────────────────────────────────────
// UX B5 - repeat buyers, high-value, inactive customers
const getCustomerReport = async () => {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const stats = await Order.aggregate([
    { $match: { status: 'completed', userId: { $ne: null } } },
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
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'user'
      }
    },
    { $unwind: '$user' },
    {
      $project: {
        name: '$user.name',
        phone: '$user.phone',
        email: '$user.email',
        totalOrders: 1,
        totalSpend: 1,
        avgOrderValue: { $round: ['$avgOrderValue', 0] },
        firstOrder: 1,
        lastOrder: 1,
        daysSinceLastOrder: {
          $divide: [
            { $subtract: [new Date(), '$lastOrder'] },
            1000 * 60 * 60 * 24
          ]
        }
      }
    },
    { $sort: { totalSpend: -1 } }
  ]);

  // Segment customers - SRS 5.5
  const sorted = [...stats].sort((a, b) => b.totalSpend - a.totalSpend);
  const top10Threshold = sorted[Math.floor(sorted.length * 0.1)]?.totalSpend || 0;

  const enriched = stats.map(c => ({
    ...c,
    isRepeat: c.totalOrders >= 3,
    isHighValue: c.totalSpend >= top10Threshold,
    isInactive: c.daysSinceLastOrder >= 30,
    daysSinceLastOrder: Math.floor(c.daysSinceLastOrder)
  }));

  return {
    total: enriched.length,
    repeat: enriched.filter(c => c.isRepeat).length,
    highValue: enriched.filter(c => c.isHighValue).length,
    inactive: enriched.filter(c => c.isInactive).length,
    customers: enriched
  };
};

// ── ORDERS BY STATUS REPORT ───────────────────────────────────────────────────
// UX B5 - count and value of orders at each status stage
const getOrdersByStatus = async (period, from, to) => {
  const { start, end } = getDateRange(period, from, to);

  const [byStatus, peakHours, avgOrderValue] = await Promise.all([
    // Orders grouped by status
    Order.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
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
      { $match: { createdAt: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: { $hour: '$createdAt' },
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]),

    // Average order value
    Order.aggregate([
      { $match: { status: 'completed', createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, avg: { $avg: '$total' } } }
    ])
  ]);

  return {
    period: { start, end },
    byStatus,
    peakHours: peakHours.map(h => ({ hour: h._id, orders: h.count })),
    avgOrderValue: avgOrderValue[0]?.avg ? Math.round(avgOrderValue[0].avg) : 0
  };
};

// ── CSV EXPORT HELPER ─────────────────────────────────────────────────────────
// SRS 5.7 - all reports exportable as CSV
// Simple CSV without external dependency
const toCSV = (data, columns) => {
  if (!data || data.length === 0) return columns.map(c => c.label).join(',') + '\n';

  const header = columns.map(c => `"${c.label}"`).join(',');
  const rows = data.map(row =>
    columns.map(c => {
      const val = c.key.split('.').reduce((obj, k) => obj?.[k], row);
      const str = val === null || val === undefined ? '' : String(val);
      return `"${str.replace(/"/g, '""')}"`;
    }).join(',')
  );

  return [header, ...rows].join('\n');
};

// ── EXPORT REPORT ─────────────────────────────────────────────────────────────
// Returns CSV string for any report type - SRS 5.7
const exportReport = async (type, params) => {
  const { period, from, to } = params;

  switch (type) {
    case 'sales': {
      const data = await getSalesReport(period, from, to);
      const csv = toCSV(data.byDay, [
        { label: 'Date', key: 'date' },
        { label: 'Orders', key: 'orders' },
        { label: 'Revenue (KES)', key: 'revenue' }
      ]);
      return { csv, filename: `sales-report-${Date.now()}.csv` };
    }

    case 'best-sellers': {
      const data = await getBestSellers(period, from, to, 50);
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
      const data = await getStockValuation();
      const csv = toCSV(data.rows, [
        { label: 'Product', key: 'productName' },
        { label: 'Category', key: 'category' },
        { label: 'Variety', key: 'varietyName' },
        { label: 'Packaging', key: 'packagingSize' },
        { label: 'Stock', key: 'stock' },
        { label: 'Price (KES)', key: 'priceKES' },
        { label: 'Total Value (KES)', key: 'totalValueKES' }
      ]);
      return { csv, filename: `stock-valuation-${Date.now()}.csv` };
    }

    case 'customers': {
      const data = await getCustomerReport();
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
      const data = await getOrdersByStatus(period, from, to);
      const csv = toCSV(data.byStatus, [
        { label: 'Status', key: '_id' },
        { label: 'Count', key: 'count' },
        { label: 'Total Value (KES)', key: 'totalValue' },
        { label: 'Avg Value (KES)', key: 'avgValue' }
      ]);
      return { csv, filename: `orders-report-${Date.now()}.csv` };
    }

    case 'stock-movement': {
      const data = await getStockMovementReport(period, from, to);
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

    default:
      throw new Error('Unknown report type');
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

module.exports = {
  getDashboardKPIs,
  getSalesReport,
  getBestSellers,
  getSlowMovers,
  getStockValuation,
  getStockMovementReport,
  getCustomerReport,
  getOrdersByStatus,
  exportReport,
  getOnboardingAnalytics
};
