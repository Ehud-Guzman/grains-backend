const { exportProducts, importProducts, getTemplate } = require('../services/productImportExport.service');
const { AppError } = require('../middleware/errorHandler.middleware');

// GET /api/admin/products/export
const exportHandler = async (req, res, next) => {
  try {
    const buffer = await exportProducts();
    const filename = `vittorios-products-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/products/template
const templateHandler = async (req, res, next) => {
  try {
    const buffer = getTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="product-import-template.xlsx"');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
};

// POST /api/admin/products/import
const importHandler = async (req, res, next) => {
  try {
    if (!req.file) {
      throw new AppError('No file uploaded', 400, 'FILE_REQUIRED');
    }

    const allowedTypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ];
    if (!allowedTypes.includes(req.file.mimetype)) {
      throw new AppError('Only .xlsx or .xls files are accepted', 400, 'INVALID_FILE_TYPE');
    }

    const results = await importProducts(req.file.buffer, req.user.id);

    res.status(200).json({
      success: true,
      data: results,
      message: `Import complete: ${results.created} created, ${results.updated} updated, ${results.skipped} skipped`
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { exportHandler, templateHandler, importHandler };