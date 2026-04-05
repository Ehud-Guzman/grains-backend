const fs = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');
const { EJSON, ObjectId } = require('bson');
const { AppError } = require('../middleware/errorHandler.middleware');
const Branch = require('../models/Branch');
const User = require('../models/User');
const Settings = require('../models/Settings');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Payment = require('../models/Payment');
const StockLog = require('../models/StockLog');
const ActivityLog = require('../models/ActivityLog');
const OrderCounter = require('../models/OrderCounter');
const TokenBlacklist = require('../models/TokenBlacklist');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const LEGACY_BACKUP_DIR = path.join(BACKEND_ROOT, 'storage', 'backups');
const DEFAULT_BACKUP_DIR = path.join(REPO_ROOT, 'runtime-data', 'backups');
const BACKUP_DIR = path.resolve(
  process.env.BACKUP_STORAGE_DIR
    ? path.resolve(BACKEND_ROOT, process.env.BACKUP_STORAGE_DIR)
    : DEFAULT_BACKUP_DIR
);
const MANIFEST_PATH = path.join(BACKUP_DIR, 'manifest.json');
const RESTORE_MARKER = path.join(BACKUP_DIR, '.restore-in-progress');
const BACKUP_VERSION = 2;
const COLLECTIONS = [
  { key: 'branches', label: 'Branch', model: Branch },
  { key: 'users', label: 'User', model: User },
  { key: 'settings', label: 'Settings', model: Settings },
  { key: 'products', label: 'Product', model: Product },
  { key: 'orders', label: 'Order', model: Order },
  { key: 'payments', label: 'Payment', model: Payment },
  { key: 'stockLogs', label: 'StockLog', model: StockLog },
  { key: 'activityLogs', label: 'ActivityLog', model: ActivityLog },
  { key: 'orderCounters', label: 'OrderCounter', model: OrderCounter },
  { key: 'tokenBlacklists', label: 'TokenBlacklist', model: TokenBlacklist },
];

let storagePrepared = false;
let restoreInProgress = false;

const isRestoreInProgress = () => restoreInProgress;

const fileExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const migrateLegacyBackups = async () => {
  if (BACKUP_DIR === LEGACY_BACKUP_DIR) return;
  if (!(await fileExists(LEGACY_BACKUP_DIR))) return;

  const legacyEntries = await fs.readdir(LEGACY_BACKUP_DIR, { withFileTypes: true });
  for (const entry of legacyEntries) {
    if (!entry.isFile()) continue;

    const sourcePath = path.join(LEGACY_BACKUP_DIR, entry.name);
    const targetPath = path.join(BACKUP_DIR, entry.name);

    if (await fileExists(targetPath)) continue;
    await fs.rename(sourcePath, targetPath);
  }

  const remainingEntries = await fs.readdir(LEGACY_BACKUP_DIR);
  if (remainingEntries.length === 0) {
    await fs.rmdir(LEGACY_BACKUP_DIR);
  }
};

const ensureBackupDir = async () => {
  if (storagePrepared) return;
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  await migrateLegacyBackups();
  // Detect a crash mid-restore: if the marker file exists the previous restore
  // never finished and the database is likely incomplete.
  if (await fileExists(RESTORE_MARKER)) {
    console.error(
      '[backup] CRITICAL: .restore-in-progress marker found on startup. ' +
      'A previous restore was interrupted — the database may be empty or incomplete. ' +
      'Log in and restore from the most recent pre-restore backup immediately.'
    );
  }
  storagePrepared = true;
};

const safeIsoStamp = (date = new Date()) =>
  date.toISOString().replace(/[:.]/g, '-');

const calculateChecksum = (buffer) =>
  crypto.createHash('sha256').update(buffer).digest('hex');

const readManifest = async () => {
  await ensureBackupDir();
  try {
    const raw = await fs.readFile(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
};

const writeManifest = async (entries) => {
  await ensureBackupDir();
  const tempPath = `${MANIFEST_PATH}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(entries, null, 2), 'utf8');
  await fs.rename(tempPath, MANIFEST_PATH);
};

const buildSnapshot = async () => {
  const snapshotAt = new Date();
  const data = {};
  const counts = {};

  for (const { key, model } of COLLECTIONS) {
    const docs = await model.find({}).lean();
    data[key] = docs;
    counts[key] = docs.length;
  }

  return {
    meta: {
      version: BACKUP_VERSION,
      snapshotAt: snapshotAt.toISOString(),
      createdAt: snapshotAt.toISOString(),
      app: 'grains-system',
      format: 'json+gzip',
      collections: COLLECTIONS.map(({ key, label }) => ({
        key,
        model: label,
        count: counts[key] || 0,
      })),
      counts,
    },
    data,
  };
};

const getBackupById = async (backupId) => {
  const manifest = await readManifest();
  const entry = manifest.find((item) => item.id === backupId);

  if (!entry) {
    throw new AppError('Backup not found', 404, 'BACKUP_NOT_FOUND');
  }

  const absolutePath = path.join(BACKUP_DIR, entry.storageName);

  try {
    await fs.access(absolutePath);
  } catch {
    throw new AppError('Backup file is missing from storage', 404, 'BACKUP_FILE_MISSING');
  }

  return { entry, absolutePath, manifest };
};

const createBackup = async ({ actorId, actorRole }) => {
  const snapshot = await buildSnapshot();
  const jsonBuffer = Buffer.from(EJSON.stringify(snapshot, null, 2), 'utf8');
  const gzBuffer = await gzip(jsonBuffer, { level: zlib.constants.Z_BEST_COMPRESSION });
  const stamp = safeIsoStamp(new Date());
  const backupId = `backup_${stamp}_${crypto.randomBytes(4).toString('hex')}`;
  const storageName = `${backupId}.json.gz`;
  const absolutePath = path.join(BACKUP_DIR, storageName);

  await ensureBackupDir();
  await fs.writeFile(absolutePath, gzBuffer);

  const checksum = calculateChecksum(gzBuffer);
  const manifest = await readManifest();
  const entry = {
    id: backupId,
    storageName,
    filename: `grains-system-backup-${stamp}.json.gz`,
    createdAt: new Date().toISOString(),
    createdBy: actorId,
    actorRole,
    sizeBytes: gzBuffer.length,
    checksum,
    version: snapshot.meta.version,
    counts: snapshot.meta.counts,
  };

  manifest.unshift(entry);
  await writeManifest(manifest);

  return entry;
};

const listBackups = async () => {
  const manifest = await readManifest();
  const existing = [];

  for (const entry of manifest) {
    const absolutePath = path.join(BACKUP_DIR, entry.storageName);
    try {
      await fs.access(absolutePath);
      existing.push(entry);
    } catch {
      // Skip stale manifest entries if files were removed manually.
    }
  }

  if (existing.length !== manifest.length) {
    await writeManifest(existing);
  }

  return existing.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
};

const getBackupDownload = async (backupId) => {
  const { entry, absolutePath } = await getBackupById(backupId);
  const buffer = await fs.readFile(absolutePath);
  return { entry, buffer };
};

const deleteBackup = async (backupId) => {
  const { entry, absolutePath, manifest } = await getBackupById(backupId);

  await fs.unlink(absolutePath);
  await writeManifest(manifest.filter((item) => item.id !== backupId));

  return entry;
};

const OID_REGEX = /^[0-9a-f]{24}$/i;

// Recursively convert plain hex strings that look like ObjectIds back to ObjectId instances.
// Only touches fields named _id, *Id, or *Ids (arrays).
const hydrateValue = (key, val) => {
  if (typeof val === 'string' && OID_REGEX.test(val) && (key === '_id' || key.endsWith('Id'))) {
    return new ObjectId(val);
  }
  if (Array.isArray(val) && key.endsWith('Ids')) {
    return val.map(v => (typeof v === 'string' && OID_REGEX.test(v) ? new ObjectId(v) : v));
  }
  if (val && typeof val === 'object' && !Array.isArray(val)) return hydrateDoc(val);
  if (Array.isArray(val)) return val.map(v => (v && typeof v === 'object' ? hydrateDoc(v) : v));
  return val;
};

const hydrateDoc = (doc) => {
  if (!doc || typeof doc !== 'object') return doc;
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    out[k] = hydrateValue(k, v);
  }
  return out;
};

const decodeBackupBuffer = async (buffer, originalName = '') => {
  const lowerName = String(originalName || '').toLowerCase();
  let jsonBuffer = buffer;

  if (lowerName.endsWith('.gz')) {
    jsonBuffer = await gunzip(buffer);
  } else {
    try {
      jsonBuffer = await gunzip(buffer);
    } catch {
      jsonBuffer = buffer;
    }
  }

  let parsed;
  try {
    // EJSON.parse preserves MongoDB types (ObjectId, Date, etc.)
    // Falls back gracefully for v1 plain-JSON backups
    parsed = EJSON.parse(jsonBuffer.toString('utf8'));
  } catch {
    throw new AppError('Backup file is not valid JSON', 400, 'INVALID_BACKUP_FILE');
  }

  validateSnapshotShape(parsed);

  // v1 backups: ObjectIds were serialized as plain hex strings.
  // Walk each document and cast 24-hex-char strings in known ID fields back to ObjectId.
  if ((parsed.meta?.version ?? 1) < 2) {
    for (const { key } of COLLECTIONS) {
      parsed.data[key] = parsed.data[key].map(hydrateDoc);
    }
  }

  return parsed;
};

const validateSnapshotShape = (snapshot) => {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new AppError('Backup snapshot is malformed', 400, 'INVALID_BACKUP_FILE');
  }

  if (!snapshot.meta || !snapshot.data) {
    throw new AppError('Backup snapshot is missing meta/data sections', 400, 'INVALID_BACKUP_FILE');
  }

  for (const { key } of COLLECTIONS) {
    if (!Array.isArray(snapshot.data[key])) {
      throw new AppError(`Backup snapshot is missing the "${key}" collection`, 400, 'INVALID_BACKUP_FILE');
    }
  }
};

const validateRestoreRequest = ({ file, confirmation }) => {
  if (!file || !file.buffer) {
    throw new AppError('Backup file is required', 400, 'BACKUP_FILE_REQUIRED');
  }

  if (String(confirmation || '').trim() !== 'RESTORE') {
    throw new AppError('Type RESTORE to confirm this operation', 400, 'RESTORE_CONFIRMATION_REQUIRED');
  }
};

const restoreCollections = async (snapshot) => {
  // Phase 1 — clear everything first so we never end up with a mixed state
  // (half old data, half restored data) if an insert later fails.
  for (const { model } of COLLECTIONS) {
    await model.deleteMany({});
  }

  // Phase 2 — insert all collections.
  // ordered:false lets individual bad documents be skipped rather than aborting
  // the entire batch. A BulkWriteError is still thrown so we can report failures.
  const writeErrors = [];
  for (const { key, model } of COLLECTIONS) {
    const docs = snapshot.data[key];
    if (docs.length === 0) continue;
    try {
      await model.collection.insertMany(docs, { ordered: false });
    } catch (err) {
      if (err.name === 'MongoBulkWriteError') {
        const inserted = err.result?.insertedCount ?? 0;
        const failed = docs.length - inserted;
        if (failed > 0) writeErrors.push({ collection: key, inserted, failed, total: docs.length });
        // Partial inserts are acceptable; continue to the next collection.
      } else {
        // Unexpected driver/network error — abort and let the caller handle it.
        throw err;
      }
    }
  }

  return writeErrors;
};

const restoreBackup = async ({ file, confirmation, actorId, actorRole, ip }) => {
  validateRestoreRequest({ file, confirmation });

  const snapshot = await decodeBackupBuffer(file.buffer, file.originalname);
  const preRestoreBackup = await createBackup({ actorId, actorRole });

  // Signal all other requests to back off for the duration of the restore.
  restoreInProgress = true;
  // Write a marker file so a crash between Phase 1 and Phase 2 is detectable on restart.
  try { await fs.writeFile(RESTORE_MARKER, new Date().toISOString(), 'utf8'); } catch { /* non-fatal */ }

  let writeErrors = [];
  try {
    writeErrors = await restoreCollections(snapshot);
  } catch (err) {
    // All collections were cleared in Phase 1 but a critical insert error occurred.
    // Surface the pre-restore backup ID so the admin can recover immediately.
    throw new AppError(
      `Restore failed while inserting data (${err.message}). ` +
      `Your previous data was saved as backup "${preRestoreBackup.id}" — restore that to recover.`,
      500,
      'RESTORE_FAILED'
    );
  } finally {
    restoreInProgress = false;
    try { await fs.unlink(RESTORE_MARKER); } catch { /* already gone or never written */ }
  }

  if (writeErrors.length > 0) {
    console.warn(
      '[backup] Restore completed with partial write errors:',
      writeErrors.map(e => `${e.collection}: ${e.inserted}/${e.total} inserted`).join(', ')
    );
  }

  await ActivityLog.create({
    actorId,
    actorRole,
    action: 'SYSTEM_BACKUP_RESTORED',
    targetType: 'SystemBackup',
    branchId: null,
    detail: {
      restoredFromFile: file.originalname || 'uploaded-backup',
      backupSnapshotAt: snapshot.meta.snapshotAt || null,
      preRestoreBackupId: preRestoreBackup.id,
      restoredCollections: COLLECTIONS.map(({ key }) => ({
        key,
        count: snapshot.data[key].length,
      })),
      ...(writeErrors.length > 0 && { writeErrors }),
    },
    ip: ip || null,
    timestamp: new Date(),
  });

  return {
    restoredAt: new Date().toISOString(),
    restoredFromFile: file.originalname || 'uploaded-backup',
    backupSnapshotAt: snapshot.meta.snapshotAt || null,
    preRestoreBackup,
    counts: Object.fromEntries(
      COLLECTIONS.map(({ key }) => [key, snapshot.data[key].length])
    ),
    ...(writeErrors.length > 0 && { writeErrors }),
  };
};

const getBackupStorageSummary = async () => {
  const backups = await listBackups();
  const totalSizeBytes = backups.reduce((sum, item) => sum + (item.sizeBytes || 0), 0);

  return {
    backups,
    summary: {
      totalBackups: backups.length,
      totalSizeBytes,
      latestBackupAt: backups[0]?.createdAt || null,
    },
  };
};

module.exports = {
  BACKUP_DIR,
  isRestoreInProgress,
  createBackup,
  listBackups,
  getBackupDownload,
  deleteBackup,
  restoreBackup,
  getBackupStorageSummary,
};
