const express = require('express');
const router = express.Router();
const productController = require('../controllers/product.controller');

// GET /api/products
router.get('/', productController.getAll);

// GET /api/products/categories
router.get('/categories', productController.getCategories);

// GET /api/products/suggestions?q=mai
router.get('/suggestions', productController.getSuggestions);

// GET /api/products/price-changes?ids=id1,id2,id3
router.get('/price-changes', productController.getPriceChanges);

// GET /api/products/:id
router.get('/:id', productController.getById);

// GET /api/products/:id/price-history?variety=X&packaging=Y
router.get('/:id/price-history', productController.getPriceHistory);

// GET /api/products/:id/best-time?variety=X&packaging=Y&price=N
router.get('/:id/best-time', productController.getBestTimeBadge);

module.exports = router;
