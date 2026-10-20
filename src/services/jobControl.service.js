// ── JOB CONTROL ───────────────────────────────────────────────────────────────
// The background jobs (src/jobs/*) each schedule themselves with setTimeout /
// setInterval. This service gives the superadmin two things over them without
// touching their schedules: a pause switch and a last-run record.
//
// Every job routes its run through runGuarded(name, fn):
//   • if the job is paused, the run is skipped (and recorded as skipped);
//   • otherwise fn runs and its outcome is recorded.
//
// The pause list lives in GlobalSettings.pausedJobs and is read from the DB on
// every run (jobs fire at most every few minutes, so one tiny read is free) —
// not from globalSettings.service's in-process cache — so a pause set on one PM2
// worker holds on all of them and survives a restart.
//
// Run records are in memory: they answer "is it running, and did the last run
// fail?" since the last restart, which is what the Control Center needs.

const crypto = require('crypto');
const GlobalSettings = require('../models/GlobalSettings');
const JobState = require('../models/JobState');
const { EAT_OFFSET_MS } = require('../utils/businessTime');
const globalSettingsService = require('./globalSettings.service');
const { AppError } = require('../middleware/errorHandler.middleware');
const logger = require('../utils/logger');

// keep-alive is deliberately absent: pausing it would let the host spin the server
// down, which is an outage rather than a control.
const JOBS = [
  {
    name: 'auto-cancel',
    label: 'Auto-cancel stale orders',
    schedule: 'Every 5 minutes',
    minGapMs: 4 * 60 * 1000,
    description: 'Cancels pending orders older than each branch’s auto-cancel hours and returns their stock.',
    pauseEffect: 'Unapproved orders stay pending (and keep their stock reserved) until someone acts on them.',
  },
  {
    name: 'low-stock-digest',
    label: 'Low-stock digest',
    schedule: 'Daily at 07:00 Nairobi time',
    dailyAtHourEAT: 7,
    minGapMs: 60 * 1000,
    description: 'Emails each branch’s admins the products that are running low.',
    pauseEffect: 'No low-stock emails are sent. The Alerts page still shows the same information.',
  },
  {
    name: 'daily-sales-report',
    label: 'Daily sales report',
    schedule: 'Daily at 06:00 Nairobi time',
    dailyAtHourEAT: 6,
    minGapMs: 60 * 1000,
    description: 'Emails yesterday’s sales summary for branches that switched it on.',
    pauseEffect: 'No daily sales emails are sent.',
  },
  {
    name: 'mpesa-reconcile',
    label: 'M-Pesa payment check',
    schedule: 'Every 2 minutes',
    minGapMs: 90 * 1000,
    description: 'Asks Safaricom about M-Pesa prompts still unresolved after 3 minutes (a lost callback) and confirms or fails them.',
    pauseEffect: 'A payment whose callback never arrives stays pending until staff confirm it by hand from the cash-up report.',
  },
  {
    name: 'etims-retry',
    label: 'eTIMS retry',
    schedule: 'Every 30 minutes',
    minGapMs: 25 * 60 * 1000,
    description: 'Re-submits fiscal invoices KRA rejected or could not be reached for (up to 7 days old).',
    pauseEffect: 'Failed eTIMS invoices stay failed until someone resubmits them by hand.',
  },
  {
    name: 'cleanup',
    label: 'Log and guest cleanup',
    schedule: 'Daily at 03:00 Nairobi time',
    dailyAtHourEAT: 3,
    minGapMs: 60 * 1000,
    description: 'Deletes activity-log entries past each branch’s retention and guest records that never ordered.',
    pauseEffect: 'Nothing is deleted. Safe to pause, e.g. while investigating something in the activity log.',
  },
];

const JOB_NAMES = JOBS.map(j => j.name);

const lastRuns = new Map(); // name => { startedAt, finishedAt, durationMs, outcome, error }

// ── LEADER LEASE + DAILY KEY ──────────────────────────────────────────────────
// Every server process schedules every job. With one process that is fine; with two (Render scale-out, PM2
// cluster) both would run each job - duplicate emails, duplicate work. So a run first takes a short lease in
// the database (JobState): only the instance that gets it runs, the others skip that tick. The lease lasts
// `minGapMs` (a little under the job's interval), so the next tick can be won by either instance. Daily jobs
// also carry a key (today's Nairobi date) that is stored when they finish, so they run once per day however
// often the server restarts, and still run late if the server was asleep at the scheduled hour (2026-10
// audit, F-12/F-23).
const INSTANCE_ID = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

const acquireLease = async (name, leaseMs) => {
  const now = new Date();
  try {
    const doc = await JobState.findOneAndUpdate(
      { _id: name, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] },
      { $set: { holder: INSTANCE_ID, leaseUntil: new Date(now.getTime() + leaseMs) } },
      { upsert: true, new: true }
    );
    return !!doc;
  } catch (err) {
    if (err.code === 11000) return false; // someone else holds a live lease
    throw err;
  }
};

const releaseLease = (name) =>
  JobState.updateOne({ _id: name, holder: INSTANCE_ID }, { $set: { leaseUntil: new Date(0) } }).catch(() => {});

// Today's Nairobi calendar date once it is past `hourEAT`, else null (not due yet).
const dailyKeyFor = (hourEAT, now = new Date()) => {
  const eat = new Date(now.getTime() + EAT_OFFSET_MS);
  if (eat.getUTCHours() < hourEAT) return null;
  return eat.toISOString().slice(0, 10);
};

const readPaused = async () => {
  const doc = await GlobalSettings.findById('global').select('pausedJobs').lean();
  return doc?.pausedJobs || [];
};

const isPaused = async (name) => (await readPaused()).includes(name);

// Runs `fn` unless the job is paused. Never throws — a job failure must not
// crash the process (the same contract the jobs already had) — and a failure to
// read the pause list fails open, so a database hiccup can't silently stop jobs.
const runGuarded = async (name, fn, { key = null } = {}) => {
  const startedAt = new Date();
  const def = JOBS.find(j => j.name === name);
  let paused = false;
  try {
    paused = await isPaused(name);
  } catch (err) {
    logger.warn('[JOBS] Could not read the pause list — running anyway', { job: name, err: err.message });
  }

  if (paused) {
    lastRuns.set(name, { startedAt, finishedAt: startedAt, durationMs: 0, outcome: 'skipped', error: null });
    logger.info(`[JOBS] ${name} is paused — skipping this run`);
    return;
  }

  // Daily job already done for this date (by this or another instance, before a restart...): nothing to do,
  // and not worth a "skipped" entry on every poll.
  if (key) {
    try {
      const state = await JobState.findById(name).select('lastKey').lean();
      if (state?.lastKey === key) return;
    } catch (err) {
      logger.warn('[JOBS] Could not read the daily job state - running anyway', { job: name, err: err.message });
    }
  }

  // Take the lease (fail open: a database hiccup must not silently stop the jobs).
  let leased = true;
  try {
    leased = await acquireLease(name, def?.minGapMs || 60 * 1000);
  } catch (err) {
    logger.warn('[JOBS] Could not take the job lease - running anyway', { job: name, err: err.message });
  }
  if (!leased) {
    logger.info(`[JOBS] ${name}: another instance is running it - skipping this tick`);
    return;
  }

  try {
    await fn();
    const finishedAt = new Date();
    lastRuns.set(name, { startedAt, finishedAt, durationMs: finishedAt - startedAt, outcome: 'ok', error: null });
    if (key) await JobState.updateOne({ _id: name }, { $set: { lastKey: key, lastRunAt: finishedAt } }, { upsert: true }).catch(() => {});
  } catch (err) {
    const finishedAt = new Date();
    lastRuns.set(name, { startedAt, finishedAt, durationMs: finishedAt - startedAt, outcome: 'failed', error: err.message });
    logger.error(`[JOBS] ${name} failed`, { err: err.message });
    await releaseLease(name); // let the next tick (any instance) retry instead of waiting out the lease
  }
};

// Run `fn` once per Nairobi day, as soon as it is `hourEAT` or later - checked on every tick of the poller.
const runDaily = (name, hourEAT, fn) => {
  const key = dailyKeyFor(hourEAT);
  if (!key) return Promise.resolve();
  return runGuarded(name, fn, { key });
};

const listJobs = async () => {
  const paused = await readPaused();
  return JOBS.map(job => ({
    ...job,
    paused: paused.includes(job.name),
    lastRun: lastRuns.get(job.name) || null,
  }));
};

// Returns the new pause list.
const setPaused = async (name, shouldPause) => {
  if (!JOB_NAMES.includes(name)) {
    throw new AppError(`Unknown job. Must be one of: ${JOB_NAMES.join(', ')}`, 400, 'UNKNOWN_JOB');
  }
  const current = await readPaused();
  const next = shouldPause
    ? [...new Set([...current, name])]
    : current.filter(n => n !== name);
  await globalSettingsService.updateSettings({ pausedJobs: next });
  return next;
};

module.exports = { JOBS, JOB_NAMES, runGuarded, runDaily, dailyKeyFor, listJobs, setPaused, isPaused };
