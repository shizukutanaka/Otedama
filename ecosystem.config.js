module.exports = {
  apps: [
    {
      name: 'otedama-mining-pool',
      script: 'index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '2G',
      env: {
        NODE_ENV: 'production',
        PORT: 4444,
        STRATUM_PORT: 3333
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 4444,
        STRATUM_PORT: 3333,
        DB_HOST: 'localhost',
        DB_PORT: 5432,
        DB_NAME: 'otedama_mining',
        DB_USER: 'otedama_user',
        LOG_LEVEL: 'info'
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 4444,
        STRATUM_PORT: 3333,
        DB_HOST: 'localhost',
        DB_PORT: 5432,
        DB_NAME: 'otedama_mining_dev',
        DB_USER: 'otedama_user',
        LOG_LEVEL: 'debug'
      },
      // Logging configuration
      log_file: 'logs/combined.log',
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      
      // Process management
      min_uptime: '10s',
      max_restarts: 10,
      
      // Performance monitoring
      pmx: true,
      
      // Advanced settings
      node_args: [
        '--max-old-space-size=2048',
        '--gc-interval=100'
      ],
      
      // Health check
      health_check_grace_period: 3000,
      health_check_fatal_exceptions: true,
      
      // Clustering (if needed)
      exec_mode: 'fork', // Use 'cluster' for multiple instances
      
      // Environment-specific overrides
      merge_logs: true,
      combine_logs: true,
      
      // Restart conditions
      restart_delay: 4000,
      
      // Source control
      ignore_watch: [
        'node_modules',
        'logs',
        'docs',
        '.git'
      ],
      
      // Performance
      instance_var: 'INSTANCE_ID',
      
      // Graceful shutdown
      kill_timeout: 5000,
      listen_timeout: 3000,
      
      // Custom restart triggers
      max_memory_restart: '2G',
      
      // Error handling
      autorestart: true,
      
      // Monitoring
      monitoring: {
        http: true,
        https: false,
        port: 9615
      }
    },
    {
      name: 'otedama-stratum-server',
      script: 'lib/stratum/stratum-server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        STRATUM_PORT: 3333,
        STRATUM_WORKERS: 4
      },
      env_production: {
        NODE_ENV: 'production',
        STRATUM_PORT: 3333,
        STRATUM_WORKERS: 4,
        LOG_LEVEL: 'info'
      },
      log_file: 'logs/stratum-combined.log',
      out_file: 'logs/stratum-out.log',
      error_file: 'logs/stratum-error.log',
      exec_mode: 'fork',
      restart_delay: 2000,
      kill_timeout: 3000
    },
    {
      name: 'otedama-monitoring',
      script: 'lib/monitoring/comprehensive-monitoring-system.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        MONITORING_PORT: 9090,
        MONITORING_INTERVAL: 30000
      },
      log_file: 'logs/monitoring-combined.log',
      out_file: 'logs/monitoring-out.log',
      error_file: 'logs/monitoring-error.log',
      restart_delay: 5000,
      kill_timeout: 2000
    }
  ],
  
  // Global PM2 settings
  deploy: {
    production: {
      user: 'deploy',
      host: 'your-server.com',
      ref: 'origin/main',
      repo: 'git@github.com:your-org/otedama.git',
      path: '/var/www/otedama-mining-pool',
      'post-deploy': 'npm install && npm run build && pm2 reload ecosystem.config.js --env production'
    },
    staging: {
      user: 'deploy',
      host: 'staging-server.com',
      ref: 'origin/develop',
      repo: 'git@github.com:your-org/otedama.git',
      path: '/var/www/otedama-mining-pool-staging',
      'post-deploy': 'npm install && npm run build && pm2 reload ecosystem.config.js --env staging'
    }
  },
  
  // PM2+ Keymetrics integration
  pmx: {
    network: true,
    ports: true
  }
};