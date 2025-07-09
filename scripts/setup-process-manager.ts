#!/usr/bin/env node
// Process manager setup utility
import { ProcessManager } from '../src/process/process-manager';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

async function setupPM2() {
  console.log('🚀 Setting up PM2 configuration...\n');
  
  const manager = new ProcessManager();
  const config = manager.generatePM2Config({
    name: 'otedama-pool',
    script: './dist/main-complete.js',
    instances: parseInt(process.env.PM2_INSTANCES || '1'),
    execMode: 'fork',
    maxMemoryRestart: process.env.PM2_MAX_MEMORY || '2G',
    env: {
      NODE_ENV: 'production',
      ...process.env
    }
  });
  
  await fs.writeFile('./ecosystem.config.js', config);
  
  console.log('✅ PM2 configuration saved to: ecosystem.config.js');
  console.log('\nTo start with PM2:');
  console.log('  pm2 start ecosystem.config.js');
  console.log('  pm2 save');
  console.log('  pm2 startup');
}

async function setupSystemd() {
  console.log('🚀 Setting up systemd service...\n');
  
  const manager = new ProcessManager();
  const workingDir = process.cwd();
  const execPath = path.join(workingDir, 'dist/main-complete.js');
  
  const service = manager.generateSystemdService({
    execPath,
    workingDirectory: workingDir,
    user: process.env.SERVICE_USER || 'otedama',
    description: 'Otedama Mining Pool Service',
    env: {
      NODE_ENV: 'production',
      NODE_OPTIONS: '--max-old-space-size=2048'
    }
  });
  
  await fs.writeFile('./otedama-pool.service', service);
  
  console.log('✅ Systemd service file saved to: otedama-pool.service');
  console.log('\nTo install the service:');
  console.log('  sudo cp otedama-pool.service /etc/systemd/system/');
  console.log('  sudo systemctl daemon-reload');
  console.log('  sudo systemctl enable otedama-pool');
  console.log('  sudo systemctl start otedama-pool');
  console.log('\nTo view logs:');
  console.log('  sudo journalctl -u otedama-pool -f');
}

async function setupDocker() {
  console.log('🚀 Setting up Docker configuration...\n');
  
  const manager = new ProcessManager();
  const dockerCompose = manager.generateDockerCompose();
  
  await fs.writeFile('./docker-compose.yml', dockerCompose);
  
  // Also create a production Dockerfile
  const dockerfile = `FROM node:18-alpine

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy built application
COPY dist ./dist
COPY .env.example ./.env.example

# Create necessary directories
RUN mkdir -p data logs backups

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose ports
EXPOSE 3333 8080 8081 8088 9090 3001

# Start the application
CMD ["node", "dist/main-complete.js"]`;
  
  await fs.writeFile('./Dockerfile.production', dockerfile);
  
  console.log('✅ Docker configuration saved:');
  console.log('   - docker-compose.yml');
  console.log('   - Dockerfile.production');
  console.log('\nTo start with Docker:');
  console.log('  docker-compose up -d');
  console.log('\nTo build production image:');
  console.log('  docker build -f Dockerfile.production -t otedama-pool:latest .');
}

async function setupAll() {
  console.log('🎯 Setting up all process manager configurations...\n');
  
  await setupPM2();
  console.log('\n' + '='.repeat(50) + '\n');
  
  await setupSystemd();
  console.log('\n' + '='.repeat(50) + '\n');
  
  await setupDocker();
  
  // Create startup script
  const startupScript = `#!/bin/bash
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
    npm run build:complete
fi

# Detect best startup method
if command -v pm2 &> /dev/null; then
    echo -e "\${GREEN}Starting with PM2...\${NC}"
    pm2 start ecosystem.config.js
    pm2 save
elif command -v systemctl &> /dev/null && [ -f /etc/systemd/system/otedama-pool.service ]; then
    echo -e "\${GREEN}Starting with systemd...\${NC}"
    sudo systemctl start otedama-pool
elif command -v docker &> /dev/null && [ -f docker-compose.yml ]; then
    echo -e "\${GREEN}Starting with Docker...\${NC}"
    docker-compose up -d
else
    echo -e "\${YELLOW}Starting directly with Node.js...\${NC}"
    npm start:complete
fi

echo -e "\${GREEN}Otedama Pool started successfully!\${NC}"`;
  
  await fs.writeFile('./start.sh', startupScript);
  await fs.chmod('./start.sh', '755');
  
  console.log('\n' + '='.repeat(50) + '\n');
  console.log('✅ All configurations created successfully!');
  console.log('\n📝 Created files:');
  console.log('   - ecosystem.config.js (PM2)');
  console.log('   - otedama-pool.service (systemd)');
  console.log('   - docker-compose.yml (Docker)');
  console.log('   - Dockerfile.production');
  console.log('   - start.sh (universal startup script)');
  console.log('\n🚀 Quick start:');
  console.log('   ./start.sh');
}

// Main execution
async function main() {
  const command = process.argv[2];
  
  try {
    switch (command) {
      case 'pm2':
        await setupPM2();
        break;
        
      case 'systemd':
        await setupSystemd();
        break;
        
      case 'docker':
        await setupDocker();
        break;
        
      case 'all':
        await setupAll();
        break;
        
      default:
        console.log('Otedama Pool - Process Manager Setup\n');
        console.log('Usage:');
        console.log('  npm run setup:pm2      - Generate PM2 configuration');
        console.log('  npm run setup:systemd  - Generate systemd service');
        console.log('  npm run setup:docker   - Generate Docker configuration');
        console.log('  npm run setup:all      - Generate all configurations');
        console.log('\nExample:');
        console.log('  npm run setup:all');
    }
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();
