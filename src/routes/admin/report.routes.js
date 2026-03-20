const express = require('express');
const router = express.Router();
const reportController = require('../../controllers/admin/report.controller');
const { verifyToken } = require('../../middleware/auth.middleware');
const { requireMinRole } = require('../../middleware/role.middleware');
const { adminLimiter } = require('../../middleware/rateLimit.middleware');

// All report routes require auth
router.use(verifyToken, adminLimiter);

// ── DASHBOARD KPIs - supervisor+ ──────────────────────────────────────────────
// GET /api/admin/reports/kpis
router.get('/kpis', requireMinRole('supervisor'), reportController.getDashboardKPIs);

// ── SALES REPORTS - supervisor+ ───────────────────────────────────────────────
// GET /api/admin/reports/sales?period=today|week|month|year&from=&to=
router.get('/sales', requireMinRole('supervisor'), reportController.getSalesReport);

// ── PRODUCT REPORTS - supervisor+ ─────────────────────────────────────────────
// GET /api/admin/reports/best-sellers?period=month&limit=10
router.get('/best-sellers', requireMinRole('supervisor'), reportController.getBestSellers);

// GET /api/admin/reports/slow-movers?days=30
router.get('/slow-movers', requireMinRole('supervisor'), reportController.getSlowMovers);

// ── STOCK REPORTS - supervisor+ ───────────────────────────────────────────────
// GET /api/admin/reports/stock-valuation
router.get('/stock-valuation', requireMinRole('supervisor'), reportController.getStockValuation);

// GET /api/admin/reports/stock-movement?period=month&from=&to=
router.get('/stock-movement', requireMinRole('supervisor'), reportController.getStockMovementReport);

// ── CUSTOMER REPORT - supervisor+ ────────────────────────────────────────────
// GET /api/admin/reports/customers
router.get('/customers', requireMinRole('supervisor'), reportController.getCustomerReport);

// ── ORDERS REPORT - supervisor+ ───────────────────────────────────────────────
// GET /api/admin/reports/orders?period=month
router.get('/orders', requireMinRole('supervisor'), reportController.getOrdersByStatus);

// ── CSV EXPORT - admin+ only per SRS 5.6 ─────────────────────────────────────
// GET /api/admin/reports/export/:type?period=month
// type: sales | best-sellers | stock-valuation | customers | orders | stock-movement
router.get('/export/:type', requireMinRole('admin'), reportController.exportReport);

module.exports = router;
