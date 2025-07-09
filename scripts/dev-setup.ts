#!/usr/bin/env node
// Development Setup Manager (Item 81: Developer Experience)
// One-command setup for the entire development environment

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Logger } from '../src/logging/logger';

interface SetupOptions {
  skipDocker?: boolean;
  skipDependencies?: boolean;
  skipDatabase?: boolean;
  profile?: 'minimal' | 'standard' | 'full';
  verbose?: boolean;
}

/**
 * Development Environment Setup Manager
 * Following Pike's principle: "Make it easy to do the right thing"
 */
class DevSetupManager {
  private logger = new Logger('DevSetup');
  private projectRoot: string;
  
  constructor() {
    this.projectRoot = path.resolve(__dirname, '..');
  }
  
  /**
   * Main setup orchestrator
   */
  async setup(options: SetupOptions = {}): Promise<void> {
    const startTime = Date.now();
    
    this.logger.info('🚀 Starting Otedama Pool development setup...');
    
    try {
      // Check prerequisites
      await this.checkPrerequisites();
      
      // Install dependencies
      if (!options.skipDependencies) {
        await this.installDependencies();
      }
      
      // Setup environment
      await this.setupEnvironment(options.profile || 'standard');
      
      // Setup database
      if (!options.skipDatabase) {
        await this.setupDatabase();
      }
      
      // Setup Docker environment
      if (!options.skipDocker) {
        await this.setupDockerEnvironment();
      }
      
      // Setup development tools
      await this.setupDevTools();
      
      // Generate configuration
      await this.generateConfiguration();
      
      // Setup IDE configuration
      await this.setupIDEConfig();
      
      // Run initial tests
      await this.runInitialTests();
      
      const duration = (Date.now() - startTime) / 1000;
      this.logger.info(`✅ Setup completed successfully in ${duration.toFixed(1)}s`);
      
      this.printNextSteps();
      
    } catch (error) {
      this.logger.error('❌ Setup failed:', error as Error);
      throw error;
    }
  }
  
  /**
   * Check system prerequisites
   */
  private async checkPrerequisites(): Promise<void> {
    this.logger.info('🔍 Checking prerequisites...');
    
    const requirements = [
      { name: 'Node.js', command: 'node --version', minVersion: '18.0.0' },
      { name: 'npm', command: 'npm --version', minVersion: '8.0.0' },
      { name: 'Git', command: 'git --version', minVersion: '2.0.0' }
    ];
    
    const optionalRequirements = [
      { name: 'Docker', command: 'docker --version' },
      { name: 'Docker Compose', command: 'docker-compose --version' }
    ];
    
    // Check required tools
    for (const req of requirements) {
      try {
        const output = execSync(req.command, { encoding: 'utf8' });
        const version = this.extractVersion(output);
        
        if (this.compareVersions(version, req.minVersion) < 0) {
          throw new Error(`${req.name} version ${version} is below minimum ${req.minVersion}`);
        }
        
        this.logger.info(`✓ ${req.name} ${version}`);
      } catch (error) {
        throw new Error(`❌ ${req.name} is required but not found`);
      }
    }
    
    // Check optional tools
    for (const req of optionalRequirements) {
      try {
        const output = execSync(req.command, { encoding: 'utf8' });
        const version = this.extractVersion(output);
        this.logger.info(`✓ ${req.name} ${version}`);
      } catch (error) {
        this.logger.warn(`⚠️  ${req.name} not found (optional)`);
      }
    }
  }
  
  /**
   * Install project dependencies
   */
  private async installDependencies(): Promise<void> {
    this.logger.info('📦 Installing dependencies...');
    
    try {
      execSync('npm ci', { 
        cwd: this.projectRoot,
        stdio: 'pipe'
      });
      
      // Install development tools globally if needed
      const globalTools = [
        'nodemon',
        'ts-node',
        'typescript'
      ];
      
      for (const tool of globalTools) {
        try {
          execSync(`npm list -g ${tool}`, { stdio: 'pipe' });
        } catch (error) {
          this.logger.info(`Installing global tool: ${tool}`);
          execSync(`npm install -g ${tool}`, { stdio: 'pipe' });
        }
      }
      
      this.logger.info('✓ Dependencies installed');
    } catch (error) {
      throw new Error(`Failed to install dependencies: ${error}`);
    }
  }
  
  /**
   * Setup development environment
   */
  private async setupEnvironment(profile: string): Promise<void> {
    this.logger.info(`🌍 Setting up ${profile} environment...`);
    
    const envConfigs = {
      minimal: this.getMinimalEnvConfig(),
      standard: this.getStandardEnvConfig(),
      full: this.getFullEnvConfig()
    };
    
    const envConfig = envConfigs[profile as keyof typeof envConfigs];
    const envPath = path.join(this.projectRoot, '.env');
    
    if (!fs.existsSync(envPath)) {
      fs.writeFileSync(envPath, envConfig);
      this.logger.info('✓ Environment configuration created');
    } else {
      this.logger.info('✓ Environment configuration exists');
    }
  }
  
  /**
   * Setup database
   */
  private async setupDatabase(): Promise<void> {
    this.logger.info('🗄️  Setting up database...');
    
    const dataDir = path.join(this.projectRoot, 'data');
    const dbDirs = ['shares', 'miners', 'blocks', 'payments'];
    
    // Create data directories
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    for (const dir of dbDirs) {
      const fullPath = path.join(dataDir, dir);
      if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
      }
    }
    
    this.logger.info('✓ Database directories created');
  }
  
  /**
   * Setup Docker development environment
   */
  private async setupDockerEnvironment(): Promise<void> {
    this.logger.info('🐳 Setting up Docker environment...');
    
    try {
      // Check if Docker is available
      execSync('docker --version', { stdio: 'pipe' });
      
      // Create Docker network if not exists
      try {
        execSync('docker network inspect otedama-network', { stdio: 'pipe' });
      } catch (error) {
        execSync('docker network create otedama-network', { stdio: 'pipe' });
        this.logger.info('✓ Docker network created');
      }
      
      // Pull required images
      const images = [
        'redis:7-alpine',
        'postgres:15-alpine',
        'node:18-alpine'
      ];
      
      for (const image of images) {
        this.logger.info(`Pulling Docker image: ${image}`);
        execSync(`docker pull ${image}`, { stdio: 'pipe' });
      }
      
      this.logger.info('✓ Docker environment ready');
    } catch (error) {
      this.logger.warn('⚠️  Docker setup skipped (Docker not available)');
    }
  }
  
  /**
   * Setup development tools and scripts
   */
  private async setupDevTools(): Promise<void> {
    this.logger.info('🛠️  Setting up development tools...');
    
    // Create development scripts
    const scriptsDir = path.join(this.projectRoot, 'scripts', 'dev');
    if (!fs.existsSync(scriptsDir)) {
      fs.mkdirSync(scriptsDir, { recursive: true });
    }
    
    // Create quick start script
    const startScript = `#!/bin/bash
# Quick start script for development
echo "🚀 Starting Otedama Pool development environment..."

# Start Docker services
if command -v docker-compose &> /dev/null; then
  echo "Starting Docker services..."
  docker-compose -f docker-compose.dev.yml up -d redis postgres
  sleep 5
fi

# Start the pool
echo "Starting pool..."
npm run dev:enhanced

echo "✅ Development environment started!"
echo "Dashboard: http://localhost:8081"
echo "API: http://localhost:8080"
echo "Stratum: localhost:3333"
`;
    
    fs.writeFileSync(path.join(scriptsDir, 'start.sh'), startScript, { mode: 0o755 });
    
    // Create test script
    const testScript = `#!/bin/bash
echo "🧪 Running Otedama Pool tests..."

# Run linting
npm run lint

# Run type checking
npm run type-check

# Run unit tests
npm run test:unit

# Run integration tests if services are available
if docker ps | grep -q redis; then
  npm run test:integration
else
  echo "⚠️  Skipping integration tests (services not running)"
fi

echo "✅ Tests completed!"
`;
    
    fs.writeFileSync(path.join(scriptsDir, 'test.sh'), testScript, { mode: 0o755 });
    
    this.logger.info('✓ Development tools configured');
  }
  
  /**
   * Generate development configuration files
   */
  private async generateConfiguration(): Promise<void> {
    this.logger.info('⚙️  Generating configuration...');
    
    // Create config directory
    const configDir = path.join(this.projectRoot, 'config', 'dev');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    // Generate Redis config
    const redisConfig = `# Redis configuration for development
bind 127.0.0.1
port 6379
timeout 300
save 900 1
save 300 10
save 60 10000
rdbcompression yes
dbfilename dump.rdb
dir ./data/redis/
`;
    fs.writeFileSync(path.join(configDir, 'redis.conf'), redisConfig);
    
    // Generate PostgreSQL init script
    const pgInitScript = `-- PostgreSQL initialization for development
CREATE DATABASE IF NOT EXISTS otedama_pool;
CREATE USER IF NOT EXISTS otedama WITH PASSWORD 'otedama_dev_password';
GRANT ALL PRIVILEGES ON DATABASE otedama_pool TO otedama;
`;
    const pgDir = path.join(configDir, 'postgres');
    if (!fs.existsSync(pgDir)) {
      fs.mkdirSync(pgDir, { recursive: true });
    }
    fs.writeFileSync(path.join(pgDir, 'init.sql'), pgInitScript);
    
    this.logger.info('✓ Configuration files generated');
  }
  
  /**
   * Setup IDE configuration
   */
  private async setupIDEConfig(): Promise<void> {
    this.logger.info('🎯 Setting up IDE configuration...');
    
    // VS Code settings
    const vscodeDir = path.join(this.projectRoot, '.vscode');
    if (!fs.existsSync(vscodeDir)) {
      fs.mkdirSync(vscodeDir, { recursive: true });
    }
    
    const vscodeSettings = {
      "typescript.preferences.noSemicolons": "off",
      "editor.formatOnSave": true,
      "editor.codeActionsOnSave": {
        "source.fixAll.eslint": true
      },
      "typescript.preferences.includePackageJsonAutoImports": "auto",
      "files.associations": {
        "*.ts": "typescript"
      },
      "jest.autoRun": "off",
      "jest.showCoverageOnLoad": true
    };
    
    fs.writeFileSync(
      path.join(vscodeDir, 'settings.json'),
      JSON.stringify(vscodeSettings, null, 2)
    );
    
    // Launch configuration
    const launchConfig = {
      "version": "0.2.0",
      "configurations": [
        {
          "name": "Debug Pool",
          "type": "node",
          "request": "launch",
          "program": "${workspaceFolder}/src/main-complete-refactored.ts",
          "runtimeArgs": ["-r", "ts-node/register"],
          "env": {
            "NODE_ENV": "development",
            "DEBUG": "otedama:*"
          },
          "console": "integratedTerminal",
          "internalConsoleOptions": "neverOpen"
        },
        {
          "name": "Debug Tests",
          "type": "node",
          "request": "launch",
          "program": "${workspaceFolder}/node_modules/.bin/jest",
          "args": ["--runInBand"],
          "console": "integratedTerminal",
          "internalConsoleOptions": "neverOpen"
        }
      ]
    };
    
    fs.writeFileSync(
      path.join(vscodeDir, 'launch.json'),
      JSON.stringify(launchConfig, null, 2)
    );
    
    this.logger.info('✓ IDE configuration created');
  }
  
  /**
   * Run initial tests to verify setup
   */
  private async runInitialTests(): Promise<void> {
    this.logger.info('🧪 Running initial verification tests...');
    
    try {
      // Test TypeScript compilation
      execSync('npm run type-check', { 
        cwd: this.projectRoot,
        stdio: 'pipe'
      });
      
      // Test linting
      execSync('npm run lint', { 
        cwd: this.projectRoot,
        stdio: 'pipe'
      });
      
      // Test basic unit tests
      execSync('npm run test:unit -- --passWithNoTests', { 
        cwd: this.projectRoot,
        stdio: 'pipe'
      });
      
      this.logger.info('✓ Initial tests passed');
    } catch (error) {
      this.logger.warn('⚠️  Some initial tests failed - check configuration');
    }
  }
  
  /**
   * Print next steps for developer
   */
  private printNextSteps(): void {
    console.log(`
🎉 Otedama Pool Development Environment Ready!

📁 Project Structure:
   src/                 - Source code
   config/dev/          - Development configurations
   scripts/dev/         - Development scripts
   data/                - Database files
   logs/                - Log files

🚀 Quick Start:
   npm run dev          - Start basic development server
   npm run dev:enhanced - Start with all features enabled
   npm run dev:complete - Start complete refactored version

🐳 Docker Development:
   docker-compose -f docker-compose.dev.yml up -d
   npm run dev:enhanced

🧪 Testing:
   npm test            - Run all tests
   npm run test:unit   - Unit tests only
   npm run test:integration - Integration tests
   npm run test:coverage - Coverage report

📊 Monitoring:
   http://localhost:8080/health     - Health check
   http://localhost:8081            - Dashboard
   http://localhost:3000            - Grafana (if enabled)

🔧 Development Tools:
   ./scripts/dev/start.sh - Quick start script
   ./scripts/dev/test.sh  - Test runner script

💡 Tips:
   - Use 'npm run dev:enhanced' for full feature development
   - Check .env file for configuration options
   - Use VS Code for best development experience
   - Enable CPU affinity with CPU_AFFINITY_ENABLED=true
   - Enable memory alignment with MEMORY_ALIGNMENT_ENABLED=true

Happy coding! 🚀
`);
  }
  
  // Helper methods
  private extractVersion(output: string): string {
    const match = output.match(/v?(\d+\.\d+\.\d+)/);
    return match ? match[1] : '0.0.0';
  }
  
  private compareVersions(a: string, b: string): number {
    const aParts = a.split('.').map(Number);
    const bParts = b.split('.').map(Number);
    
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aPart = aParts[i] || 0;
      const bPart = bParts[i] || 0;
      
      if (aPart > bPart) return 1;
      if (aPart < bPart) return -1;
    }
    
    return 0;
  }
  
  private getMinimalEnvConfig(): string {
    return `# Minimal Development Configuration
NODE_ENV=development
DEBUG=otedama:*

# Pool Configuration
POOL_ADDRESS=1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2
POOL_FEE=1.0
STRATUM_PORT=3333
API_PORT=8080
DASHBOARD_PORT=8081

# Bitcoin Node (regtest)
RPC_URL=http://localhost:18443
RPC_USER=otedama
RPC_PASSWORD=otedama_dev_rpc

# Basic Settings
DB_TYPE=sqlite
MONITORING_ENABLED=true
API_ENABLED=true
`;
  }
  
  private getStandardEnvConfig(): string {
    return `# Standard Development Configuration
NODE_ENV=development
DEBUG=otedama:*

# Pool Configuration
POOL_ADDRESS=1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2
POOL_FEE=1.0
STRATUM_PORT=3333
API_PORT=8080
DASHBOARD_PORT=8081

# Bitcoin Node
RPC_URL=http://localhost:18443
RPC_USER=otedama
RPC_PASSWORD=otedama_dev_rpc

# Performance
ENABLE_PARALLEL_VALIDATION=true
PARALLEL_WORKERS=4
CPU_AFFINITY_ENABLED=false
MEMORY_ALIGNMENT_ENABLED=false

# Security
SSL_ENABLED=false
AUTH_ENABLED=true
DDOS_PROTECTION=true

# Database
DB_TYPE=sqlite
REDIS_HOST=localhost
REDIS_PORT=6379

# Monitoring
MONITORING_ENABLED=true
DASHBOARD_ENABLED=true
API_ENABLED=true

# Development
HOT_RELOAD=true
MOCK_BITCOIN_NODE=true
`;
  }
  
  private getFullEnvConfig(): string {
    return `# Full Development Configuration
NODE_ENV=development
DEBUG=otedama:*

# Pool Configuration
POOL_ADDRESS=1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2
POOL_FEE=1.0
STRATUM_PORT=3333
API_PORT=8080
DASHBOARD_PORT=8081

# Bitcoin Node
RPC_URL=http://localhost:18443
RPC_USER=otedama
RPC_PASSWORD=otedama_dev_rpc

# Performance Optimizations
ENABLE_PARALLEL_VALIDATION=true
PARALLEL_WORKERS=8
CPU_AFFINITY_ENABLED=true
MEMORY_ALIGNMENT_ENABLED=true
JIT_WARMUP_ENABLED=true

# Security
SSL_ENABLED=false
AUTH_ENABLED=true
DDOS_PROTECTION=true
IP_WHITELIST_ENABLED=true
RATE_LIMITING_ENABLED=true

# Database
DB_TYPE=postgres
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=otedama_pool
POSTGRES_USER=otedama
POSTGRES_PASSWORD=otedama_dev_password

# Redis Cache
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_ENABLED=true

# Monitoring & Analytics
MONITORING_ENABLED=true
DASHBOARD_ENABLED=true
API_ENABLED=true
METRICS_ENABLED=true
PROMETHEUS_ENABLED=true
GRAFANA_ENABLED=true

# Advanced Features
WEBSOCKET_ENABLED=true
GEOGRAPHIC_DISTRIBUTION=true
AUTO_SCALING=true
SMART_POOL_FEATURES=true
STRATUM_V2_ENABLED=true

# Development Features
HOT_RELOAD=true
MOCK_BITCOIN_NODE=false
LOAD_TEST_MODE=false
PROFILING_ENABLED=true
`;
  }
}

// CLI Interface
async function main() {
  const args = process.argv.slice(2);
  const options: SetupOptions = {
    profile: 'standard',
    verbose: false
  };
  
  // Parse command line arguments
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--skip-docker':
        options.skipDocker = true;
        break;
      case '--skip-deps':
        options.skipDependencies = true;
        break;
      case '--skip-db':
        options.skipDatabase = true;
        break;
      case '--profile':
        options.profile = args[++i] as 'minimal' | 'standard' | 'full';
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--help':
        console.log(`
Otedama Pool Development Setup

Usage: npm run setup [options]

Options:
  --skip-docker     Skip Docker environment setup
  --skip-deps       Skip dependency installation
  --skip-db         Skip database setup
  --profile <type>  Setup profile: minimal, standard, full (default: standard)
  --verbose         Verbose output
  --help            Show this help

Profiles:
  minimal   - Basic setup for testing
  standard  - Full development environment (recommended)
  full      - All features enabled including performance optimizations
`);
        process.exit(0);
    }
  }
  
  const setupManager = new DevSetupManager();
  await setupManager.setup(options);
}

// Run if called directly
if (require.main === module) {
  main().catch(error => {
    console.error('Setup failed:', error);
    process.exit(1);
  });
}

export { DevSetupManager };
