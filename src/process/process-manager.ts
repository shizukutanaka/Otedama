// Process manager configuration for production deployment
import * as fs from 'fs';
import * as path from 'path';
import { createComponentLogger } from '../logging/logger';

export interface ProcessManagerConfig {
  name: string;
  script: string;
  instances?: number;
  execMode?: 'fork' | 'cluster';
  maxMemoryRestart?: string;
  errorFile?: string;
  outFile?: string;
  logDateFormat?: string;
  env?: Record<string, string>;
}

export class ProcessManager {
  private logger = createComponentLogger('ProcessManager');
  
  // Generate PM2 ecosystem file
  generatePM2Config(config: ProcessManagerConfig): string {
    const pm2Config = {
      apps: [{
        name: config.name || 'otedama-pool',
        script: config.script || './dist/main.js',
        instances: config.instances || 1,
        exec_mode: config.execMode || 'fork',
        max_memory_restart: config.maxMemoryRestart || '2G',
        error_file: config.errorFile || './logs/pm2-error.log',
        out_file: config.outFile || './logs/pm2-out.log',
        log_date_format: config.logDateFormat || 'YYYY-MM-DD HH:mm:ss',
        env: config.env || {},
        // Advanced PM2 options
        autorestart: true,
        watch: false,
        max_restarts: 10,
        min_uptime: '10s',
        restart_delay: 4000,
        // Graceful shutdown
        kill_timeout: 5000,
        listen_timeout: 3000,
        // Monitoring
        instance_var: 'INSTANCE_ID',
        merge_logs: true,
        // Node.js arguments
        node_args: '--max-old-space-size=2048',
      }]
    };
    
    return `module.exports = ${JSON.stringify(pm2Config, null, 2)};`;
  }
  
  // Generate systemd service file
  generateSystemdService(options: {
    execPath: string;
    workingDirectory: string;
    user?: string;
    group?: string;
    description?: string;
    env?: Record<string, string>;
  }): string {
    const env = options.env || {};
    const envLines = Object.entries(env)
      .map(([key, value]) => `Environment="${key}=${value}"`)
      .join('\n');
    
    return `[Unit]
Description=${options.description || 'Otedama Mining Pool'}
After=network.target

[Service]
Type=simple
User=${options.user || 'otedama'}
Group=${options.group || options.user || 'otedama'}
WorkingDirectory=${options.workingDirectory}
ExecStart=/usr/bin/node ${options.execPath}
Restart=always
RestartSec=10

# Resource limits
LimitNOFILE=65536
LimitNPROC=4096

# Environment variables
${envLines}

# Security
NoNewPrivileges=true
PrivateTmp=true

# Logging
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target`;
  }
  
  // Save PM2 config
  async savePM2Config(filePath: string = './ecosystem.config.js'): Promise<void> {
    const config: ProcessManagerConfig = {
      name: 'otedama-pool',
      script: './dist/main.js',
      instances: process.env.PM2_INSTANCES ? parseInt(process.env.PM2_INSTANCES) : 1,
      execMode: process.env.PM2_EXEC_MODE as 'fork' | 'cluster' || 'fork',
      maxMemoryRestart: process.env.PM2_MAX_MEMORY || '2G',
      errorFile: './logs/pm2-error.log',
      outFile: './logs/pm2-out.log',
      env: {
        NODE_ENV: 'production',
        ...process.env
      }
    };
    
    const content = this.generatePM2Config(config);
    await fs.promises.writeFile(filePath, content);
    this.logger.info('PM2 config saved', { path: filePath });
  }
  
  // Save systemd service file
  async saveSystemdService(filePath: string = './otedama-pool.service'): Promise<void> {
    const workingDir = process.cwd();
    const execPath = path.join(workingDir, 'dist/main.js');
    
    const service = this.generateSystemdService({
      execPath,
      workingDirectory: workingDir,
      user: process.env.SERVICE_USER || 'otedama',
      description: 'Otedama Mining Pool Service',
      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--max-old-space-size=2048'
      }
    });
    
    await fs.promises.writeFile(filePath, service);
    this.logger.info('Systemd service file saved', { path: filePath });
    
    // Log installation instructions
    console.log('\nTo install the systemd service:');
    console.log(`1. sudo cp ${filePath} /etc/systemd/system/`);
    console.log('2. sudo systemctl daemon-reload');
    console.log('3. sudo systemctl enable otedama-pool');
    console.log('4. sudo systemctl start otedama-pool');
  }
  
  // Generate Docker Compose configuration
  generateDockerCompose(): string {
    return `version: '3.8'

services:
  otedama-pool:
    build: .
    container_name: otedama-pool
    restart: always
    ports:
      - "3333:3333"     # Stratum port
      - "8080:8080"     # Dashboard port
      - "8081:8081"     # WebSocket port
      - "8088:8088"     # API port
      - "9090:9090"     # Metrics port
      - "3001:3001"     # Health check port
    volumes:
      - ./data:/app/data
      - ./logs:/app/logs
      - ./backups:/app/backups
      - ./.env:/app/.env:ro
    environment:
      - NODE_ENV=production
      - NODE_OPTIONS=--max-old-space-size=2048
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
    networks:
      - otedama-network

  redis:
    image: redis:7-alpine
    container_name: otedama-redis
    restart: always
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes --maxmemory 512mb --maxmemory-policy allkeys-lru
    networks:
      - otedama-network

networks:
  otedama-network:
    driver: bridge

volumes:
  redis-data:`;
  }
  
  // Generate startup script
  generateStartupScript(): string {
    return `#!/bin/bash
# Otedama Pool Startup Script

# Colors for output
RED='\\033[0;31m'
GREEN='\\033[0;32m'
YELLOW='\\033[1;33m'
NC='\\033[0m' # No Color

echo -e "\${GREEN}Starting Otedama Mining Pool...\${NC}"

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
   echo -e "\${RED}Please do not run as root!\${NC}"
   exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ $NODE_VERSION -lt 18 ]; then
    echo -e "\${RED}Node.js 18 or higher is required!\${NC}"
    exit 1
fi

# Create required directories
mkdir -p data logs backups

# Check if .env exists
if [ ! -f .env ]; then
    echo -e "\${YELLOW}Creating .env from example...\${NC}"
    cp .env.example .env
    echo -e "\${RED}Please configure .env file before starting!\${NC}"
    exit 1
fi

# Build if needed
if [ ! -d "dist" ]; then
    echo -e "\${YELLOW}Building application...\${NC}"
    npm run build
fi

# Start with PM2
if command -v pm2 &> /dev/null; then
    echo -e "\${GREEN}Starting with PM2...\${NC}"
    pm2 start ecosystem.config.js
    pm2 save
else
    echo -e "\${YELLOW}PM2 not found, starting directly...\${NC}"
    npm start
fi

echo -e "\${GREEN}Otedama Pool started successfully!\${NC}"`;
  }
}

// CLI for generating configs
if (require.main === module) {
  const manager = new ProcessManager();
  const command = process.argv[2];
  
  async function main() {
    switch (command) {
      case 'pm2':
        await manager.savePM2Config();
        console.log('PM2 ecosystem file generated: ecosystem.config.js');
        break;
        
      case 'systemd':
        await manager.saveSystemdService();
        break;
        
      case 'docker-compose':
        const dockerCompose = manager.generateDockerCompose();
        await fs.promises.writeFile('./docker-compose.yml', dockerCompose);
        console.log('Docker Compose file generated: docker-compose.yml');
        break;
        
      case 'startup':
        const script = manager.generateStartupScript();
        await fs.promises.writeFile('./start.sh', script);
        await fs.promises.chmod('./start.sh', '755');
        console.log('Startup script generated: start.sh');
        break;
        
      default:
        console.log('Otedama Process Manager Config Generator\n');
        console.log('Usage:');
        console.log('  ts-node process-manager.ts pm2         - Generate PM2 ecosystem file');
        console.log('  ts-node process-manager.ts systemd     - Generate systemd service file');
        console.log('  ts-node process-manager.ts docker-compose - Generate docker-compose.yml');
        console.log('  ts-node process-manager.ts startup     - Generate startup script');
    }
  }
  
  main().catch(console.error);
}
