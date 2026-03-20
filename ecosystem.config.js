module.exports = {
  apps: [
    {
      name: 'grains-api',
      script: 'server.js',
      instances: 1, // increase to 'max' when scaling
      exec_mode: 'fork',
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
      // Auto-restart if memory exceeds 500MB
      max_memory_restart: '500M',
      // Restart delay
      restart_delay: 3000
    }
  ]
};
