const express = require('express');
const router = express.Router();
const listController = require('../controllers/savedList.controller');
const { verifyToken } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { publicLimiter } = require('../middleware/rateLimit.middleware');

router.use(verifyToken, requireRole('customer'), publicLimiter);

// GET  /api/lists        — my lists
router.get('/', listController.getMyLists);

// POST /api/lists        — create list
router.post('/', listController.createList);

// GET  /api/lists/:id    — get one list
router.get('/:id', listController.getListById);

// PUT  /api/lists/:id    — update list (name / items)
router.put('/:id', listController.updateList);

// DELETE /api/lists/:id  — delete list
router.delete('/:id', listController.deleteList);

module.exports = router;
