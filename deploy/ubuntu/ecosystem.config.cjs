module.exports = {
  apps: [
    {
      name: 'cmhub-cloud-api',
      cwd: '/opt/cmhub-api/services/cloud-api',
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '400M',
      exp_backoff_restart_delay: 100,
      time: true,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
