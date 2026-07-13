process.env.NODE_ENV = 'test';
// Use a throwaway path under the OS temp dir so this test never touches real backups.
const path = require('path');
const os = require('os');
process.env.BACKUP_STORAGE_DIR = path.join(os.tmpdir(), `grains-backup-test-${Date.now()}`);
process.env.BACKUP_ENCRYPTION_KEY = 'a'.repeat(64); // 32 bytes hex

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const zlib = require('zlib');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);

const testDb = require('./helpers/testDb');
const { createBranch, objectId } = require('./helpers/fixtures');

const backupService = require('../src/services/backup.service');

before(async () => { await testDb.connect(); });
after(async () => {
  await testDb.disconnect();
  await fs.rm(process.env.BACKUP_STORAGE_DIR, { recursive: true, force: true });
});

describe('backup.service — at-rest encryption', () => {
  beforeEach(async () => {
    await testDb.clearDatabase();
    await createBranch();
  });

  test('backup files on disk are not plaintext-parseable without the key', async () => {
    const entry = await backupService.createBackup({ actorId: objectId(), actorRole: 'superadmin' });
    assert.equal(entry.encrypted, true);
    assert.ok(entry.iv);
    assert.ok(entry.authTag);

    const raw = await fs.readFile(path.join(process.env.BACKUP_STORAGE_DIR, entry.storageName));
    await assert.rejects(
      gunzip(raw),
      'the on-disk bytes should not be valid gzip — proves it was actually encrypted, not just labelled as such'
    );
  });

  test('download decrypts and round-trips to valid gzip+EJSON', async () => {
    const entry = await backupService.createBackup({ actorId: objectId(), actorRole: 'superadmin' });
    const { buffer } = await backupService.getBackupDownload(entry.id);

    const jsonBuffer = await gunzip(buffer); // must not throw
    const parsed = JSON.parse(jsonBuffer.toString('utf8'));
    assert.ok(parsed.meta);
    assert.ok(parsed.data);
  });

  test('a pre-existing unencrypted backup (no `encrypted` field) still downloads correctly', async () => {
    // Simulate a backup created before this feature existed: write a plain
    // gzip file directly and a manifest entry with no `encrypted` key.
    await backupService.listBackups(); // ensures the backup dir + manifest exist
    const zlibSync = require('zlib');
    const legacyBuffer = zlibSync.gzipSync(Buffer.from(JSON.stringify({ meta: { version: 2 }, data: {} }), 'utf8'));
    const storageName = 'backup_legacy_test.json.gz';
    await fs.writeFile(path.join(process.env.BACKUP_STORAGE_DIR, storageName), legacyBuffer);

    const manifestPath = path.join(process.env.BACKUP_STORAGE_DIR, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.unshift({
      id: 'backup_legacy_test',
      storageName,
      filename: 'legacy.json.gz',
      createdAt: new Date().toISOString(),
      createdBy: objectId(),
      actorRole: 'superadmin',
      sizeBytes: legacyBuffer.length,
      checksum: 'irrelevant-for-this-test',
      version: 2,
      counts: {},
      // no `encrypted` field — matches every backup taken before this feature
    });
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const { buffer } = await backupService.getBackupDownload('backup_legacy_test');
    assert.deepEqual(buffer, legacyBuffer, 'unencrypted legacy backups must be returned byte-for-byte as-is');
  });
});
