const crypto = require('crypto');
const { AppError } = require('../middleware/errorHandler.middleware');
const logger = require('../utils/logger');

// Backups and restores can run longer than the ~26 s Netlify's /api proxy waits for a response (a year of
// orders takes tens of seconds; a restore longer still), after which the browser sees a 504 while the work
// carries on - and the admin, told it failed, tries again (2026-10 audit, F-25). So the API can start them
// as a background job (`?async=true`), answer 202 at once, and let the page poll GET .../jobs/:id.
//
// Jobs live in this process's memory: they answer "is it still running, and how did it end?". Only one runs
// at a time (two restores at once would be a disaster). If the server restarts mid-job, the job id is gone;
// the backup list and the restore marker file are the source of truth after that.
const jobs = new Map();
const KEEP_FINISHED_MS = 60 * 60 * 1000;

const prune = () => {
  const cutoff = Date.now() - KEEP_FINISHED_MS;
  for (const [id, job] of jobs) {
    if (job.finishedAt && job.finishedAt.getTime() < cutoff) jobs.delete(id);
  }
};

const runningJob = () => [...jobs.values()].find((j) => j.state === 'running');

const publicView = (job) => ({
  id: job.id,
  kind: job.kind,
  state: job.state,
  progress: job.progress,
  startedAt: job.startedAt,
  finishedAt: job.finishedAt || null,
  result: job.state === 'done' ? job.result : null,
  error: job.state === 'failed' ? job.error : null,
});

/** Start `task(report)` in the background. `report(progress)` records what it is doing right now. */
const startJob = (kind, task) => {
  prune();
  const busy = runningJob();
  if (busy) {
    throw new AppError(`A ${busy.kind} is already running. Wait for it to finish.`, 409, 'BACKUP_JOB_RUNNING');
  }
  const job = {
    id: crypto.randomBytes(8).toString('hex'), kind, state: 'running', progress: { phase: 'starting' },
    startedAt: new Date(), finishedAt: null, result: null, error: null,
  };
  jobs.set(job.id, job);

  Promise.resolve()
    .then(() => task((progress) => { job.progress = { ...job.progress, ...progress }; }))
    .then((result) => { job.state = 'done'; job.result = result; })
    .catch((err) => {
      job.state = 'failed';
      job.error = { message: err.message, code: err.errorCode || 'JOB_FAILED' };
      logger.error(`[backup-job] ${kind} failed`, { err: err.message });
    })
    .finally(() => { job.finishedAt = new Date(); });

  return publicView(job);
};

const getJob = (id) => {
  const job = jobs.get(id);
  if (!job) {
    throw new AppError('That job is no longer known (the server may have restarted). Check the backup list.', 404, 'JOB_NOT_FOUND');
  }
  return publicView(job);
};

module.exports = { startJob, getJob, runningJob: () => (runningJob() ? publicView(runningJob()) : null) };
