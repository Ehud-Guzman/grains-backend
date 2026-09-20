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
    assert.equal(result.reconciliation.linked, true);
    assert.equal(result.reconciliation.linkedCount, 1);
    assert.equal(result.reconciliation.state, 'high_variance');
  });

  test('linked with variance inside the threshold reports state "ok"', async () => {
    const intake = await stockIntakeService.create({
      supplier: 'Acme Grains',
      arrivedAt: new Date().toISOString(),
      items: [{ description: 'Yellow maize', quantity: 100, unit: 'bags' }],
    }, admin._id, branch._id);

    const StockIntake = require('../src/models/StockIntake');
    await StockIntake.findByIdAndUpdate(intake._id, {
      $push: {
        linkedDeliveries: {
          productId: product._id, varietyName: 'Yellow', packagingSize: '50kg',
          quantity: 95, performedBy: admin._id, appliedAt: new Date(),
        },
      },
    });

    const result = await stockIntakeService.getOne(intake._id, branch._id);
    assert.equal(result.reconciliation.variancePct, 5);
    assert.equal(result.reconciliation.highVariance, false);
    assert.equal(result.reconciliation.state, 'ok');
  });

  // An unlinked intake is the NORMAL state for a freshly-logged truck: recording
  // an intake does not move sellable stock, so someone has to go to the stock
  // screen and pack it out first. This used to compute packedTotal = 0 →
  // variancePct = 100 → highVariance = true, so every new intake looked like a
  // 100% discrepancy and the genuine high-variance signal was drowned out.
  test('unlinked intake reports state "unlinked", not a 100% variance', async () => {
    const intake = await stockIntakeService.create({
      supplier: 'Acme Grains',
      arrivedAt: new Date().toISOString(),
      items: [{ description: 'Yellow maize', quantity: 50, unit: 'bags' }],
    }, admin._id, branch._id);

    const result = await stockIntakeService.getOne(intake._id, branch._id);
    assert.equal(result.reconciliation.rawTotal, 50);
    assert.equal(result.reconciliation.packedTotal, 0);
    assert.equal(result.reconciliation.linked, false);
    assert.equal(result.reconciliation.linkedCount, 0);
    assert.equal(result.reconciliation.state, 'unlinked');
    // No percentage is meaningful with nothing linked — and specifically no
    // divide-by-zero.
    assert.equal(result.reconciliation.variancePct, null);
    assert.equal(result.reconciliation.highVariance, false);
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
    // Nothing is linked, so 'unlinked' takes precedence over the unit mismatch —
    // the mismatch is still reported independently via unitsConsistent.
    assert.equal(result.reconciliation.state, 'unlinked');
  });

  // Precedence, stated explicitly: once deliveries ARE linked, a unit mismatch
  // makes any percentage misleading, so 'mixed_units' wins over the variance
  // verdict even when the raw numbers differ by a large margin.
  test('linked with mixed units reports state "mixed_units"', async () => {
    const intake = await stockIntakeService.create({
      supplier: 'Acme Grains',
      arrivedAt: new Date().toISOString(),
      items: [
        { description: 'Yellow maize', quantity: 50, unit: 'bags' },
        { description: 'Wheat', quantity: 30, unit: 'kg' },
      ],
    }, admin._id, branch._id);

    const StockIntake = require('../src/models/StockIntake');
    await StockIntake.findByIdAndUpdate(intake._id, {
      $push: {
        linkedDeliveries: {
          productId: product._id, varietyName: 'Yellow', packagingSize: '50kg',
          quantity: 10, performedBy: admin._id, appliedAt: new Date(),
        },
      },
    });

    const result = await stockIntakeService.getOne(intake._id, branch._id);
    assert.equal(result.reconciliation.unitsConsistent, false);
    assert.equal(result.reconciliation.linked, true);
    assert.equal(result.reconciliation.state, 'mixed_units');
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
