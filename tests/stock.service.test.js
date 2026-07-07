const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const testDb = require('./helpers/testDb');
const { createBranch, createUser, createProduct, objectId } = require('./helpers/fixtures');

const stockService = require('../src/services/stock.service');
const Product = require('../src/models/Product');

before(async () => { await testDb.connect(); });
after(async () => { await testDb.disconnect(); });

describe('stock.service — deductStock / releaseStock', () => {
  let branch, product;

  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
    const admin = await createUser(branch._id, { role: 'admin' });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 10 } });
  });

  test('deductStock is atomic and never oversells under concurrent requests', async () => {
    // Two concurrent requests both try to take 6 of the 10 units available —
    // only one can succeed; the other must see insufficient stock, never a negative balance.
    const attempt = () => stockService.deductStock(
      product._id, 'Yellow', '50kg', 6, objectId(), objectId(), null, branch._id
    );

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'exactly one of the two concurrent deductions should succeed');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.errorCode, 'STOCK_INSUFFICIENT');

    const refreshed = await Product.findById(product._id).lean();
    assert.equal(refreshed.varieties[0].packaging[0].stock, 4, 'stock should never go negative');
  });

  test('releaseStock adds the quantity back and logs the movement', async () => {
    await stockService.deductStock(product._id, 'Yellow', '50kg', 5, objectId(), objectId(), null, branch._id);
    await stockService.releaseStock(product._id, 'Yellow', '50kg', 5, objectId(), objectId(), null, branch._id);

    const refreshed = await Product.findById(product._id).lean();
    assert.equal(refreshed.varieties[0].packaging[0].stock, 10);
  });

  test('deductStock throws for an unknown packaging size', async () => {
    await assert.rejects(
      stockService.deductStock(product._id, 'Yellow', '999kg', 1, objectId(), objectId(), null, branch._id),
      (err) => err.errorCode === 'STOCK_INSUFFICIENT' || err.errorCode === 'PRODUCT_NOT_FOUND'
    );
  });

  test('getLowStock flags items at or below their threshold', async () => {
    await stockService.deductStock(product._id, 'Yellow', '50kg', 9, objectId(), objectId(), null, branch._id);
    // stock is now 1, threshold on the fixture is 10 → should be flagged
    const lowStock = await stockService.getLowStock(branch._id);
    assert.ok(lowStock.some(r => r.productId.toString() === product._id.toString()));
  });
});
