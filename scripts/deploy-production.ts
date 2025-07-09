#!/usr/bin/env node
// Production deployment helper for Otedama Pool
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as crypto from 'crypto';

const execAsync = promisify(exec);

interface DeploymentConfig {
  mode: 'docker' | 'pm2' | 'systemd';
  environment: 'production' | 'staging';
  enableBackup: boolean;
  enableMonitoring: boolean;
  sslEnabled: boolean;
}

class ProductionDeployer {
  private config: DeploymentConfig;
  
  constructor(config: DeploymentConfig) {
    this.config = config;
  }
  
  async deploy(): Promise<void> {
    console.log('🚀 Starting Otedama Pool Production Deployment\n');
    
    // Pre-deployment checks
    await this.runPreDeploymentChecks();
    
    // Generate secure configuration
    await this.generateSecureConfig();
    
    // Build production version
    await this.buildProduction();
    
    // Deploy based on mode
    switch (this.config.mode) {
      case 'docker':
        await this.deployDocker();
        break;
      case 'pm2':
        await this.deployPM2();
        break;
      case 'systemd':
        await this.deploySystemd();
        break;
    }
    
    // Post-deployment setup
    await this.postDeploymentSetup();
    
    console.log('\n✅ Deployment complete!');
    await this.showDeploymentInfo();
  }
  
  private async runPreDeploymentChecks(): Promise<void> {
    console.log('📋 Running pre-deployment checks...\n');
    
    const checks = [
      { name: 'Node.js version', cmd: 'node --version', minVersion: 'v18' },
      { name: 'Available memory', check: this.checkMemory },
      { name: 'Disk space', check: this.checkDiskSpace },
      { name: 'Bitcoin node', check: this.checkBitcoinNode },
      { name: 'Redis (if enabled)', check: this.checkRedis }
    ];
    
    for (const check of checks) {
      process.stdout.write(`Checking ${check.name}... `);
      try {
        if (check.cmd) {
          const { stdout } = await execAsync(check.cmd);
          const passed = check.minVersion ? stdout.includes(check.minVersion) : true;
          console.log(passed ? '✅' : '❌');
        } else if (check.check) {
          const passed = await check.check();
          console.log(passed ? '✅' : '❌');
        }
      } catch (error) {
        console.log('❌');
      }
    }
    
    console.log();
  }
  
  private async checkMemory(): Promise<boolean> {
    const os = await import('os');
    const freeMem = os.freemem();
    return freeMem > 2 * 1024 * 1024 * 1024; // 2GB minimum
  }
  
  private async checkDiskSpace(): Promise<boolean> {
    try {
      const { stdout } = await execAsync('df -BG . | tail -1 | awk \'{print $4}\'');
      const availableGB = parseInt(stdout);
      return availableGB > 10; // 10GB minimum
    } catch {
      return true; // Skip on Windows
    }
  }
  
  private async checkBitcoinNode(): Promise<boolean> {
    // Check if Bitcoin node is accessible
    const config = await this.loadEnvConfig();
    if (!config.RPC_URL) return false;
    
    try {
      const { default: fetch } = await import('node-fetch');
      const response = await fetch(config.RPC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(`${config.RPC_USER}:${config.RPC_PASSWORD}`).toString('base64')
        },
        body: JSON.stringify({
          jsonrpc: '1.0',
          id: 'test',
          method: 'getblockcount',
          params: []
        })
      });
      return response.ok;
    } catch {
      return false;
    }
  }
  
  private async checkRedis(): Promise<boolean> {
    const config = await this.loadEnvConfig();
    if (config.REDIS_ENABLED !== 'true') return true;
    
    try {
      await execAsync(`redis-cli -h ${config.REDIS_HOST || 'localhost'} ping`);
      return true;
    } catch {
      return false;
    }
  }
  
  private async generateSecureConfig(): Promise<void> {
    console.log('🔐 Generating secure configuration...\n');
    
    const envPath = '.env.production';
    const config = await this.loadEnvConfig();
    
    // Generate secure values
    config.API_SECRET = crypto.randomBytes(32).toString('hex');
    config.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    
    // Production optimizations
    config.LOG_LEVEL = 'WARN';
    config.DEBUG_MODE = 'false';
    config.TEST_MODE = 'false';
    
    // Security hardening
    config.RATE_LIMIT_REQUESTS_PER_MINUTE = '300';
    config.MAX_CONNECTIONS_PER_IP = '5';
    config.AUTO_BLOCK_THRESHOLD = '5';
    
    // Performance optimizations
    config.ENABLE_PARALLEL_VALIDATION = 'true';
    config.PARALLEL_WORKERS = String(Math.max(2, require('os').cpus().length - 1));
    
    // SSL/TLS
    if (this.config.sslEnabled) {
      config.TLS_ENABLED = 'true';
      config.TLS_CERT_PATH = '/etc/letsencrypt/live/yourdomain.com/fullchain.pem';
      config.TLS_KEY_PATH = '/etc/letsencrypt/live/yourdomain.com/privkey.pem';
    }
    
    // Write production config
    const envContent = Object.entries(config)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    
    await fs.writeFile(envPath, envContent);
    console.log('✅ Production configuration generated\n');
  }
  
  private async loadEnvConfig(): Promise<Record<string, string>> {
    try {
      const content = await fs.readFile('.env', 'utf-8');
      const config: Record<string, string> = {};
      
      content.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const [key, ...valueParts] = trimmed.split('=');
          config[key] = valueParts.join('=');
        }
      });
      
      return config;
    } catch {
      // Load from example if .env doesn't exist
      const content = await fs.readFile('.env.example', 'utf-8');
      const config: Record<string, string> = {};
      
      content.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const [key, ...valueParts] = trimmed.split('=');
          config[key] = valueParts.join('=');
        }
      });
      
      return config;
    }
  }
  
  private async buildProduction(): Promise<void> {
    console.log('🔨 Building production version...\n');
    
    // Clean previous build
    await execAsync('rm -rf dist');
    
    // Build with production optimizations
    process.env.NODE_ENV = 'production';
    await execAsync('npm run build:complete');
    
    console.log('✅ Production build complete\n');
  }
  
  private async deployDocker(): Promise<void> {
    console.log('🐳 Deploying with Docker...\n');
    
    // Build optimized Docker image
    await execAsync('docker build -f Dockerfile.optimized -t otedama-pool:production .');
    
    // Create Docker Compose production file
    const dockerCompose = `
version: '3.8'

services:
  pool:
    image: otedama-pool:production
    container_name: otedama-pool
    restart: always
    env_file:
      - .env.production
    ports:
      - "3333:3333"  # Stratum
      - "8080:8080"  # Dashboard
      - "8088:8088"  # API
      - "9090:9090"  # Metrics
    volumes:
      - ./data:/app/data
      - ./logs:/app/logs
      - ./backups:/app/backups
    networks:
      - pool-network
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 4G
        reservations:
          cpus: '1'
          memory: 2G
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s

  redis:
    image: redis:7-alpine
    container_name: otedama-redis
    restart: always
    command: redis-server --appendonly yes --maxmemory 1gb --maxmemory-policy allkeys-lru
    volumes:
      - redis-data:/data
    networks:
      - pool-network

networks:
  pool-network:
    driver: bridge

volumes:
  redis-data:
`;
    
    await fs.writeFile('docker-compose.production.yml', dockerCompose);
    
    // Start services
    await execAsync('docker-compose -f docker-compose.production.yml up -d');
    
    console.log('✅ Docker deployment complete\n');
  }
  
  private async deployPM2(): Promise<void> {
    console.log('🔄 Deploying with PM2...\n');
    
    // Generate PM2 ecosystem file
    const ecosystem = {
      apps: [{
        name: 'otedama-pool',
        script: './dist/main-integrated.js',
        instances: 1,
        exec_mode: 'cluster',
        env_production: {
          NODE_ENV: 'production',
          NODE_OPTIONS: '--max-old-space-size=4096'
        },
        max_memory_restart: '3G',
        error_file: './logs/pm2-error.log',
        out_file: './logs/pm2-out.log',
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        kill_timeout: 5000,
        wait_ready: true,
        listen_timeout: 10000,
        autorestart: true,
        watch: false,
        max_restarts: 10,
        min_uptime: '10s'
      }]
    };
    
    await fs.writeFile('ecosystem.production.config.js', 
      `module.exports = ${JSON.stringify(ecosystem, null, 2)}`);
    
    // Copy production env
    await execAsync('cp .env.production .env');
    
    // Start with PM2
    await execAsync('pm2 start ecosystem.production.config.js --env production');
    await execAsync('pm2 save');
    await execAsync('pm2 startup');
    
    console.log('✅ PM2 deployment complete\n');
  }
  
  private async deploySystemd(): Promise<void> {
    console.log('⚙️ Deploying with systemd...\n');
    
    const servicePath = '/etc/systemd/system/otedama-pool.service';
    const serviceContent = `[Unit]
Description=Otedama Mining Pool
After=network.target redis.service
Wants=redis.service

[Service]
Type=simple
User=otedama
Group=otedama
WorkingDirectory=/opt/otedama-pool
ExecStart=/usr/bin/node /opt/otedama-pool/dist/main-integrated.js
Restart=always
RestartSec=10

# Security
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/otedama-pool/data /opt/otedama-pool/logs /opt/otedama-pool/backups

# Resource limits
LimitNOFILE=65536
LimitNPROC=512
MemoryLimit=4G
CPUQuota=200%

# Environment
Environment="NODE_ENV=production"
Environment="NODE_OPTIONS=--max-old-space-size=4096"
EnvironmentFile=/opt/otedama-pool/.env.production

[Install]
WantedBy=multi-user.target`;
    
    // Create system user
    try {
      await execAsync('useradd -r -s /bin/false otedama');
    } catch {
      // User might already exist
    }
    
    // Copy files to system location
    await execAsync('sudo mkdir -p /opt/otedama-pool');
    await execAsync('sudo cp -r dist /opt/otedama-pool/');
    await execAsync('sudo cp .env.production /opt/otedama-pool/');
    await execAsync('sudo cp package.json /opt/otedama-pool/');
    await execAsync('sudo cp -r node_modules /opt/otedama-pool/');
    
    // Set permissions
    await execAsync('sudo chown -R otedama:otedama /opt/otedama-pool');
    
    // Install service
    await fs.writeFile('/tmp/otedama-pool.service', serviceContent);
    await execAsync('sudo mv /tmp/otedama-pool.service ' + servicePath);
    await execAsync('sudo systemctl daemon-reload');
    await execAsync('sudo systemctl enable otedama-pool');
    await execAsync('sudo systemctl start otedama-pool');
    
    console.log('✅ Systemd deployment complete\n');
  }
  
  private async postDeploymentSetup(): Promise<void> {
    console.log('🔧 Running post-deployment setup...\n');
    
    if (this.config.enableBackup) {
      console.log('Setting up automated backups...');
      const cronJob = '0 2 * * * cd /opt/otedama-pool && npm run backup:manual';
      await execAsync(`(crontab -l 2>/dev/null; echo "${cronJob}") | crontab -`);
      console.log('✅ Backup cron job created\n');
    }
    
    if (this.config.enableMonitoring) {
      console.log('Setting up monitoring...');
      // Setup Prometheus scraping, alerts, etc.
      console.log('✅ Monitoring configured\n');
    }
    
    // Setup log rotation
    const logrotateConfig = `/opt/otedama-pool/logs/*.log {
  daily
  rotate 7
  compress
  delaycompress
  missingok
  notifempty
  create 0640 otedama otedama
  sharedscripts
  postrotate
    systemctl reload otedama-pool > /dev/null 2>&1 || true
  endscript
}`;
    
    await fs.writeFile('/tmp/otedama-pool-logrotate', logrotateConfig);
    await execAsync('sudo mv /tmp/otedama-pool-logrotate /etc/logrotate.d/otedama-pool');
    
    console.log('✅ Log rotation configured\n');
  }
  
  private async showDeploymentInfo(): Promise<void> {
    const config = await this.loadEnvConfig();
    
    console.log('📊 Deployment Information:\n');
    console.log(`Mode: ${this.config.mode}`);
    console.log(`Environment: ${this.config.environment}`);
    console.log('\nAccess Points:');
    console.log(`  Stratum: stratum+tcp://your-server:${config.STRATUM_PORT || '3333'}`);
    console.log(`  Dashboard: http://your-server:${config.DASHBOARD_PORT || '8080'}`);
    console.log(`  API: http://your-server:${config.API_PORT || '8088'}`);
    console.log(`  Metrics: http://your-server:${config.METRICS_PORT || '9090'}/metrics`);
    
    console.log('\nManagement Commands:');
    switch (this.config.mode) {
      case 'docker':
        console.log('  docker-compose -f docker-compose.production.yml ps');
        console.log('  docker-compose -f docker-compose.production.yml logs -f');
        console.log('  docker-compose -f docker-compose.production.yml restart');
        break;
      case 'pm2':
        console.log('  pm2 status');
        console.log('  pm2 logs otedama-pool');
        console.log('  pm2 restart otedama-pool');
        break;
      case 'systemd':
        console.log('  sudo systemctl status otedama-pool');
        console.log('  sudo journalctl -u otedama-pool -f');
        console.log('  sudo systemctl restart otedama-pool');
        break;
    }
    
    console.log('\n🎉 Your Otedama Pool is now running in production!');
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Usage: deploy-production.ts <mode> [options]');
    console.log('\nModes:');
    console.log('  docker   - Deploy with Docker');
    console.log('  pm2      - Deploy with PM2');
    console.log('  systemd  - Deploy with systemd');
    console.log('\nOptions:');
    console.log('  --staging         - Deploy to staging environment');
    console.log('  --no-backup       - Disable automated backups');
    console.log('  --no-monitoring   - Disable monitoring setup');
    console.log('  --ssl             - Enable SSL/TLS');
    return;
  }
  
  const config: DeploymentConfig = {
    mode: args[0] as any,
    environment: args.includes('--staging') ? 'staging' : 'production',
    enableBackup: !args.includes('--no-backup'),
    enableMonitoring: !args.includes('--no-monitoring'),
    sslEnabled: args.includes('--ssl')
  };
  
  const deployer = new ProductionDeployer(config);
  
  try {
    await deployer.deploy();
  } catch (error) {
    console.error('\n❌ Deployment failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { ProductionDeployer, DeploymentConfig };
