// PM2 configuration file
module.exports = {
  apps: [{
    name: 'otedama-pool',
    script: './dist/main.js',
    instances: 1,
    exec_mode: 'fork',
    
    // Environment variables
    env: {
      NODE_ENV: 'production'
    },
    
    // Logging
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_file: './logs/pm2-combined.log',
    time: true,
    
    // Advanced features
    max_memory_restart: '2G',
    min_uptime: '10s',
    max_restarts: 10,
    
    // Graceful shutdown
    kill_timeout: 30000,
    wait_ready: true,
    listen_timeout: 10000,
    
    // Monitoring
    instance_var: 'INSTANCE_ID',
    
    // Auto restart
    autorestart: true,
    watch: false,
    
    // Cron restart (daily at 4 AM)
    cron_restart: '0 4 * * *'
  }]
};
