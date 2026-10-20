// 2026-10 audit F-12 / F-23: behaviour that matters the day the API runs as more than one process
// (Render scale-out, PM2 cluster): settings must not stay stale, jobs must not run twice, daily jobs must run
// once a day however often the server restarts, and rate-limit counters must be shareable.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const testDb = require('./helpers/testDb');
const { createBranch, createSettings } = require('./helpers/fixtures');
const Settings = require('../src/models/Settings');
const JobState = require('../src/models/JobState');
const settingsService = require('../src/services/settings.service');
const jobControl = require('../src/services/jobControl.service');
const { MongoRateLimitStore } = require('../src/utils/mongoRateLimitStore');

before(async () => { await testDb.connect(); });
after(async () => { await testDb.disconnect(); });
beforeEach(async () => { await testDb.clearDatabase(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('settings cache expiry', () => {
  test('a change made by ANOTHER process (no invalidateCache here) is picked up after the TTL', async () => {
    process.env.SETTINGS_CACHE_TTL_MS = '600';
    try {
      const branch = await createBranch();
      await createSettings(branch._id, { deliveryFee: 100 });
      settingsService.invalidateCache(branch._id);
      assert.equal((await settingsService.getSettings(branch._id)).deliveryFee, 100);

      // "Another instance" saves straight to the database: this process's cache is not told.
      await Settings.updateOne({ branchId: branch._id }, { deliveryFee: 777, platformLocked: true });
      assert.equal((await settingsService.getSettings(branch._id)).deliveryFee, 100, 'still cached inside the TTL');

      await sleep(700);
      const fresh = await settingsService.getSettings(branch._id);
      assert.equal(fresh.deliveryFee, 777);
      assert.equal(fresh.platformLocked, true, 'a platform lock saved elsewhere takes effect here within the TTL');
    } finally {
      delete process.env.SETTINGS_CACHE_TTL_MS;
    }
  });

  test('if the database blips, the last known settings are served instead of an error', async () => {
    process.env.SETTINGS_CACHE_TTL_MS = '1';
    try {
      const branch = await createBranch();
      await createSettings(branch._id);
      settingsService.invalidateCache(branch._id);
      const first = await settingsService.getSettings(branch._id);
      await sleep(10);
      const orig = Settings.findById;
      Settings.findById = () => { throw new Error('db blip'); };
      try {
        assert.equal((await settingsService.getSettings(branch._id)).shopName, first.shopName);
      } finally { Settings.findById = orig; }
    } finally {
      delete process.env.SETTINGS_CACHE_TTL_MS;
    }
  });
});

describe('job leases and daily keys', () => {
  test('two simultaneous runs of one job: exactly one executes', async () => {
    let ran = 0;
    const work = async () => { ran += 1; await sleep(20); };
    await Promise.all([jobControl.runGuarded('auto-cancel', work), jobControl.runGuarded('auto-cancel', work)]);
    assert.equal(ran, 1);
  });

  test('the lease holds until its minimum gap passes, and a failed run releases it for an immediate retry', async () => {
    let ran = 0;
    await jobControl.runGuarded('mpesa-reconcile', async () => { ran += 1; });
    await jobControl.runGuarded('mpesa-reconcile', async () => { ran += 1; });
    assert.equal(ran, 1, 'a second tick inside the gap is skipped');

    await JobState.updateOne({ _id: 'mpesa-reconcile' }, { leaseUntil: new Date(0) });
    await jobControl.runGuarded('mpesa-reconcile', async () => { ran += 1; throw new Error('boom'); });
    assert.equal(ran, 2);
    await jobControl.runGuarded('mpesa-reconcile', async () => { ran += 1; });
    assert.equal(ran, 3, 'the failed run gave the lease back');
  });

  test('dailyKeyFor: not due before the hour in Nairobi, the Nairobi date after it', () => {
    // 2026-10-18 02:30 UTC = 05:30 EAT -> not due for 06:00
    assert.equal(jobControl.dailyKeyFor(6, new Date('2026-10-18T02:30:00Z')), null);
    // 2026-10-18 03:10 UTC = 06:10 EAT -> due, keyed to 18 Oct
    assert.equal(jobControl.dailyKeyFor(6, new Date('2026-10-18T03:10:00Z')), '2026-10-18');
    // 2026-10-18 21:30 UTC = 00:30 EAT on the 19th -> belongs to the 19th (and is before 06:00)
    assert.equal(jobControl.dailyKeyFor(6, new Date('2026-10-18T21:30:00Z')), null);
    assert.equal(jobControl.dailyKeyFor(0, new Date('2026-10-18T21:30:00Z')), '2026-10-19');
  });

  test('a daily job runs once per key however many times it is triggered (restarts, second instance)', async () => {
    let ran = 0;
    const work = async () => { ran += 1; };
    await jobControl.runGuarded('daily-sales-report', work, { key: '2026-10-18' });
    await JobState.updateOne({ _id: 'daily-sales-report' }, { leaseUntil: new Date(0) });
    await jobControl.runGuarded('daily-sales-report', work, { key: '2026-10-18' });
    assert.equal(ran, 1, 'already done for that date');
    await JobState.updateOne({ _id: 'daily-sales-report' }, { leaseUntil: new Date(0) });
    await jobControl.runGuarded('daily-sales-report', work, { key: '2026-10-19' });
    assert.equal(ran, 2, 'the next day runs again');
  });
});

describe('Mongo-backed rate-limit store', () => {
  test('counts atomically across concurrent callers and restarts the window when it expires', async () => {
    const store = new MongoRateLimitStore('t');
    store.init({ windowMs: 150 });
    const hits = await Promise.all(Array.from({ length: 20 }, () => store.increment('ip-1')));
    assert.deepEqual(hits.map((h) => h.totalHits).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.equal((await store.increment('ip-2')).totalHits, 1, 'keys are independent');

    await sleep(200);
    assert.equal((await store.increment('ip-1')).totalHits, 1, 'new window');

    await store.decrement('ip-1');
    assert.equal((await store.increment('ip-1')).totalHits, 1);
    await store.resetKey('ip-1');
    assert.equal((await store.increment('ip-1')).totalHits, 1);
  });

  test('stores of different limiters do not share counters', async () => {
    const a = new MongoRateLimitStore('login'); a.init({ windowMs: 60000 });
    const b = new MongoRateLimitStore('anon'); b.init({ windowMs: 60000 });
    await a.increment('same'); await a.increment('same');
    assert.equal((await b.increment('same')).totalHits, 1);
  });
});
