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

const GlobalSettings = require('../models/GlobalSettings');
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
    description: 'Cancels pending orders older than each branch’s auto-cancel hours and returns their stock.',
    pauseEffect: 'Unapproved orders stay pending (and keep their stock reserved) until someone acts on them.',
  },
  {
    name: 'low-stock-digest',
    label: 'Low-stock digest',
    schedule: 'Daily',
    description: 'Emails each branch’s admins the products that are running low.',
    pauseEffect: 'No low-stock emails are sent. The Alerts page still shows the same information.',
  },
  {
    name: 'daily-sales-report',
    label: 'Daily sales report',
    schedule: 'Daily',
    description: 'Emails yesterday’s sales summary for branches that switched it on.',
    pauseEffect: 'No daily sales emails are sent.',
  },
  {
    name: 'etims-retry',
    label: 'eTIMS retry',
    schedule: 'Every 30 minutes',
    description: 'Re-submits fiscal invoices KRA rejected or could not be reached for (up to 7 days old).',
    pauseEffect: 'Failed eTIMS invoices stay failed until someone resubmits them by hand.',
  },
  {
    name: 'cleanup',
    label: 'Log and guest cleanup',
    schedule: 'Daily',
    description: 'Deletes activity-log entries past each branch’s retention and guest records that never ordered.',
    pauseEffect: 'Nothing is deleted. Safe to pause, e.g. while investigating something in the activity log.',
  },
];

const JOB_NAMES = JOBS.map(j => j.name);

const lastRuns = new Map(); // name => { startedAt, finishedAt, durationMs, outcome, error }

const readPaused = async () => {
  const doc = await GlobalSettings.findById('global').select('pausedJobs').lean();
  return doc?.pausedJobs || [];
};

const isPaused = async (name) => (await readPaused()).includes(name);

// Runs `fn` unless the job is paused. Never throws — a job failure must not
// crash the process (the same contract the jobs already had) — and a failure to
// read the pause list fails open, so a database hiccup can't silently stop jobs.
const runGuarded = async (name, fn) => {
  const startedAt = new Date();
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

  try {
    await fn();
    const finishedAt = new Date();
    lastRuns.set(name, { startedAt, finishedAt, durationMs: finishedAt - startedAt, outcome: 'ok', error: null });
  } catch (err) {
    const finishedAt = new Date();
    lastRuns.set(name, { startedAt, finishedAt, durationMs: finishedAt - startedAt, outcome: 'failed', error: err.message });
    logger.error(`[JOBS] ${name} failed`, { err: err.message });
  }
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

module.exports = { JOBS, JOB_NAMES, runGuarded, listJobs, setPaused, isPaused };
