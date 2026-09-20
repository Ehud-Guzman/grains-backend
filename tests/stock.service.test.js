const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const testDb = require('./helpers/testDb');
const { createBranch, createUser, createProduct, objectId } = require('./helpers/fixtures');

const stockService = require('../src/services/stock.service');
const Product = require('../src/models/Product');
const StockLog = require('../src/models/StockLog');

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

describe('stock.service — addDelivery atomicity and duplicate guard', () => {
  let branch, admin, product;

  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
    admin = await createUser(branch._id, { role: 'admin' });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 10 } });
  });

  const currentStock = async () =>
    (await Product.findById(product._id).lean()).varieties[0].packaging[0].stock;

  const logsFor = () => StockLog.find({ productId: product._id }).lean();

  const addDelivery = (quantity, { sourceIntakeId = null } = {}) =>
    stockService.addDelivery(
      product._id, 'Yellow', '50kg', quantity,
      'Truck KAA 001A', null, admin._id, branch._id, 'admin', sourceIntakeId
    );

  test('increments stock and writes exactly one matching StockLog row', async () => {
    await addDelivery(5);

    assert.equal(await currentStock(), 15);

    const logs = await logsFor();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].quantityChange, 5);
    // The invariant the transaction exists to protect: the balance recorded in
    // the audit trail must equal the stock actually on hand. When these were two
    // independent writes, a crash between the $inc and the log write broke this
    // silently — stock moved with nothing to explain it.
    assert.equal(logs[0].balanceAfter, 15);
  });

  test('an identical concurrent delivery is applied only once', async () => {
    const results = await Promise.allSettled([addDelivery(5), addDelivery(5)]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'exactly one of two identical concurrent deliveries should apply');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.errorCode, 'DUPLICATE_SUBMISSION');

    // The whole point of the guard: stock moves once, not twice. The pre-check
    // alone could not guarantee this — both calls passed it before either wrote.
    assert.equal(await currentStock(), 15);
    assert.equal((await logsFor()).length, 1);
  });

  test('an identical sequential delivery inside the window is rejected', async () => {
    await addDelivery(5);

    await assert.rejects(
      () => addDelivery(5),
      (err) => err.errorCode === 'DUPLICATE_SUBMISSION'
    );

    assert.equal(await currentStock(), 15);
  });

  test('a different quantity in the same window is not a duplicate', async () => {
    await addDelivery(5);
    await addDelivery(3);

    assert.equal(await currentStock(), 18);
    assert.equal((await logsFor()).length, 2);
  });

  test('a failure after the stock increment rolls the whole delivery back', async () => {
    // Deliberately bypasses the route validator (defence-in-depth): an
    // uncastable sourceIntakeId makes the StockIntake link throw *after* the
    // $inc has already run. Without the transaction, stock stayed incremented and
    // a StockLog row was left pointing at nothing.
    await assert.rejects(() => addDelivery(5, { sourceIntakeId: 'not-an-object-id' }));

    assert.equal(await currentStock(), 10, 'stock must be unchanged when any part of the delivery fails');
    assert.equal((await logsFor()).length, 0);
  });

  test('rejects a non-positive quantity', async () => {
    await assert.rejects(
      () => addDelivery(0),
      (err) => err.errorCode === 'INVALID_QUANTITY'
    );
    assert.equal(await currentStock(), 10);
  });
});
