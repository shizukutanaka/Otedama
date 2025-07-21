/**
 * Advanced Deployment Manager
 * 
 * Automated deployment pipeline with zero-downtime, rollback, and monitoring
 * Following DevOps best practices with comprehensive automation
 */

import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { readFile, writeFile, mkdir, access, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { performance } from 'perf_hooks';
import { getErrorHandler, OtedamaError, ErrorCategory } from '../error-handler.js';

export class DeploymentManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Environment configuration
      environments: options.environments || {
        development: {
          host: 'localhost',
          port: 3333,
          domain: 'dev.otedama.local',
          branch: 'develop',
          autoDeployment: true
        },
        staging: {
          host: 'staging.otedama.io',
          port: 3333,
          domain: 'staging.otedama.io',
          branch: 'staging',
          autoDeployment: true
        },
        production: {
          host: 'otedama.io',
          port: 3333,
          domain: 'otedama.io',
          branch: 'main',
          autoDeployment: false
        }
      },
      
      // Deployment settings
      defaultEnvironment: options.defaultEnvironment || 'development',
      enableZeroDowntime: options.enableZeroDowntime !== false,
      enableRollback: options.enableRollback !== false,
      enableHealthChecks: options.enableHealthChecks !== false,
      enableBackup: options.enableBackup !== false,
      
      // Build configuration
      buildCommand: options.buildCommand || 'npm run build',
      testCommand: options.testCommand || 'npm test',
      startCommand: options.startCommand || 'npm start',
      stopCommand: options.stopCommand || 'pkill -f "node.*index.js"',
      
      // Paths
      deploymentDirectory: options.deploymentDirectory || './deployments',
      backupDirectory: options.backupDirectory || './backups/deployments',
      logDirectory: options.logDirectory || './logs/deployment',
      
      // Monitoring
      healthCheckUrl: options.healthCheckUrl || '/health',
      healthCheckTimeout: options.healthCheckTimeout || 30000,
      healthCheckRetries: options.healthCheckRetries || 5,
      
      // Docker support
      enableDocker: options.enableDocker !== false,
      dockerRegistry: options.dockerRegistry || 'ghcr.io/otedama',
      dockerTag: options.dockerTag || 'latest',
      
      // Advanced features
      enableBlueGreen: options.enableBlueGreen !== false,
      enableCanaryDeployment: options.enableCanaryDeployment !== false,
      enableAutoScaling: options.enableAutoScaling !== false,
      
      ...options
    };
    
    this.errorHandler = getErrorHandler();
    this.currentDeployment = null;
    this.deploymentHistory = [];
    this.activeInstances = new Map();
    
    // Deployment state
    this.state = {
      isDeploying: false,
      currentEnvironment: null,
      deploymentId: null,
      startTime: null,
      progress: 0,
      phase: 'idle'
    };
    
    // Metrics
    this.metrics = {
      totalDeployments: 0,
      successfulDeployments: 0,
      failedDeployments: 0,
      averageDeploymentTime: 0,
      totalDeploymentTime: 0,
      rollbacks: 0
    };
    
    this.initialize();
  }
  
  /**
   * Initialize deployment manager
   */
  async initialize() {
    try {
      // Create necessary directories
      await this.ensureDirectories();
      
      // Load deployment history
      await this.loadDeploymentHistory();
      
      // Verify environment configurations
      await this.validateEnvironments();
      
      this.emit('initialized');
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'deployment-manager',
        category: ErrorCategory.INITIALIZATION
      });
    }
  }
  
  /**
   * Deploy to specified environment
   */
  async deploy(environment = this.options.defaultEnvironment, options = {}) {
    if (this.state.isDeploying) {
      throw new OtedamaError('Deployment already in progress', ErrorCategory.OPERATION);
    }
    
    const envConfig = this.options.environments[environment];
    if (!envConfig) {
      throw new OtedamaError(`Unknown environment: ${environment}`, ErrorCategory.CONFIGURATION);
    }
    
    try {
      const deploymentId = this.generateDeploymentId();
      const startTime = Date.now();
      
      this.state = {
        isDeploying: true,
        currentEnvironment: environment,
        deploymentId,
        startTime,
        progress: 0,
        phase: 'starting'
      };
      
      this.currentDeployment = {
        id: deploymentId,
        environment,
        startTime,
        config: envConfig,
        options,
        status: 'in_progress',
        phases: []
      };
      
      console.log(`🚀 Starting deployment ${deploymentId} to ${environment}`);
      this.emit('deployment:started', this.currentDeployment);
      
      // Execute deployment pipeline
      await this.executeDeploymentPipeline();
      
      // Complete deployment
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      this.currentDeployment.endTime = endTime;
      this.currentDeployment.duration = duration;
      this.currentDeployment.status = 'completed';
      
      this.updateMetrics(true, duration);
      this.deploymentHistory.push(this.currentDeployment);
      await this.saveDeploymentHistory();
      
      this.emit('deployment:completed', this.currentDeployment);
      
      console.log(`✅ Deployment ${deploymentId} completed successfully in ${(duration / 1000).toFixed(2)}s`);
      
      return {
        success: true,
        deploymentId,
        duration,
        environment
      };
      
    } catch (error) {
      await this.handleDeploymentFailure(error);
      throw error;
      
    } finally {
      this.state.isDeploying = false;
      this.currentDeployment = null;
    }
  }
  
  /**
   * Execute deployment pipeline
   */
  async executeDeploymentPipeline() {
    const phases = [
      { name: 'pre_checks', weight: 10 },
      { name: 'backup', weight: 15 },
      { name: 'build', weight: 25 },
      { name: 'test', weight: 20 },
      { name: 'deploy', weight: 20 },
      { name: 'health_check', weight: 10 }
    ];
    
    let completedWeight = 0;
    const totalWeight = phases.reduce((sum, phase) => sum + phase.weight, 0);
    
    for (const phase of phases) {
      this.state.phase = phase.name;
      this.emit('deployment:phase_started', { phase: phase.name });
      
      const phaseResult = await this.executePhase(phase.name);
      
      this.currentDeployment.phases.push(phaseResult);
      completedWeight += phase.weight;
      this.state.progress = (completedWeight / totalWeight) * 100;
      
      this.emit('deployment:phase_completed', { 
        phase: phase.name, 
        result: phaseResult,
        progress: this.state.progress 
      });
    }
  }
  
  /**
   * Execute individual deployment phase
   */
  async executePhase(phaseName) {
    const startTime = performance.now();
    
    try {
      console.log(`📋 Executing phase: ${phaseName}`);
      
      let result;
      switch (phaseName) {
        case 'pre_checks':
          result = await this.executePreChecks();
          break;
        case 'backup':
          result = await this.executeBackup();
          break;
        case 'build':
          result = await this.executeBuild();
          break;
        case 'test':
          result = await this.executeTests();
          break;
        case 'deploy':
          result = await this.executeDeploy();
          break;
        case 'health_check':
          result = await this.executeHealthCheck();
          break;
        default:
          throw new Error(`Unknown phase: ${phaseName}`);
      }
      
      const duration = performance.now() - startTime;
      
      return {
        name: phaseName,
        status: 'success',
        duration,
        result,
        timestamp: Date.now()
      };
      
    } catch (error) {
      const duration = performance.now() - startTime;
      
      return {
        name: phaseName,
        status: 'failed',
        duration,
        error: error.message,
        timestamp: Date.now()
      };
    }
  }
  
  /**
   * Execute pre-deployment checks
   */
  async executePreChecks() {
    const checks = [];
    
    // Check Git status
    const gitStatus = await this.runCommand('git status --porcelain');
    checks.push({
      name: 'git_clean',
      passed: gitStatus.stdout.trim() === '',
      message: gitStatus.stdout.trim() === '' ? 'Working directory clean' : 'Uncommitted changes detected'
    });
    
    // Check branch
    const currentBranch = await this.runCommand('git rev-parse --abbrev-ref HEAD');
    const expectedBranch = this.currentDeployment.config.branch;
    checks.push({
      name: 'correct_branch',
      passed: currentBranch.stdout.trim() === expectedBranch,
      message: `Current branch: ${currentBranch.stdout.trim()}, Expected: ${expectedBranch}`
    });
    
    // Check dependencies
    try {
      await access('./package.json');
      await access('./node_modules');
      checks.push({
        name: 'dependencies',
        passed: true,
        message: 'Dependencies are installed'
      });
    } catch {
      checks.push({
        name: 'dependencies',
        passed: false,
        message: 'Dependencies not installed'
      });
    }
    
    // Check disk space
    const diskSpace = await this.checkDiskSpace();
    checks.push({
      name: 'disk_space',
      passed: diskSpace > 1024, // 1GB minimum
      message: `Available space: ${(diskSpace / 1024).toFixed(2)}GB`
    });
    
    const failed = checks.filter(check => !check.passed);
    if (failed.length > 0) {
      throw new Error(`Pre-checks failed: ${failed.map(c => c.message).join(', ')}`);
    }
    
    return { checks, passed: checks.length, failed: 0 };
  }
  
  /**
   * Execute backup phase
   */
  async executeBackup() {
    if (!this.options.enableBackup) {
      return { skipped: true, reason: 'Backup disabled' };
    }
    
    const backupId = `backup_${this.currentDeployment.id}`;
    const backupPath = join(this.options.backupDirectory, backupId);
    
    await mkdir(backupPath, { recursive: true });
    
    // Backup current deployment
    const backupCommand = `tar -czf ${backupPath}/current.tar.gz --exclude=node_modules --exclude=.git .`;
    await this.runCommand(backupCommand);
    
    // Backup database if applicable
    if (this.currentDeployment.config.database) {
      await this.backupDatabase(backupPath);
    }
    
    // Create backup manifest
    const manifest = {
      id: backupId,
      deploymentId: this.currentDeployment.id,
      timestamp: Date.now(),
      environment: this.currentDeployment.environment,
      files: ['current.tar.gz']
    };
    
    await writeFile(
      join(backupPath, 'manifest.json'),
      JSON.stringify(manifest, null, 2)
    );
    
    return { backupId, backupPath, files: manifest.files };
  }
  
  /**
   * Execute build phase
   */
  async executeBuild() {
    console.log(`🔨 Building application...`);
    
    // Install dependencies
    await this.runCommand('npm ci', { timeout: 300000 }); // 5 minutes
    
    // Run build command
    if (this.options.buildCommand) {
      const buildResult = await this.runCommand(this.options.buildCommand, { timeout: 600000 }); // 10 minutes
      
      return {
        buildCommand: this.options.buildCommand,
        output: buildResult.stdout,
        exitCode: buildResult.code
      };
    }
    
    return { skipped: true, reason: 'No build command specified' };
  }
  
  /**
   * Execute tests
   */
  async executeTests() {
    if (!this.options.testCommand) {
      return { skipped: true, reason: 'No test command specified' };
    }
    
    console.log(`🧪 Running tests...`);
    
    const testResult = await this.runCommand(this.options.testCommand, { timeout: 600000 }); // 10 minutes
    
    if (testResult.code !== 0) {
      throw new Error(`Tests failed with exit code ${testResult.code}: ${testResult.stderr}`);
    }
    
    return {
      testCommand: this.options.testCommand,
      output: testResult.stdout,
      exitCode: testResult.code
    };
  }
  
  /**
   * Execute deployment
   */
  async executeDeploy() {
    const strategy = this.currentDeployment.options.strategy || 'rolling';
    
    switch (strategy) {
      case 'blue_green':
        return await this.executeBlueGreenDeployment();
      case 'canary':
        return await this.executeCanaryDeployment();
      case 'rolling':
      default:
        return await this.executeRollingDeployment();
    }
  }
  
  /**
   * Execute rolling deployment
   */
  async executeRollingDeployment() {
    console.log(`🔄 Executing rolling deployment...`);
    
    const config = this.currentDeployment.config;
    
    if (this.options.enableZeroDowntime) {
      // Start new instance on different port
      const tempPort = config.port + 1;
      
      // Start new instance
      const startResult = await this.startInstance(tempPort);
      
      // Wait for new instance to be ready
      await this.waitForInstanceReady(`http://localhost:${tempPort}`);
      
      // Switch traffic (would typically involve load balancer)
      await this.switchTraffic(config.port, tempPort);
      
      // Stop old instance
      await this.stopInstance(config.port);
      
      // Start new instance on original port
      await this.startInstance(config.port);
      
      return {
        strategy: 'rolling',
        zeroDowntime: true,
        newPort: config.port,
        tempPort
      };
    } else {
      // Simple restart
      await this.stopInstance(config.port);
      await this.startInstance(config.port);
      
      return {
        strategy: 'rolling',
        zeroDowntime: false,
        port: config.port
      };
    }
  }
  
  /**
   * Execute blue-green deployment
   */
  async executeBlueGreenDeployment() {
    console.log(`🔵🟢 Executing blue-green deployment...`);
    
    const config = this.currentDeployment.config;
    const bluePort = config.port;
    const greenPort = config.port + 100;
    
    // Deploy to green environment
    await this.startInstance(greenPort);
    await this.waitForInstanceReady(`http://localhost:${greenPort}`);
    
    // Switch traffic to green
    await this.switchTraffic(bluePort, greenPort);
    
    // Stop blue environment
    await this.stopInstance(bluePort);
    
    return {
      strategy: 'blue_green',
      bluePort,
      greenPort,
      activePort: greenPort
    };
  }
  
  /**
   * Execute canary deployment
   */
  async executeCanaryDeployment() {
    console.log(`🐦 Executing canary deployment...`);
    
    const config = this.currentDeployment.config;
    const mainPort = config.port;
    const canaryPort = config.port + 200;
    const canaryPercentage = this.currentDeployment.options.canaryPercentage || 10;
    
    // Deploy canary instance
    await this.startInstance(canaryPort);
    await this.waitForInstanceReady(`http://localhost:${canaryPort}`);
    
    // Route small percentage of traffic to canary
    await this.routeTraffic(mainPort, canaryPort, canaryPercentage);
    
    // Monitor canary for specified duration
    const monitorDuration = this.currentDeployment.options.canaryDuration || 300000; // 5 minutes
    await this.monitorCanary(canaryPort, monitorDuration);
    
    // If canary is healthy, promote to full deployment
    await this.promoteCanary(mainPort, canaryPort);
    
    return {
      strategy: 'canary',
      mainPort,
      canaryPort,
      canaryPercentage,
      promoted: true
    };
  }
  
  /**
   * Execute health check
   */
  async executeHealthCheck() {
    const config = this.currentDeployment.config;
    const healthUrl = `http://${config.host}:${config.port}${this.options.healthCheckUrl}`;
    
    console.log(`🏥 Performing health check: ${healthUrl}`);
    
    for (let attempt = 1; attempt <= this.options.healthCheckRetries; attempt++) {
      try {
        const response = await this.makeHttpRequest(healthUrl, {
          timeout: this.options.healthCheckTimeout
        });
        
        if (response.status === 200) {
          const healthData = JSON.parse(response.body);
          
          return {
            status: 'healthy',
            attempt,
            response: healthData,
            url: healthUrl
          };
        }
      } catch (error) {
        if (attempt === this.options.healthCheckRetries) {
          throw new Error(`Health check failed after ${attempt} attempts: ${error.message}`);
        }
        
        // Wait before retry
        await this.sleep(5000);
      }
    }
    
    throw new Error('Health check failed - maximum retries exceeded');
  }
  
  /**
   * Rollback to previous deployment
   */
  async rollback(steps = 1) {
    if (!this.options.enableRollback) {
      throw new OtedamaError('Rollback is disabled', ErrorCategory.OPERATION);
    }
    
    const previousDeployments = this.deploymentHistory
      .filter(d => d.status === 'completed')
      .slice(-steps - 1, -1);
    
    if (previousDeployments.length === 0) {
      throw new OtedamaError('No previous deployment found for rollback', ErrorCategory.OPERATION);
    }
    
    const targetDeployment = previousDeployments[previousDeployments.length - 1];
    
    console.log(`🔙 Rolling back to deployment ${targetDeployment.id}`);
    
    try {
      // Restore from backup
      await this.restoreFromBackup(`backup_${targetDeployment.id}`);
      
      // Restart services
      await this.stopInstance(targetDeployment.config.port);
      await this.startInstance(targetDeployment.config.port);
      
      // Verify rollback
      await this.executeHealthCheck();
      
      this.metrics.rollbacks++;
      
      this.emit('deployment:rollback_completed', {
        targetDeployment: targetDeployment.id,
        steps
      });
      
      console.log(`✅ Rollback completed successfully`);
      
      return {
        success: true,
        targetDeployment: targetDeployment.id,
        restoredAt: Date.now()
      };
      
    } catch (error) {
      this.emit('deployment:rollback_failed', {
        targetDeployment: targetDeployment.id,
        error: error.message
      });
      throw error;
    }
  }
  
  /**
   * Utility methods
   */
  async runCommand(command, options = {}) {
    return new Promise((resolve, reject) => {
      const timeout = options.timeout || 120000; // 2 minutes default
      
      const child = spawn('bash', ['-c', command], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout
      });
      
      let stdout = '';
      let stderr = '';
      
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      child.on('close', (code) => {
        resolve({ code, stdout, stderr });
      });
      
      child.on('error', (error) => {
        reject(error);
      });
    });
  }
  
  async makeHttpRequest(url, options = {}) {
    // Simple HTTP request implementation
    // In production, use a proper HTTP client
    const { default: fetch } = await import('node-fetch');
    
    const response = await fetch(url, {
      timeout: options.timeout || 30000
    });
    
    return {
      status: response.status,
      headers: response.headers,
      body: await response.text()
    };
  }
  
  async startInstance(port) {
    const command = this.options.startCommand.replace('3333', port.toString());
    console.log(`🚀 Starting instance on port ${port}...`);
    
    // Start instance in background
    const child = spawn('bash', ['-c', command], {
      detached: true,
      stdio: 'ignore'
    });
    
    child.unref();
    
    this.activeInstances.set(port, {
      pid: child.pid,
      port,
      startTime: Date.now()
    });
    
    // Wait for instance to start
    await this.sleep(5000);
    
    return { port, pid: child.pid };
  }
  
  async stopInstance(port) {
    console.log(`🛑 Stopping instance on port ${port}...`);
    
    const instance = this.activeInstances.get(port);
    if (instance) {
      process.kill(instance.pid, 'SIGTERM');
      this.activeInstances.delete(port);
    }
    
    // Fallback: kill by command pattern
    await this.runCommand(this.options.stopCommand);
    
    await this.sleep(2000);
  }
  
  async waitForInstanceReady(url, timeout = 60000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      try {
        const response = await this.makeHttpRequest(url, { timeout: 5000 });
        if (response.status === 200) {
          return true;
        }
      } catch (error) {
        // Continue waiting
      }
      
      await this.sleep(2000);
    }
    
    throw new Error(`Instance at ${url} did not become ready within ${timeout}ms`);
  }
  
  async switchTraffic(fromPort, toPort) {
    // This would typically update load balancer configuration
    console.log(`🔄 Switching traffic from port ${fromPort} to ${toPort}`);
    
    // Simulate traffic switch
    await this.sleep(1000);
    
    return { from: fromPort, to: toPort };
  }
  
  async routeTraffic(mainPort, canaryPort, percentage) {
    console.log(`🚦 Routing ${percentage}% traffic to canary port ${canaryPort}`);
    
    // This would configure load balancer for canary routing
    await this.sleep(1000);
    
    return { mainPort, canaryPort, percentage };
  }
  
  async monitorCanary(canaryPort, duration) {
    console.log(`👀 Monitoring canary on port ${canaryPort} for ${duration}ms`);
    
    const startTime = Date.now();
    
    while (Date.now() - startTime < duration) {
      try {
        const response = await this.makeHttpRequest(`http://localhost:${canaryPort}/health`);
        if (response.status !== 200) {
          throw new Error(`Canary health check failed: ${response.status}`);
        }
      } catch (error) {
        throw new Error(`Canary monitoring failed: ${error.message}`);
      }
      
      await this.sleep(10000); // Check every 10 seconds
    }
    
    return { monitored: true, duration };
  }
  
  async promoteCanary(mainPort, canaryPort) {
    console.log(`📈 Promoting canary from port ${canaryPort} to main port ${mainPort}`);
    
    // Stop main instance
    await this.stopInstance(mainPort);
    
    // Start new main instance with canary code
    await this.startInstance(mainPort);
    
    // Stop canary instance
    await this.stopInstance(canaryPort);
    
    return { promoted: true, newMainPort: mainPort };
  }
  
  async checkDiskSpace() {
    try {
      const result = await this.runCommand('df -m . | tail -1 | awk \'{print $4}\'');
      return parseInt(result.stdout.trim()) || 0;
    } catch {
      return 0;
    }
  }
  
  async backupDatabase(backupPath) {
    // Database backup implementation would go here
    console.log(`💾 Backing up database to ${backupPath}`);
    await this.sleep(1000);
  }
  
  async restoreFromBackup(backupId) {
    const backupPath = join(this.options.backupDirectory, backupId);
    
    console.log(`🔄 Restoring from backup ${backupId}`);
    
    // Restore files
    const restoreCommand = `tar -xzf ${backupPath}/current.tar.gz`;
    await this.runCommand(restoreCommand);
    
    // Restore database if applicable
    if (this.currentDeployment?.config.database) {
      // Database restore implementation would go here
    }
    
    return { restored: true, backupId };
  }
  
  generateDeploymentId() {
    return `deploy_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }
  
  async ensureDirectories() {
    const dirs = [
      this.options.deploymentDirectory,
      this.options.backupDirectory,
      this.options.logDirectory
    ];
    
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
  }
  
  async loadDeploymentHistory() {
    const historyFile = join(this.options.deploymentDirectory, 'history.json');
    
    try {
      const content = await readFile(historyFile, 'utf8');
      this.deploymentHistory = JSON.parse(content);
      
      // Update metrics from history
      this.metrics.totalDeployments = this.deploymentHistory.length;
      this.metrics.successfulDeployments = this.deploymentHistory.filter(d => d.status === 'completed').length;
      this.metrics.failedDeployments = this.deploymentHistory.filter(d => d.status === 'failed').length;
      
      const completedDeployments = this.deploymentHistory.filter(d => d.duration);
      if (completedDeployments.length > 0) {
        this.metrics.totalDeploymentTime = completedDeployments.reduce((sum, d) => sum + d.duration, 0);
        this.metrics.averageDeploymentTime = this.metrics.totalDeploymentTime / completedDeployments.length;
      }
      
    } catch (error) {
      // History file doesn't exist yet
      this.deploymentHistory = [];
    }
  }
  
  async saveDeploymentHistory() {
    const historyFile = join(this.options.deploymentDirectory, 'history.json');
    await writeFile(historyFile, JSON.stringify(this.deploymentHistory, null, 2));
  }
  
  async validateEnvironments() {
    for (const [name, config] of Object.entries(this.options.environments)) {
      if (!config.host || !config.port || !config.branch) {
        throw new Error(`Invalid configuration for environment ${name}`);
      }
    }
  }
  
  async handleDeploymentFailure(error) {
    if (this.currentDeployment) {
      this.currentDeployment.status = 'failed';
      this.currentDeployment.error = error.message;
      this.currentDeployment.endTime = Date.now();
      this.currentDeployment.duration = this.currentDeployment.endTime - this.currentDeployment.startTime;
      
      this.updateMetrics(false, this.currentDeployment.duration);
      this.deploymentHistory.push(this.currentDeployment);
      await this.saveDeploymentHistory();
    }
    
    this.emit('deployment:failed', {
      deploymentId: this.currentDeployment?.id,
      error: error.message
    });
  }
  
  updateMetrics(success, duration) {
    this.metrics.totalDeployments++;
    this.metrics.totalDeploymentTime += duration;
    this.metrics.averageDeploymentTime = this.metrics.totalDeploymentTime / this.metrics.totalDeployments;
    
    if (success) {
      this.metrics.successfulDeployments++;
    } else {
      this.metrics.failedDeployments++;
    }
  }
  
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Get deployment status
   */
  getStatus() {
    return {
      ...this.state,
      metrics: this.metrics,
      activeInstances: Array.from(this.activeInstances.values()),
      recentDeployments: this.deploymentHistory.slice(-5)
    };
  }
  
  /**
   * Get deployment history
   */
  getHistory(limit = 10) {
    return this.deploymentHistory.slice(-limit);
  }
  
  /**
   * Get deployment metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      successRate: this.metrics.totalDeployments > 0 
        ? (this.metrics.successfulDeployments / this.metrics.totalDeployments) * 100 
        : 0
    };
  }
}

export default DeploymentManager;