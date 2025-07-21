/**
 * Deployment Orchestrator for Otedama
 * Coordinates deployments across multiple services
 * 
 * Design principles:
 * - Carmack: Efficient deployment coordination
 * - Martin: Clean orchestration patterns
 * - Pike: Simple deployment workflows
 */

import { EventEmitter } from 'events';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../core/logger.js';
import { ZeroDowntimeDeployment, DeploymentStrategy } from './zero-downtime.js';

const execAsync = promisify(exec);

/**
 * Deployment stages
 */
export const DeploymentStage = {
  PRE_DEPLOYMENT: 'pre_deployment',
  BUILD: 'build',
  TEST: 'test',
  BACKUP: 'backup',
  DATABASE_MIGRATION: 'database_migration',
  DEPLOY_SERVICES: 'deploy_services',
  POST_DEPLOYMENT: 'post_deployment',
  VERIFICATION: 'verification',
  CLEANUP: 'cleanup'
};

/**
 * Service dependencies
 */
export class ServiceDependencyGraph {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
  }
  
  addService(service) {
    this.nodes.set(service.name, service);
    if (!this.edges.has(service.name)) {
      this.edges.set(service.name, new Set());
    }
  }
  
  addDependency(service, dependsOn) {
    this.edges.get(service).add(dependsOn);
  }
  
  getDeploymentOrder() {
    const visited = new Set();
    const order = [];
    
    const visit = (node) => {
      if (visited.has(node)) return;
      visited.add(node);
      
      const dependencies = this.edges.get(node) || new Set();
      for (const dep of dependencies) {
        visit(dep);
      }
      
      order.push(node);
    };
    
    for (const node of this.nodes.keys()) {
      visit(node);
    }
    
    return order;
  }
}

/**
 * Deployment orchestrator
 */
export class DeploymentOrchestrator extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Configuration
      configFile: options.configFile || './deployment.config.json',
      
      // Build settings
      build: {
        command: options.build?.command || 'npm run build',
        timeout: options.build?.timeout || 300000, // 5 minutes
        parallel: options.build?.parallel !== false
      },
      
      // Test settings
      test: {
        command: options.test?.command || 'npm test',
        timeout: options.test?.timeout || 600000, // 10 minutes
        required: options.test?.required !== false
      },
      
      // Backup settings
      backup: {
        enabled: options.backup?.enabled !== false,
        command: options.backup?.command || 'npm run backup',
        retention: options.backup?.retention || 5
      },
      
      // Migration settings
      migration: {
        enabled: options.migration?.enabled !== false,
        command: options.migration?.command || 'npm run migrate',
        rollbackCommand: options.migration?.rollbackCommand || 'npm run migrate:rollback'
      },
      
      // Deployment settings
      deployment: {
        strategy: options.deployment?.strategy || DeploymentStrategy.BLUE_GREEN,
        parallel: options.deployment?.parallel !== false,
        timeout: options.deployment?.timeout || 900000 // 15 minutes
      },
      
      // Verification settings
      verification: {
        enabled: options.verification?.enabled !== false,
        tests: options.verification?.tests || [],
        timeout: options.verification?.timeout || 300000 // 5 minutes
      },
      
      // Notification settings
      notifications: {
        enabled: options.notifications?.enabled !== false,
        channels: options.notifications?.channels || []
      },
      
      ...options
    };
    
    // State
    this.deploymentConfig = null;
    this.services = new Map();
    this.deploymentSystems = new Map();
    this.currentDeployment = null;
    
    // Metrics
    this.metrics = {
      totalDeployments: 0,
      successfulDeployments: 0,
      failedDeployments: 0,
      averageDeploymentTime: 0
    };
  }
  
  /**
   * Initialize orchestrator
   */
  async initialize() {
    logger.info('Initializing deployment orchestrator');
    
    // Load configuration
    await this.loadConfiguration();
    
    // Initialize deployment systems
    await this._initializeDeploymentSystems();
    
    this.emit('initialized');
  }
  
  /**
   * Load deployment configuration
   */
  async loadConfiguration() {
    try {
      const configData = await readFile(this.options.configFile, 'utf8');
      this.deploymentConfig = JSON.parse(configData);
      
      // Validate configuration
      this._validateConfiguration();
      
      logger.info('Deployment configuration loaded');
      
    } catch (error) {
      logger.error('Failed to load deployment configuration:', error);
      throw error;
    }
  }
  
  /**
   * Execute deployment
   */
  async deploy(version, options = {}) {
    if (this.currentDeployment) {
      throw new Error('Deployment already in progress');
    }
    
    const deploymentId = `deployment-${Date.now()}`;
    const startTime = Date.now();
    
    this.currentDeployment = {
      id: deploymentId,
      version,
      startTime,
      status: 'in_progress',
      stages: {},
      errors: []
    };
    
    logger.info(`Starting deployment ${deploymentId} for version ${version}`);
    
    this.emit('deployment:started', {
      id: deploymentId,
      version
    });
    
    try {
      // Execute deployment stages with optimized parallelization
      // Phase 1: Independent initialization stages
      await Promise.all([
        this._executeStage(DeploymentStage.PRE_DEPLOYMENT),
        this._executeStage(DeploymentStage.BUILD)
      ]);
      
      // Phase 2: Testing and backup (can run in parallel after build)
      await Promise.all([
        this._executeStage(DeploymentStage.TEST),
        this._executeStage(DeploymentStage.BACKUP)
      ]);
      
      // Phase 3: Database changes (must be sequential)
      await this._executeStage(DeploymentStage.DATABASE_MIGRATION);
      
      // Phase 4: Service deployment
      await this._executeStage(DeploymentStage.DEPLOY_SERVICES);
      
      // Phase 5: Post-deployment verification (can run in parallel)
      await Promise.all([
        this._executeStage(DeploymentStage.POST_DEPLOYMENT),
        this._executeStage(DeploymentStage.VERIFICATION)
      ]);
      
      // Phase 6: Final cleanup
      await this._executeStage(DeploymentStage.CLEANUP);
      
      // Update metrics
      const deploymentTime = Date.now() - startTime;
      this.metrics.totalDeployments++;
      this.metrics.successfulDeployments++;
      this.metrics.averageDeploymentTime = 
        (this.metrics.averageDeploymentTime * (this.metrics.totalDeployments - 1) + deploymentTime) / 
        this.metrics.totalDeployments;
      
      this.currentDeployment.status = 'completed';
      this.currentDeployment.endTime = Date.now();
      
      // Send notifications
      await this._sendNotification('success', {
        deployment: this.currentDeployment,
        duration: deploymentTime
      });
      
      this.emit('deployment:completed', {
        id: deploymentId,
        version,
        duration: deploymentTime
      });
      
      logger.info(`Deployment ${deploymentId} completed successfully`);
      
      return this.currentDeployment;
      
    } catch (error) {
      this.metrics.failedDeployments++;
      this.currentDeployment.status = 'failed';
      this.currentDeployment.error = error.message;
      
      logger.error(`Deployment ${deploymentId} failed:`, error);
      
      // Send notifications
      await this._sendNotification('failure', {
        deployment: this.currentDeployment,
        error: error.message
      });
      
      this.emit('deployment:failed', {
        id: deploymentId,
        version,
        error: error.message
      });
      
      // Rollback if needed
      await this.rollback();
      
      throw error;
      
    } finally {
      // Save deployment history
      await this._saveDeploymentHistory();
      
      this.currentDeployment = null;
    }
  }
  
  /**
   * Execute deployment stage
   */
  async _executeStage(stage) {
    logger.info(`Executing stage: ${stage}`);
    
    const stageStartTime = Date.now();
    
    this.currentDeployment.stages[stage] = {
      status: 'in_progress',
      startTime: stageStartTime
    };
    
    this.emit('stage:started', {
      deployment: this.currentDeployment.id,
      stage
    });
    
    try {
      switch (stage) {
        case DeploymentStage.PRE_DEPLOYMENT:
          await this._executePreDeployment();
          break;
          
        case DeploymentStage.BUILD:
          await this._executeBuild();
          break;
          
        case DeploymentStage.TEST:
          await this._executeTests();
          break;
          
        case DeploymentStage.BACKUP:
          await this._executeBackup();
          break;
          
        case DeploymentStage.DATABASE_MIGRATION:
          await this._executeMigration();
          break;
          
        case DeploymentStage.DEPLOY_SERVICES:
          await this._deployServices();
          break;
          
        case DeploymentStage.POST_DEPLOYMENT:
          await this._executePostDeployment();
          break;
          
        case DeploymentStage.VERIFICATION:
          await this._executeVerification();
          break;
          
        case DeploymentStage.CLEANUP:
          await this._executeCleanup();
          break;
      }
      
      this.currentDeployment.stages[stage].status = 'completed';
      this.currentDeployment.stages[stage].duration = Date.now() - stageStartTime;
      
      this.emit('stage:completed', {
        deployment: this.currentDeployment.id,
        stage,
        duration: this.currentDeployment.stages[stage].duration
      });
      
    } catch (error) {
      this.currentDeployment.stages[stage].status = 'failed';
      this.currentDeployment.stages[stage].error = error.message;
      this.currentDeployment.errors.push({
        stage,
        error: error.message,
        timestamp: Date.now()
      });
      
      this.emit('stage:failed', {
        deployment: this.currentDeployment.id,
        stage,
        error: error.message
      });
      
      throw error;
    }
  }
  
  /**
   * Pre-deployment stage
   */
  async _executePreDeployment() {
    const hooks = this.deploymentConfig.hooks?.preDeployment || [];
    
    for (const hook of hooks) {
      logger.info(`Executing pre-deployment hook: ${hook.name}`);
      
      if (hook.type === 'command') {
        await execAsync(hook.command, {
          timeout: hook.timeout || 60000
        });
      } else if (hook.type === 'function') {
        await hook.execute();
      }
    }
  }
  
  /**
   * Build stage
   */
  async _executeBuild() {
    const services = this._getServicesForStage('build');
    
    if (this.options.build.parallel) {
      // Build in parallel
      const buildPromises = services.map(service => 
        this._buildService(service)
      );
      
      await Promise.all(buildPromises);
    } else {
      // Build sequentially
      for (const service of services) {
        await this._buildService(service);
      }
    }
  }
  
  /**
   * Build service
   */
  async _buildService(service) {
    logger.info(`Building service: ${service.name}`);
    
    const buildCommand = service.build?.command || this.options.build.command;
    
    const { stdout, stderr } = await execAsync(buildCommand, {
      cwd: service.path,
      timeout: this.options.build.timeout
    });
    
    if (stdout) logger.debug(`[${service.name}] Build output:`, stdout);
    if (stderr) logger.warn(`[${service.name}] Build warnings:`, stderr);
  }
  
  /**
   * Test stage
   */
  async _executeTests() {
    if (!this.options.test.required) {
      logger.info('Tests skipped (not required)');
      return;
    }
    
    const services = this._getServicesForStage('test');
    
    for (const service of services) {
      logger.info(`Running tests for service: ${service.name}`);
      
      const testCommand = service.test?.command || this.options.test.command;
      
      try {
        const { stdout } = await execAsync(testCommand, {
          cwd: service.path,
          timeout: this.options.test.timeout
        });
        
        logger.debug(`[${service.name}] Test output:`, stdout);
      } catch (error) {
        if (this.options.test.required) {
          throw new Error(`Tests failed for ${service.name}: ${error.message}`);
        } else {
          logger.warn(`Tests failed for ${service.name} (continuing):`, error.message);
        }
      }
    }
  }
  
  /**
   * Backup stage
   */
  async _executeBackup() {
    if (!this.options.backup.enabled) {
      logger.info('Backup skipped (disabled)');
      return;
    }
    
    logger.info('Creating backup');
    
    const backupCommand = this.deploymentConfig.backup?.command || this.options.backup.command;
    
    const { stdout } = await execAsync(backupCommand, {
      timeout: 300000 // 5 minutes
    });
    
    this.currentDeployment.backupId = stdout.trim();
    
    logger.info(`Backup created: ${this.currentDeployment.backupId}`);
  }
  
  /**
   * Migration stage
   */
  async _executeMigration() {
    if (!this.options.migration.enabled) {
      logger.info('Migration skipped (disabled)');
      return;
    }
    
    const migrations = this.deploymentConfig.migrations || [];
    
    for (const migration of migrations) {
      logger.info(`Running migration: ${migration.name}`);
      
      try {
        await execAsync(migration.command || this.options.migration.command, {
          timeout: 300000 // 5 minutes
        });
        
        this.currentDeployment.migrations = this.currentDeployment.migrations || [];
        this.currentDeployment.migrations.push({
          name: migration.name,
          status: 'completed'
        });
        
      } catch (error) {
        throw new Error(`Migration failed: ${migration.name} - ${error.message}`);
      }
    }
  }
  
  /**
   * Deploy services stage
   */
  async _deployServices() {
    const dependencyGraph = this._buildDependencyGraph();
    const deploymentOrder = dependencyGraph.getDeploymentOrder();
    
    logger.info(`Deploying services in order: ${deploymentOrder.join(', ')}`);
    
    for (const serviceName of deploymentOrder) {
      const service = this.services.get(serviceName);
      if (!service || !service.deploy) continue;
      
      await this._deployService(service);
    }
  }
  
  /**
   * Deploy service
   */
  async _deployService(service) {
    logger.info(`Deploying service: ${service.name}`);
    
    const deploymentSystem = this.deploymentSystems.get(service.name);
    if (!deploymentSystem) {
      throw new Error(`No deployment system for service: ${service.name}`);
    }
    
    await deploymentSystem.deploy(this.currentDeployment.version, {
      env: {
        VERSION: this.currentDeployment.version,
        DEPLOYMENT_ID: this.currentDeployment.id
      }
    });
  }
  
  /**
   * Post-deployment stage
   */
  async _executePostDeployment() {
    const hooks = this.deploymentConfig.hooks?.postDeployment || [];
    
    for (const hook of hooks) {
      logger.info(`Executing post-deployment hook: ${hook.name}`);
      
      if (hook.type === 'command') {
        await execAsync(hook.command, {
          timeout: hook.timeout || 60000
        });
      } else if (hook.type === 'function') {
        await hook.execute();
      }
    }
  }
  
  /**
   * Verification stage
   */
  async _executeVerification() {
    if (!this.options.verification.enabled) {
      logger.info('Verification skipped (disabled)');
      return;
    }
    
    const tests = this.options.verification.tests;
    
    for (let i = 0; i < tests.length; i++) {
      logger.info(`Running verification test ${i + 1}/${tests.length}`);
      
      try {
        await tests[i]({
          deployment: this.currentDeployment,
          services: this.services
        });
      } catch (error) {
        throw new Error(`Verification test ${i + 1} failed: ${error.message}`);
      }
    }
    
    logger.info('All verification tests passed');
  }
  
  /**
   * Cleanup stage
   */
  async _executeCleanup() {
    logger.info('Performing cleanup');
    
    // Clean old deployments
    await this._cleanOldDeployments();
    
    // Clean old backups
    await this._cleanOldBackups();
    
    // Run cleanup hooks
    const hooks = this.deploymentConfig.hooks?.cleanup || [];
    
    for (const hook of hooks) {
      try {
        if (hook.type === 'command') {
          await execAsync(hook.command, { timeout: 60000 });
        }
      } catch (error) {
        logger.warn(`Cleanup hook failed: ${hook.name}`, error);
      }
    }
  }
  
  /**
   * Rollback deployment
   */
  async rollback() {
    logger.info('Starting rollback');
    
    this.emit('rollback:started', {
      deployment: this.currentDeployment?.id
    });
    
    try {
      // Rollback services
      for (const deploymentSystem of this.deploymentSystems.values()) {
        try {
          await deploymentSystem.rollback();
        } catch (error) {
          logger.error(`Service rollback failed:`, error);
        }
      }
      
      // Rollback migrations
      if (this.currentDeployment?.migrations) {
        for (const migration of this.currentDeployment.migrations.reverse()) {
          try {
            await execAsync(this.options.migration.rollbackCommand);
          } catch (error) {
            logger.error(`Migration rollback failed: ${migration.name}`, error);
          }
        }
      }
      
      // Restore backup if available
      if (this.currentDeployment?.backupId) {
        try {
          await execAsync(`npm run restore -- ${this.currentDeployment.backupId}`);
        } catch (error) {
          logger.error('Backup restore failed:', error);
        }
      }
      
      this.emit('rollback:completed');
      
    } catch (error) {
      logger.error('Rollback failed:', error);
      
      this.emit('rollback:failed', {
        error: error.message
      });
      
      throw error;
    }
  }
  
  /**
   * Initialize deployment systems
   */
  async _initializeDeploymentSystems() {
    for (const service of this.deploymentConfig.services) {
      this.services.set(service.name, service);
      
      if (service.deploy) {
        const deploymentSystem = new ZeroDowntimeDeployment({
          serviceConfig: {
            command: service.deploy.command,
            args: service.deploy.args,
            cwd: service.path,
            healthPath: service.deploy.healthPath,
            ports: service.deploy.ports
          },
          strategy: service.deploy.strategy || this.options.deployment.strategy
        });
        
        await deploymentSystem.initialize();
        
        this.deploymentSystems.set(service.name, deploymentSystem);
      }
    }
  }
  
  /**
   * Validate configuration
   */
  _validateConfiguration() {
    if (!this.deploymentConfig.services || this.deploymentConfig.services.length === 0) {
      throw new Error('No services defined in deployment configuration');
    }
    
    for (const service of this.deploymentConfig.services) {
      if (!service.name) {
        throw new Error('Service missing name');
      }
      
      if (!service.path) {
        throw new Error(`Service ${service.name} missing path`);
      }
    }
  }
  
  /**
   * Get services for stage
   */
  _getServicesForStage(stage) {
    return this.deploymentConfig.services.filter(service => {
      if (!service[stage]) return false;
      if (service[stage].enabled === false) return false;
      return true;
    });
  }
  
  /**
   * Build dependency graph
   */
  _buildDependencyGraph() {
    const graph = new ServiceDependencyGraph();
    
    for (const service of this.deploymentConfig.services) {
      graph.addService(service);
      
      if (service.dependencies) {
        for (const dep of service.dependencies) {
          graph.addDependency(service.name, dep);
        }
      }
    }
    
    return graph;
  }
  
  /**
   * Send notification
   */
  async _sendNotification(type, data) {
    if (!this.options.notifications.enabled) return;
    
    for (const channel of this.options.notifications.channels) {
      try {
        await channel.send(type, data);
      } catch (error) {
        logger.error(`Notification failed for channel ${channel.name}:`, error);
      }
    }
  }
  
  /**
   * Save deployment history
   */
  async _saveDeploymentHistory() {
    const historyFile = join(
      this.deploymentConfig.historyDir || './deployments',
      `${this.currentDeployment.id}.json`
    );
    
    await writeFile(historyFile, JSON.stringify(this.currentDeployment, null, 2));
  }
  
  /**
   * Clean old deployments
   */
  async _cleanOldDeployments() {
    // Implementation depends on deployment strategy
    logger.info('Cleaning old deployments');
  }
  
  /**
   * Clean old backups
   */
  async _cleanOldBackups() {
    if (!this.options.backup.enabled) return;
    
    logger.info(`Cleaning backups older than ${this.options.backup.retention} days`);
    
    // Implementation depends on backup strategy
  }
  
  /**
   * Get deployment status
   */
  getStatus() {
    const status = {
      current: this.currentDeployment,
      services: {},
      metrics: this.metrics
    };
    
    for (const [name, deploymentSystem] of this.deploymentSystems) {
      status.services[name] = deploymentSystem.getStatus();
    }
    
    return status;
  }
  
  /**
   * Shutdown orchestrator
   */
  async shutdown() {
    logger.info('Shutting down deployment orchestrator');
    
    for (const deploymentSystem of this.deploymentSystems.values()) {
      await deploymentSystem.shutdown();
    }
    
    this.emit('shutdown');
  }
}

export default DeploymentOrchestrator;