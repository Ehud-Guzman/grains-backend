// 2026-10 audit F-25: backup and restore as background jobs (202 + poll) so the Netlify proxy's ~26 s cap
// cannot turn a long operation into a 504, plus streamed download and disk-backed restore upload.
process.env.NODE_ENV = 'test';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://grains-fronten.netlify.app';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';
const path = require('path');
const os = require('os');
process.env.BACKUP_STORAGE_DIR = path.join(os.tmpdir(), `grains-backup-api-${Date.now()}`);

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const zlib = require('zlib');
const jwt = require('jsonwebtoken');

const testDb = require('./helpers/testDb');
const { createBranch, createSettings, createUser } = require('./helpers/fixtures');
const app = require('../src/app');
const backupJobs = require('../src/services/backupJobs');
const Branch = require('../src/models/Branch');

let server; let baseUrl; let token;
before(async () => {
  await testDb.connect();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testDb.disconnect();
  await fs.rm(process.env.BACKUP_STORAGE_DIR, { recursive: true, force: true });
});
beforeEach(async () => {
  await testDb.clearDatabase();
  const branch = await createBranch();
  await createSettings(branch._id);
  const sa = await createUser(null, { role: 'superadmin', branchId: null, tokenValidAfter: new Date(Date.now() - 3600000) });
  token = jwt.sign({ id: String(sa._id), role: 'superadmin', branchId: null }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
});

const api = (method, url, body, headers = {}) => fetch(`${baseUrl}/api/admin/backups${url}`, {
  method, headers: { Authorization: `Bearer ${token}`, ...headers }, body,
});
const waitForJob = async (id) => {
  for (let i = 0; i < 800; i++) {
    const job = (await (await api('GET', `/jobs/${id}`)).json()).data;
    if (job.state !== 'running') return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('job did not finish');
};

describe('backup API', () => {
  test('async create answers 202 immediately and the job completes with the backup entry', async () => {
    const res = await api('POST', '?async=true');
    assert.equal(res.status, 202);
    const started = (await res.json()).data;
    assert.ok(started.id && ['running', 'done'].includes(started.state));
    const done = await waitForJob(started.id);
    assert.equal(done.state, 'done');
    assert.ok(done.result.id.startsWith('backup_'));
    const list = (await (await api('GET', '')).json()).data;
    assert.equal(list.summary.totalBackups, 1);
  });

  test('the plain (non-async) create still answers 201 with the entry', async () => {
    const res = await api('POST', '');
    assert.equal(res.status, 201);
    assert.ok((await res.json()).data.id);
  });

  test('download streams the decrypted gzip file', async () => {
    const created = (await (await api('POST', '')).json()).data;
    const res = await api('GET', `/${created.id}/download`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/gzip');
    const bytes = Buffer.from(await res.arrayBuffer());
    const first = JSON.parse(zlib.gunzipSync(bytes).toString('utf8').split('\n')[0]);
    assert.equal(first.t, 'meta');
  });

  test('async restore from an uploaded file: 202, completes, the data is back, the temp upload is removed', async () => {
    const created = (await (await api('POST', '')).json()).data;
    const bytes = Buffer.from(await (await api('GET', `/${created.id}/download`)).arrayBuffer());
    await Branch.deleteMany({});

    const before = new Set(await fs.readdir(os.tmpdir()));
    const form = new FormData();
    form.append('confirmation', 'RESTORE');
    form.append('backup', new Blob([bytes]), 'backup.ndjson.gz');
    const res = await api('POST', '/restore?async=true', form);
    assert.equal(res.status, 202);
    const done = await waitForJob((await res.json()).data.id);
    assert.equal(done.state, 'done', JSON.stringify(done.error));
    assert.equal(await Branch.countDocuments(), 1);
    const leftovers = (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith('grains-restore-') && !before.has(f));
    assert.deepEqual(leftovers, [], 'the uploaded temp file is deleted');
  });

  test('a bad restore file fails the job with a clear error and changes nothing', async () => {
    const form = new FormData();
    form.append('confirmation', 'RESTORE');
    form.append('backup', new Blob([zlib.gzipSync('{"t":"meta","v":4}\n')]), 'bad.gz');   // no end marker
    const res = await api('POST', '/restore?async=true', form);
    const done = await waitForJob((await res.json()).data.id);
    assert.equal(done.state, 'failed');
    assert.equal(done.error.code, 'INVALID_BACKUP_FILE');
    assert.equal(await Branch.countDocuments(), 1);
  });

  test('only one job at a time, and unknown ids are a clean 404', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    backupJobs.startJob('backup', () => gate);
    const res = await api('POST', '?async=true');
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'BACKUP_JOB_RUNNING');
    release();
    await new Promise((r) => setTimeout(r, 20));
    const missing = await api('GET', '/jobs/deadbeef');
    assert.equal(missing.status, 404);
  });
});
