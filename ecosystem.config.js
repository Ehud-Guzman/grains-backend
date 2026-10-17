module.exports = {
  apps: [
    {
      name: 'grains-api',
      script: 'server.js',
      // 'max' spawns one worker per CPU core. On a single-core host (Render
      // free/starter) this resolves to 1 — no change. On a 2+ core VPS you
      // get true parallelism with zero code changes.
      // isRestoreInProgress() in backup.service.js is cluster-safe: it polls
      // the RESTORE_MARKER file so all workers see an in-progress restore.
      // CONSTRAINT: on a multi-core host 'max' already breaks the rate limits. The default
      // express-rate-limit store is per-process, so N workers multiply every limit by N
      // (AUTH_MAX 10 -> 10*N logins/min) and the alert counters split. Pin this to 1 there,
      // or give the limiters a shared store (Redis/Mongo) first.
      instances: 'max',
      exec_mode: 'cluster',
      watch: false,
      env: {
        NODE_ENV: 'development',
        PORT: 5000
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 5000
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_file: './logs/combined.log',
      time: true,
      max_memory_restart: '500M',
      restart_delay: 3000
    }
  ]
};
