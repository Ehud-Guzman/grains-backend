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
