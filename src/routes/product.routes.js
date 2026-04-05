const express = require('express');
const router = express.Router();
const productController = require('../controllers/product.controller');

// GET /api/products
router.get('/', productController.getAll);

// GET /api/products/categories
router.get('/categories', productController.getCategories);

// GET /api/products/suggestions?q=mai
router.get('/suggestions', productController.getSuggestions);

// GET /api/products/:id
router.get('/:id', productController.getById);

module.exports = router;
