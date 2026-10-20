// 2026-10 audit F-09: backup and restore stream (flat memory), a bad file is rejected BEFORE anything is wiped,
// and backups taken by the old single-document format still restore.
process.env.NODE_ENV = 'test';
const path = require('path');
const os = require('os');
process.env.BACKUP_STORAGE_DIR = path.join(os.tmpdir(), `grains-backup-stream-${Date.now()}`);
process.env.BACKUP_ENCRYPTION_KEY = 'b'.repeat(64);

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const zlib = require('zlib');
const { EJSON } = require('bson');

const testDb = require('./helpers/testDb');
const { createBranch, createSettings, createUser, createProduct, cartItemFor, objectId } = require('./helpers/fixtures');
const backupService = require('../src/services/backup.service');
const orderService = require('../src/services/order.service');
const Branch = require('../src/models/Branch');
const Order = require('../src/models/Order');
const ActivityLog = require('../src/models/ActivityLog');
const User = require('../src/models/User');

before(async () => { await testDb.connect(); });
after(async () => {
  await testDb.disconnect();
  await fs.rm(process.env.BACKUP_STORAGE_DIR, { recursive: true, force: true });
});

const actor = () => ({ actorId: objectId(), actorRole: 'superadmin' });

describe('streamed backup + restore', () => {
  let branch; let admin; let product;
  beforeEach(async () => {
    await testDb.clearDatabase();
    branch = await createBranch();
    await createSettings(branch._id);
    admin = await createUser(branch._id, { role: 'admin' });
    product = await createProduct(branch._id, admin._id, { packaging: { stock: 500 } });
    for (let i = 0; i < 3; i++) {
      await orderService.createGuestOrder({
        name: `Guest ${i}`, phone: `07${50000000 + i}`, orderItems: [cartItemFor(product)],
        deliveryMethod: 'pickup', paymentMethod: 'pickup',
      }, branch._id);
    }
  });

  const download = async () => {
    const entry = await backupService.createBackup(actor());
    const { buffer } = await backupService.getBackupDownload(entry.id);
    return { entry, buffer };
  };

  test('a backup records per-collection counts and restores into an emptied database with types intact', async () => {
    const { entry, buffer } = await download();
    assert.equal(entry.counts.orders, 3);
    assert.equal(entry.version, 4);
    const before = await Order.findOne().sort({ orderRef: 1 }).lean();

    // wipe, then restore from the downloaded bytes
    await Order.deleteMany({}); await Branch.deleteMany({});
    const result = await backupService.restoreBackup({
      file: { buffer, originalname: 'x.ndjson.gz' }, confirmation: 'RESTORE', ...actor(), ip: '1.1.1.1',
    });
    assert.equal(result.counts.orders, 3);
    assert.equal(await Order.countDocuments(), 3);
    assert.equal(await Branch.countDocuments(), 1);
    const after = await Order.findOne().sort({ orderRef: 1 }).lean();
    assert.equal(String(after._id), String(before._id));
    assert.ok(after.createdAt instanceof Date, 'dates come back as Dates');
    assert.equal(String(after.branchId), String(branch._id), 'ObjectIds come back as ObjectIds');
    assert.equal(after.total, before.total);
    assert.ok(result.preRestoreBackup.id, 'a safety backup of the pre-restore state was taken');
  });

  test('a truncated file is refused and NOTHING is deleted', async () => {
    const { buffer } = await download();
    const raw = zlib.gunzipSync(buffer).toString('utf8').trimEnd().split('\n');
    const withoutEnd = zlib.gzipSync(raw.slice(0, -1).join('\n') + '\n');           // end marker missing
    await assert.rejects(
      backupService.restoreBackup({ file: { buffer: withoutEnd, originalname: 'cut.gz' }, confirmation: 'RESTORE', ...actor() }),
      (e) => e.errorCode === 'INVALID_BACKUP_FILE' && /incomplete/.test(e.message)
    );
    assert.equal(await Order.countDocuments(), 3, 'orders untouched');
    assert.equal(await Branch.countDocuments(), 1, 'branches untouched');

    const cutMidFile = buffer.subarray(0, Math.floor(buffer.length / 2));             // a broken .gz stream
    await assert.rejects(
      backupService.restoreBackup({ file: { buffer: cutMidFile, originalname: 'cut2.gz' }, confirmation: 'RESTORE', ...actor() }),
      (e) => e.errorCode === 'INVALID_BACKUP_FILE'
    );
    assert.equal(await Order.countDocuments(), 3);
  });

  test('a file whose counts disagree with its contents is refused', async () => {
    const { buffer } = await download();
    const lines = zlib.gunzipSync(buffer).toString('utf8').trimEnd().split('\n');
    const i = lines.findIndex((l) => l.includes('"c":"orders"'));
    lines.splice(i, 1);                                                                // drop one order line
    await assert.rejects(
      backupService.restoreBackup({ file: { buffer: zlib.gzipSync(lines.join('\n') + '\n'), originalname: 'x.gz' }, confirmation: 'RESTORE', ...actor() }),
      (e) => e.errorCode === 'INVALID_BACKUP_FILE' && /orders/.test(e.message)
    );
    assert.equal(await Order.countDocuments(), 3);
  });

  test('restore works across insert-batch boundaries (1,300 documents in one collection)', async () => {
    const logs = Array.from({ length: 1300 }, (_, i) => ({
      actorId: objectId(), actorRole: 'admin', action: 'TEST', targetType: 'Order', detail: { i }, timestamp: new Date(),
    }));
    await ActivityLog.collection.insertMany(logs);
    const { entry, buffer } = await download();
    assert.ok(entry.counts.activityLogs >= 1300);
    await ActivityLog.deleteMany({});
    await backupService.restoreBackup({ file: { buffer, originalname: 'big.gz' }, confirmation: 'RESTORE', ...actor() });
    assert.equal(await ActivityLog.countDocuments({ action: 'TEST' }), 1300);
  });

  test('an old single-document (format 3) backup still restores', async () => {
    const keys = ['branches', 'users', 'guests', 'settings', 'globalSettings', 'products', 'orders', 'payments', 'stockLogs',
      'stockIntakes', 'activityLogs', 'orderCounters', 'tokenBlacklists', 'coupons', 'promotions', 'savedLists', 'customerAlerts', 'priceLogs'];
    const legacy = {
      meta: { version: 3, snapshotAt: new Date().toISOString() },
      data: Object.fromEntries(keys.map((k) => [k, []])),
    };
    legacy.data.branches = [await Branch.findOne().lean()];
    const buffer = zlib.gzipSync(Buffer.from(EJSON.stringify(legacy), 'utf8'));
    await Order.deleteMany({});
    const result = await backupService.restoreBackup({ file: { buffer, originalname: 'old.json.gz' }, confirmation: 'RESTORE', ...actor() });
    assert.equal(result.counts.branches, 1);
    assert.equal(await Order.countDocuments(), 0, 'the old file had no orders, so none exist after restore');
  });

  test('a tampered encrypted backup fails to download instead of returning garbage', async () => {
    const entry = await backupService.createBackup(actor());
    const file = path.join(process.env.BACKUP_STORAGE_DIR, entry.storageName);
    const bytes = await fs.readFile(file);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    await fs.writeFile(file, bytes);
    await assert.rejects(backupService.getBackupDownload(entry.id), (e) => e.errorCode === 'BACKUP_DECRYPT_FAILED');
  });

  test('the confirmation word is still required', async () => {
    const { buffer } = await download();
    await assert.rejects(
      backupService.restoreBackup({ file: { buffer, originalname: 'x.gz' }, confirmation: 'yes', ...actor() }),
      (e) => e.errorCode === 'RESTORE_CONFIRMATION_REQUIRED'
    );
    assert.ok(await User.countDocuments() >= 1);
  });
});
