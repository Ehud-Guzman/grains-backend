const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const testDb = require('./helpers/testDb');
const { createBranch, createUser, createProduct, objectId } = require('./helpers/fixtures');

const stockIntakeService = require('../src/services/stockIntake.service');

before(async () => { await testDb.connect(); });
after(async () => { await testDb.disconnect(); });

describe('stockIntake.service — reconciliation', () => {
  let branch, admin, product;

  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
    admin = await createUser(branch._id, { role: 'admin' });
    product = await createProduct(branch._id, admin._id);
  });

  test('computes rawTotal/packedTotal/variancePct when a delivery is linked', async () => {
    const intake = await stockIntakeService.create({
      supplier: 'Acme Grains',
      vehicleRef: 'KAA 001A',
      arrivedAt: new Date().toISOString(),
      items: [{ description: 'Yellow maize', quantity: 100, unit: 'bags' }],
    }, admin._id, branch._id);

    // Simulate stock.service.js#addDelivery having linked 80 units into the
    // product — this test seeds linkedDeliveries directly rather than going
    // through addDelivery, since reconciliation only cares about the shape.
    const StockIntake = require('../src/models/StockIntake');
    await StockIntake.findByIdAndUpdate(intake._id, {
      $push: {
        linkedDeliveries: {
          productId: product._id, varietyName: 'Yellow', packagingSize: '50kg',
          quantity: 80, performedBy: admin._id, appliedAt: new Date(),
        },
      },
    });

    const result = await stockIntakeService.getOne(intake._id, branch._id);
    assert.equal(result.reconciliation.rawTotal, 100);
    assert.equal(result.reconciliation.packedTotal, 80);
    assert.equal(result.reconciliation.variancePct, 20);
    assert.equal(result.reconciliation.unitsConsistent, true);
    assert.equal(result.reconciliation.highVariance, true, '20% variance exceeds the 15% threshold');
  });

  test('empty linkedDeliveries → 100% variance, no divide-by-zero', async () => {
    const intake = await stockIntakeService.create({
      supplier: 'Acme Grains',
      arrivedAt: new Date().toISOString(),
      items: [{ description: 'Yellow maize', quantity: 50, unit: 'bags' }],
    }, admin._id, branch._id);

    const result = await stockIntakeService.getOne(intake._id, branch._id);
    assert.equal(result.reconciliation.rawTotal, 50);
    assert.equal(result.reconciliation.packedTotal, 0);
    assert.equal(result.reconciliation.variancePct, 100);
    assert.equal(result.reconciliation.highVariance, true);
  });

  test('rawTotal of 0 does not throw and reports null variance', async () => {
    // items requires min quantity 0 and at least one item — a single zero-quantity line is valid.
    const intake = await stockIntakeService.create({
      supplier: 'Acme Grains',
      arrivedAt: new Date().toISOString(),
      items: [{ description: 'Placeholder', quantity: 0, unit: 'bags' }],
    }, admin._id, branch._id);

    const result = await stockIntakeService.getOne(intake._id, branch._id);
    assert.equal(result.reconciliation.rawTotal, 0);
    assert.equal(result.reconciliation.variancePct, null);
    assert.equal(result.reconciliation.highVariance, false);
  });

  test('mixed units are flagged as inconsistent', async () => {
    const intake = await stockIntakeService.create({
      supplier: 'Acme Grains',
      arrivedAt: new Date().toISOString(),
      items: [
        { description: 'Yellow maize', quantity: 50, unit: 'bags' },
        { description: 'Wheat', quantity: 30, unit: 'kg' },
      ],
    }, admin._id, branch._id);

    const result = await stockIntakeService.getOne(intake._id, branch._id);
    assert.equal(result.reconciliation.unitsConsistent, false);
  });

  test('list() also attaches reconciliation per record', async () => {
    await stockIntakeService.create({
      supplier: 'Acme Grains',
      arrivedAt: new Date().toISOString(),
      items: [{ description: 'Yellow maize', quantity: 40, unit: 'bags' }],
    }, admin._id, branch._id);

    const { records } = await stockIntakeService.list({}, {}, branch._id);
    assert.equal(records.length, 1);
    assert.ok(records[0].reconciliation);
    assert.equal(records[0].reconciliation.rawTotal, 40);
  });
});
