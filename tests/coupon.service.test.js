const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const testDb = require('./helpers/testDb');
const { createBranch, createUser, objectId } = require('./helpers/fixtures');

const couponService = require('../src/services/coupon.service');
const Coupon = require('../src/models/Coupon');

before(async () => { await testDb.connect(); });
after(async () => { await testDb.disconnect(); });

describe('coupon.service — validate', () => {
  let branch, admin;

  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
    admin = await createUser(branch._id, { role: 'admin' });
  });

  test('computes a percentage discount correctly', async () => {
    await Coupon.create({ code: 'TEN', discountType: 'percentage', discountValue: 10, branchId: branch._id, createdBy: admin._id });
    const { discountAmount } = await couponService.validate('TEN', branch._id, null, 1000);
    assert.equal(discountAmount, 100);
  });

  test('computes a fixed discount, capped at the subtotal', async () => {
    await Coupon.create({ code: 'FIXED500', discountType: 'fixed', discountValue: 500, branchId: branch._id, createdBy: admin._id });
    const { discountAmount } = await couponService.validate('FIXED500', branch._id, null, 300);
    assert.equal(discountAmount, 300, 'discount should never exceed the order subtotal');
  });

  test('rejects an expired coupon', async () => {
    await Coupon.create({
      code: 'OLD', discountType: 'fixed', discountValue: 100, branchId: branch._id, createdBy: admin._id,
      expiresAt: new Date(Date.now() - 86400000),
    });
    await assert.rejects(
      couponService.validate('OLD', branch._id, null, 1000),
      (err) => err.errorCode === 'COUPON_EXPIRED'
    );
  });

  test('rejects a coupon that has hit its usage limit', async () => {
    await Coupon.create({
      code: 'MAXED', discountType: 'fixed', discountValue: 100, branchId: branch._id, createdBy: admin._id,
      usageLimit: 1, usedCount: 1,
    });
    await assert.rejects(
      couponService.validate('MAXED', branch._id, null, 1000),
      (err) => err.errorCode === 'COUPON_EXHAUSTED'
    );
  });

  test('rejects a coupon assigned to a different customer', async () => {
    const owner = await createUser(branch._id, { role: 'customer', branchId: null });
    const someoneElse = await createUser(branch._id, { role: 'customer', branchId: null });
    await Coupon.create({
      code: 'JUST4YOU', discountType: 'fixed', discountValue: 100, branchId: branch._id, createdBy: admin._id,
      assignedTo: owner._id,
    });
    await assert.rejects(
      couponService.validate('JUST4YOU', branch._id, someoneElse._id, 1000),
      (err) => err.errorCode === 'COUPON_NOT_YOURS'
    );
  });

  test('rejects when the subtotal is below the minimum order value', async () => {
    await Coupon.create({
      code: 'BIGSPEND', discountType: 'fixed', discountValue: 100, branchId: branch._id, createdBy: admin._id,
      minOrderValue: 5000,
    });
    await assert.rejects(
      couponService.validate('BIGSPEND', branch._id, null, 1000),
      (err) => err.errorCode === 'COUPON_MIN_NOT_MET'
    );
  });
});

describe('coupon.service — incrementUsage / releaseUsage', () => {
  let branch, admin, coupon;

  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
    admin = await createUser(branch._id, { role: 'admin' });
    coupon = await Coupon.create({
      code: 'RACE', discountType: 'fixed', discountValue: 50, branchId: branch._id, createdBy: admin._id,
      usageLimit: 1, usedCount: 0,
    });
  });

  test('two concurrent increments on a single-use coupon: only one wins', async () => {
    const results = await Promise.allSettled([
      couponService.incrementUsage('RACE', branch._id, null),
      couponService.incrementUsage('RACE', branch._id, null),
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.errorCode, 'COUPON_EXHAUSTED');

    const refreshed = await Coupon.findById(coupon._id).lean();
    assert.equal(refreshed.usedCount, 1);
  });

  test('releaseUsage decrements but never goes below zero', async () => {
    await couponService.releaseUsage('RACE', branch._id, null);
    let refreshed = await Coupon.findById(coupon._id).lean();
    assert.equal(refreshed.usedCount, 0, 'usedCount was already 0, must not go negative');

    await couponService.incrementUsage('RACE', branch._id, null);
    await couponService.releaseUsage('RACE', branch._id, null);
    refreshed = await Coupon.findById(coupon._id).lean();
    assert.equal(refreshed.usedCount, 0);
  });

  test('releaseUsage on a deleted coupon is a silent no-op', async () => {
    await Coupon.findByIdAndDelete(coupon._id);
    await assert.doesNotReject(couponService.releaseUsage('RACE', branch._id, null));
  });
});
