const reportService = require('../../services/report.service');
const { success } = require('../../utils/apiResponse');

const getDashboardKPIs = async (req, res, next) => {
  try {
    const data = await reportService.getDashboardKPIs();
    return success(res, data);
  } catch (err) { next(err); }
};

const getSalesReport = async (req, res, next) => {
  try {
    const { period, from, to } = req.query;
    const data = await reportService.getSalesReport(period, from, to);
    return success(res, data);
  } catch (err) { next(err); }
};

const getBestSellers = async (req, res, next) => {
  try {
    const { period, from, to, limit } = req.query;
    const data = await reportService.getBestSellers(period, from, to, limit);
    return success(res, data);
  } catch (err) { next(err); }
};

const getSlowMovers = async (req, res, next) => {
  try {
    const { days } = req.query;
    const data = await reportService.getSlowMovers(days || 30);
    return success(res, data);
  } catch (err) { next(err); }
};

const getStockValuation = async (req, res, next) => {
  try {
    const data = await reportService.getStockValuation();
    return success(res, data);
  } catch (err) { next(err); }
};

const getStockMovementReport = async (req, res, next) => {
  try {
    const { period, from, to } = req.query;
    const data = await reportService.getStockMovementReport(period, from, to);
    return success(res, data);
  } catch (err) { next(err); }
};

const getCustomerReport = async (req, res, next) => {
  try {
    const data = await reportService.getCustomerReport();
    return success(res, data);
  } catch (err) { next(err); }
};

const getOrdersByStatus = async (req, res, next) => {
  try {
    const { period, from, to } = req.query;
    const data = await reportService.getOrdersByStatus(period, from, to);
    return success(res, data);
  } catch (err) { next(err); }
};

// CSV export - streams file download to browser - SRS 5.7
const exportReport = async (req, res, next) => {
  try {
    const { type } = req.params;
    const { period, from, to } = req.query;

    const { csv, filename } = await reportService.exportReport(type, { period, from, to });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csv);
  } catch (err) { next(err); }
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
  exportReport
};
