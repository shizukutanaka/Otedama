/**
 * Unified Disaster Recovery System - Otedama
 * Enterprise-grade disaster recovery with multi-region failover and automatic healing
 * 
 * Design principles:
 * - Carmack: Zero-downtime recovery with minimal data loss
 * - Martin: Clean separation of recovery strategies
 * - Pike: Simple API for complex recovery scenarios
 * 
 * Consolidates:
 * - Multi-region failover (disaster-recovery.js)
 * - Component health monitoring (fault-recovery.js)
 * - Backup strategies (backup-recovery.js, automatic-backup-system.js)
 * - Error recovery (enhanced-error-recovery.js)
 */

import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import tar from 'tar';
import cron from 'node-cron';
import { createStructuredLogger } from '../core/structured-logger.js';
import { HAClusterNode } from '../cluster/high-availability-cluster.js';
import { createConnection } from 'net';
import { WebSocketServer } from 'ws';
import Redis from 'ioredis';

const logger = createStructuredLogger('UnifiedDisasterRecovery');
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * Recovery modes
 */
export const RecoveryMode = {
  HOT_STANDBY: 'hot_standby',        // Active-active with instant failover
  WARM_STANDBY: 'warm_standby',      // Active-passive with quick failover  
  COLD_STANDBY: 'cold_standby',      // Backup only, manual failover
  ACTIVE_ACTIVE: 'active_active',    // Multi-region active
  CONTINUOUS: 'continuous'           // Real-time replication
};

/**
 * Recovery states
 */
export const RecoveryState = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  FAILING_OVER: 'failing_over',
  FAILED: 'failed',
  RECOVERING: 'recovering',
  MAINTENANCE: 'maintenance'
};

/**
 * Backup strategies
 */
export const BackupStrategy = {
  FULL: 'full',                      // Complete state backup
  INCREMENTAL: 'incremental',        // Changes since last backup
  DIFFERENTIAL: 'differential',      // Changes since last full backup
  SNAPSHOT: 'snapshot',              // Point-in-time snapshot
  CONTINUOUS: 'continuous'           // Real-time replication
};

/**
 * Recovery strategies
 */
export const RecoveryStrategy = {
  RESTART_COMPONENT: 'restart_component',
  FALLBACK_MODE: 'fallback_mode',
  CIRCUIT_BREAKER: 'circuit_breaker',
  RETRY_WITH_BACKOFF: 'retry_with_backoff',
  GRACEFUL_DEGRADATION: 'graceful_degradation',
  FAIL_FAST: 'fail_fast',
  REGION_FAILOVER: 'region_failover'
};

/**
 * Component health status
 */
export const ComponentHealth = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
  FAILED: 'failed'
};

/**
 * Region configuration
 */
class Region {
  constructor(name, config) {
    this.name = name;
    this.primary = config.primary || false;
    this.endpoint = config.endpoint;
    this.priority = config.priority || 100;
    this.healthCheckUrl = config.healthCheckUrl;
    this.dataCenter = config.dataCenter;
    this.lastHealthCheck = 0;
    this.healthy = true;
    this.latency = 0;
    this.failureCount = 0;
    this.capacity = config.capacity || {};
    this.resources = {
      cpu: 0,
      memory: 0,
      storage: 0,
      connections: 0
    };
  }

  async checkHealth(timeout = 5000) {
    const startTime = Date.now();
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      
      const response = await fetch(this.healthCheckUrl, {
        signal: controller.signal,
        headers: {
          'X-Health-Check': 'true',
          'X-Region': this.name
        }
      });
      
      clearTimeout(timeoutId);
      
      this.latency = Date.now() - startTime;
      this.lastHealthCheck = Date.now();
      
      if (response.ok) {
        const data = await response.json();
        this.healthy = true;
        this.failureCount = 0;
        this.resources = data.resources || this.resources;
        
        return {
          healthy: true,
          latency: this.latency,
          resources: this.resources,
          details: data
        };
      } else {
        throw new Error(`Health check failed: ${response.status}`);
      }
    } catch (error) {
      this.failureCount++;
      
      if (this.failureCount >= 3) {
        this.healthy = false;
      }
      
      return {
        healthy: false,
        latency: Date.now() - startTime,
        error: error.message,
        failureCount: this.failureCount
      };
    }
  }
}

/**
 * Component monitor
 */
class ComponentMonitor {
  constructor(name, config = {}) {
    this.name = name;
    this.type = config.type || 'service';
    this.critical = config.critical || false;
    this.healthCheck = config.healthCheck;
    this.restartCommand = config.restartCommand;
    this.dependencies = config.dependencies || [];
    
    this.health = ComponentHealth.HEALTHY;
    this.lastCheck = 0;
    this.failureCount = 0;
    this.restartCount = 0;
    this.metrics = {
      cpu: 0,
      memory: 0,
      responseTime: 0,
      errorRate: 0
    };
  }

  async check() {
    if (!this.healthCheck) return { healthy: true };
    
    try {
      const startTime = Date.now();
      const result = await this.healthCheck();
      
      this.metrics.responseTime = Date.now() - startTime;
      this.lastCheck = Date.now();
      
      if (result.healthy) {
        this.health = ComponentHealth.HEALTHY;
        this.failureCount = 0;
        Object.assign(this.metrics, result.metrics || {});
      } else {
        this.failureCount++;
        this.health = this.failureCount >= 3 ? 
          ComponentHealth.FAILED : ComponentHealth.DEGRADED;
      }
      
      return result;
    } catch (error) {
      this.failureCount++;
      this.health = ComponentHealth.FAILED;
      
      return {
        healthy: false,
        error: error.message,
        failureCount: this.failureCount
      };
    }
  }

  async restart() {
    if (!this.restartCommand) {
      throw new Error(`No restart command for component: ${this.name}`);
    }
    
    this.restartCount++;
    await this.restartCommand();
    this.health = ComponentHealth.HEALTHY;
    this.failureCount = 0;
  }
}

/**
 * Backup manager
 */
class BackupManager extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      backupPath: config.backupPath || './backups',
      s3Config: config.s3Config,
      compression: config.compression !== false,
      encryption: config.encryption !== false,
      encryptionKey: config.encryptionKey || randomBytes(32),
      retentionDays: config.retentionDays || 30,
      maxBackups: config.maxBackups || 100,
      ...config
    };
    
    this.s3Client = this.config.s3Config ? 
      new S3Client(this.config.s3Config) : null;
    
    this.backupHistory = [];
    this.lastBackup = null;
    this.backupInProgress = false;
  }

  async performBackup(data, options = {}) {
    if (this.backupInProgress) {
      throw new Error('Backup already in progress');
    }
    
    this.backupInProgress = true;
    const backupId = this.generateBackupId();
    const strategy = options.strategy || BackupStrategy.FULL;
    
    try {
      logger.info('Starting backup', { backupId, strategy });
      
      // Prepare backup data
      const backupData = {
        id: backupId,
        timestamp: Date.now(),
        strategy,
        version: '1.1.6',
        data,
        metadata: {
          ...options.metadata,
          checksum: this.calculateChecksum(data)
        }
      };
      
      // Compress if enabled
      let processedData = JSON.stringify(backupData);
      if (this.config.compression) {
        processedData = await gzip(processedData);
      }
      
      // Save locally
      const localPath = path.join(
        this.config.backupPath,
        `backup-${backupId}.${this.config.compression ? 'gz' : 'json'}`
      );
      
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, processedData);
      
      // Save to S3 if configured
      if (this.s3Client) {
        await this.saveToS3(backupId, processedData);
      }
      
      // Update history
      this.backupHistory.push({
        id: backupId,
        timestamp: backupData.timestamp,
        strategy,
        size: processedData.length,
        location: {
          local: localPath,
          s3: this.s3Client ? `s3://${this.config.s3Config.bucket}/backups/${backupId}` : null
        }
      });
      
      this.lastBackup = backupData;
      
      // Clean old backups
      await this.cleanOldBackups();
      
      this.emit('backup:completed', {
        backupId,
        size: processedData.length,
        strategy
      });
      
      return backupId;
      
    } catch (error) {
      logger.error('Backup failed', { error, backupId });
      this.emit('backup:failed', { error: error.message, backupId });
      throw error;
    } finally {
      this.backupInProgress = false;
    }
  }

  async saveToS3(backupId, data) {
    const key = `backups/${backupId}`;
    
    const command = new PutObjectCommand({
      Bucket: this.config.s3Config.bucket,
      Key: key,
      Body: data,
      ContentType: this.config.compression ? 
        'application/gzip' : 'application/json',
      Metadata: {
        backupId,
        timestamp: Date.now().toString(),
        version: '1.1.6'
      }
    });
    
    await this.s3Client.send(command);
  }

  async restore(backupId, options = {}) {
    logger.info('Starting restore', { backupId });
    
    try {
      // Try local first
      let backupData = await this.loadLocalBackup(backupId);
      
      // Try S3 if local not found
      if (!backupData && this.s3Client) {
        backupData = await this.loadS3Backup(backupId);
      }
      
      if (!backupData) {
        throw new Error(`Backup not found: ${backupId}`);
      }
      
      // Verify checksum
      const expectedChecksum = backupData.metadata.checksum;
      const actualChecksum = this.calculateChecksum(backupData.data);
      
      if (expectedChecksum !== actualChecksum) {
        throw new Error('Backup checksum mismatch');
      }
      
      this.emit('restore:completed', { backupId });
      
      return backupData.data;
      
    } catch (error) {
      logger.error('Restore failed', { error, backupId });
      this.emit('restore:failed', { error: error.message, backupId });
      throw error;
    }
  }

  generateBackupId() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const random = randomBytes(4).toString('hex');
    return `${timestamp}-${random}`;
  }

  calculateChecksum(data) {
    const hash = createHash('sha256');
    hash.update(JSON.stringify(data));
    return hash.digest('hex');
  }

  async cleanOldBackups() {
    const cutoffTime = Date.now() - (this.config.retentionDays * 24 * 60 * 60 * 1000);
    
    this.backupHistory = this.backupHistory.filter(backup => {
      if (backup.timestamp < cutoffTime || this.backupHistory.length > this.config.maxBackups) {
        // Delete old backup
        this.deleteBackup(backup.id).catch(error => {
          logger.error('Failed to delete old backup', { error, backupId: backup.id });
        });
        return false;
      }
      return true;
    });
  }

  async deleteBackup(backupId) {
    // Delete local
    const localPaths = [
      path.join(this.config.backupPath, `backup-${backupId}.gz`),
      path.join(this.config.backupPath, `backup-${backupId}.json`)
    ];
    
    for (const localPath of localPaths) {
      try {
        await fs.unlink(localPath);
      } catch (error) {
        // Ignore if not exists
      }
    }
    
    // Delete from S3
    if (this.s3Client) {
      // Implementation would delete from S3
    }
  }

  async loadLocalBackup(backupId) {
    const paths = [
      path.join(this.config.backupPath, `backup-${backupId}.gz`),
      path.join(this.config.backupPath, `backup-${backupId}.json`)
    ];
    
    for (const filePath of paths) {
      try {
        let data = await fs.readFile(filePath);
        
        if (filePath.endsWith('.gz')) {
          data = await gunzip(data);
        }
        
        return JSON.parse(data.toString());
      } catch (error) {
        // Try next path
      }
    }
    
    return null;
  }

  async loadS3Backup(backupId) {
    const key = `backups/${backupId}`;
    
    try {
      const command = new GetObjectCommand({
        Bucket: this.config.s3Config.bucket,
        Key: key
      });
      
      const response = await this.s3Client.send(command);
      let data = await response.Body.transformToByteArray();
      
      if (response.ContentType === 'application/gzip') {
        data = await gunzip(data);
      }
      
      return JSON.parse(data.toString());
    } catch (error) {
      return null;
    }
  }
}

/**
 * Unified Disaster Recovery System
 */
export class UnifiedDisasterRecovery extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Recovery configuration
      mode: config.mode || RecoveryMode.WARM_STANDBY,
      autoFailover: config.autoFailover !== false,
      failoverTimeout: config.failoverTimeout || 30000,
      
      // Health check configuration
      healthCheckInterval: config.healthCheckInterval || 10000,
      componentCheckInterval: config.componentCheckInterval || 5000,
      
      // Backup configuration
      backupInterval: config.backupInterval || 300000, // 5 minutes
      backupStrategy: config.backupStrategy || BackupStrategy.INCREMENTAL,
      
      // Region configuration
      regions: config.regions || {},
      
      // Component configuration
      components: config.components || [],
      
      // Recovery strategies
      defaultRecoveryStrategy: config.defaultRecoveryStrategy || RecoveryStrategy.RESTART_COMPONENT,
      maxRestartAttempts: config.maxRestartAttempts || 3,
      
      // Redis configuration
      redis: config.redis || {
        host: 'localhost',
        port: 6379,
        db: 0,
        keyPrefix: 'otedama:dr:'
      },
      
      // Notification configuration
      notificationWebhook: config.notificationWebhook,
      alertEmail: config.alertEmail,
      
      ...config
    };
    
    this.state = RecoveryState.HEALTHY;
    this.regions = new Map();
    this.components = new Map();
    this.currentRegion = null;
    
    this.backupManager = new BackupManager(config.backup);
    this.clusterNode = null;
    this.redis = null;
    
    this.recoveryProcedures = new Map();
    this.circuitBreakers = new Map();
    
    this.intervals = {
      healthCheck: null,
      componentCheck: null,
      backup: null
    };
    
    this.metrics = {
      totalFailovers: 0,
      totalRecoveries: 0,
      totalBackups: 0,
      uptime: Date.now(),
      lastFailover: null,
      lastRecovery: null
    };
    
    this.initialized = false;
  }

  /**
   * Initialize disaster recovery system
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      logger.info('Initializing unified disaster recovery system', {
        mode: this.config.mode,
        regions: Object.keys(this.config.regions).length,
        components: this.config.components.length
      });
      
      // Initialize Redis
      this.redis = new Redis(this.config.redis);
      
      // Initialize regions
      await this.initializeRegions();
      
      // Initialize components
      await this.initializeComponents();
      
      // Initialize cluster if configured
      if (this.config.cluster) {
        await this.initializeCluster();
      }
      
      // Register default recovery procedures
      this.registerDefaultProcedures();
      
      // Start monitoring
      this.startMonitoring();
      
      // Start backup schedule
      this.startBackupSchedule();
      
      // Load state
      await this.loadState();
      
      this.initialized = true;
      
      logger.info('Disaster recovery initialized', {
        primaryRegion: this.currentRegion?.name,
        totalRegions: this.regions.size,
        totalComponents: this.components.size
      });
      
      this.emit('initialized');
      
    } catch (error) {
      logger.error('Failed to initialize disaster recovery', { error });
      throw error;
    }
  }

  /**
   * Initialize regions
   */
  async initializeRegions() {
    for (const [name, regionConfig] of Object.entries(this.config.regions)) {
      const region = new Region(name, regionConfig);
      this.regions.set(name, region);
      
      if (region.primary) {
        this.currentRegion = region;
      }
      
      logger.info('Region initialized', {
        name,
        primary: region.primary,
        dataCenter: region.dataCenter
      });
    }
    
    if (!this.currentRegion && this.regions.size > 0) {
      // Set first region as primary if none specified
      this.currentRegion = this.regions.values().next().value;
      this.currentRegion.primary = true;
    }
  }

  /**
   * Initialize components
   */
  async initializeComponents() {
    for (const componentConfig of this.config.components) {
      const component = new ComponentMonitor(componentConfig.name, componentConfig);
      this.components.set(componentConfig.name, component);
      
      // Initialize circuit breaker
      this.circuitBreakers.set(componentConfig.name, {
        state: 'closed',
        failures: 0,
        lastFailure: 0,
        nextRetry: 0
      });
      
      logger.info('Component initialized', {
        name: componentConfig.name,
        type: componentConfig.type,
        critical: componentConfig.critical
      });
    }
  }

  /**
   * Initialize cluster
   */
  async initializeCluster() {
    this.clusterNode = new HAClusterNode({
      ...this.config.cluster,
      nodeId: `dr-${this.currentRegion.name}`,
      nodeName: `disaster-recovery-${this.currentRegion.name}`
    });
    
    await this.clusterNode.initialize();
    
    // Listen for cluster events
    this.clusterNode.on('failover', async (event) => {
      logger.warn('Cluster failover detected', event);
      await this.handleClusterFailover(event);
    });
  }

  /**
   * Start monitoring
   */
  startMonitoring() {
    // Region health monitoring
    this.intervals.healthCheck = setInterval(() => {
      this.checkAllRegions().catch(error => {
        logger.error('Region health check failed', { error });
      });
    }, this.config.healthCheckInterval);
    
    // Component health monitoring
    this.intervals.componentCheck = setInterval(() => {
      this.checkAllComponents().catch(error => {
        logger.error('Component health check failed', { error });
      });
    }, this.config.componentCheckInterval);
  }

  /**
   * Check all regions
   */
  async checkAllRegions() {
    const checks = [];
    
    for (const [name, region] of this.regions) {
      checks.push(this.checkRegion(region));
    }
    
    const results = await Promise.allSettled(checks);
    
    // Evaluate overall health
    const healthyRegions = results.filter(r => 
      r.status === 'fulfilled' && r.value.healthy
    ).length;
    
    const totalRegions = this.regions.size;
    
    if (healthyRegions === totalRegions) {
      this.updateState(RecoveryState.HEALTHY);
    } else if (healthyRegions > totalRegions / 2) {
      this.updateState(RecoveryState.DEGRADED);
    } else {
      this.updateState(RecoveryState.FAILED);
      
      // Trigger failover if primary failed
      if (this.currentRegion && !this.currentRegion.healthy && this.config.autoFailover) {
        await this.initiateFailover('primary_region_failure');
      }
    }
  }

  /**
   * Check single region
   */
  async checkRegion(region) {
    const result = await region.checkHealth();
    
    this.emit('region:health', {
      region: region.name,
      ...result
    });
    
    // Store health status in Redis
    await this.redis.setex(
      `${this.config.redis.keyPrefix}region:${region.name}:health`,
      60, // 1 minute TTL
      JSON.stringify({
        ...result,
        timestamp: Date.now()
      })
    );
    
    return result;
  }

  /**
   * Check all components
   */
  async checkAllComponents() {
    const checks = [];
    
    for (const [name, component] of this.components) {
      checks.push(this.checkComponent(component));
    }
    
    await Promise.allSettled(checks);
  }

  /**
   * Check single component
   */
  async checkComponent(component) {
    const result = await component.check();
    
    this.emit('component:health', {
      component: component.name,
      health: component.health,
      ...result
    });
    
    // Handle component failure
    if (component.health === ComponentHealth.FAILED) {
      await this.handleComponentFailure(component);
    }
    
    return result;
  }

  /**
   * Handle component failure
   */
  async handleComponentFailure(component) {
    logger.error('Component failed', {
      name: component.name,
      critical: component.critical,
      failureCount: component.failureCount
    });
    
    // Check circuit breaker
    const breaker = this.circuitBreakers.get(component.name);
    if (breaker.state === 'open' && Date.now() < breaker.nextRetry) {
      logger.warn('Circuit breaker open, skipping recovery', {
        component: component.name
      });
      return;
    }
    
    // Determine recovery strategy
    const strategy = this.determineRecoveryStrategy(component);
    
    try {
      await this.executeRecoveryStrategy(component, strategy);
      
      // Reset circuit breaker
      breaker.state = 'closed';
      breaker.failures = 0;
      
      this.metrics.totalRecoveries++;
      
      this.emit('recovery:success', {
        component: component.name,
        strategy
      });
      
    } catch (error) {
      logger.error('Recovery failed', {
        component: component.name,
        strategy,
        error: error.message
      });
      
      // Update circuit breaker
      breaker.failures++;
      if (breaker.failures >= 3) {
        breaker.state = 'open';
        breaker.nextRetry = Date.now() + 60000; // 1 minute
      }
      
      // If critical component, consider failover
      if (component.critical && this.config.autoFailover) {
        await this.initiateFailover('critical_component_failure');
      }
      
      this.emit('recovery:failed', {
        component: component.name,
        strategy,
        error: error.message
      });
    }
  }

  /**
   * Determine recovery strategy
   */
  determineRecoveryStrategy(component) {
    // Check if custom strategy defined
    if (component.recoveryStrategy) {
      return component.recoveryStrategy;
    }
    
    // Determine based on component state
    if (component.restartCount >= this.config.maxRestartAttempts) {
      return RecoveryStrategy.GRACEFUL_DEGRADATION;
    }
    
    if (component.failureCount === 1) {
      return RecoveryStrategy.RESTART_COMPONENT;
    }
    
    if (component.failureCount > 1) {
      return RecoveryStrategy.RETRY_WITH_BACKOFF;
    }
    
    return this.config.defaultRecoveryStrategy;
  }

  /**
   * Execute recovery strategy
   */
  async executeRecoveryStrategy(component, strategy) {
    logger.info('Executing recovery strategy', {
      component: component.name,
      strategy
    });
    
    switch (strategy) {
      case RecoveryStrategy.RESTART_COMPONENT:
        await component.restart();
        break;
        
      case RecoveryStrategy.RETRY_WITH_BACKOFF:
        await new Promise(resolve => setTimeout(resolve, 5000));
        await component.restart();
        break;
        
      case RecoveryStrategy.GRACEFUL_DEGRADATION:
        logger.warn('Component degraded', { component: component.name });
        component.health = ComponentHealth.DEGRADED;
        break;
        
      case RecoveryStrategy.CIRCUIT_BREAKER:
        // Already handled by circuit breaker logic
        break;
        
      case RecoveryStrategy.REGION_FAILOVER:
        await this.initiateFailover('recovery_strategy');
        break;
        
      default:
        throw new Error(`Unknown recovery strategy: ${strategy}`);
    }
  }

  /**
   * Initiate failover
   */
  async initiateFailover(reason) {
    if (this.state === RecoveryState.FAILING_OVER) {
      logger.warn('Failover already in progress');
      return;
    }
    
    this.updateState(RecoveryState.FAILING_OVER);
    const startTime = Date.now();
    
    try {
      logger.info('Initiating failover', {
        currentRegion: this.currentRegion?.name,
        reason
      });
      
      this.emit('failover:started', {
        from: this.currentRegion?.name,
        reason,
        timestamp: Date.now()
      });
      
      // Take snapshot before failover
      await this.createFailoverSnapshot();
      
      // Find best available region
      const targetRegion = await this.selectFailoverTarget();
      
      if (!targetRegion) {
        throw new Error('No healthy regions available for failover');
      }
      
      logger.info('Selected failover target', {
        target: targetRegion.name,
        priority: targetRegion.priority,
        latency: targetRegion.latency
      });
      
      // Execute failover procedures
      await this.executeFailoverProcedures(targetRegion);
      
      // Update current region
      const previousRegion = this.currentRegion;
      this.currentRegion = targetRegion;
      targetRegion.primary = true;
      if (previousRegion) {
        previousRegion.primary = false;
      }
      
      // Update Redis
      await this.redis.set(
        `${this.config.redis.keyPrefix}primary_region`,
        targetRegion.name
      );
      
      this.updateState(RecoveryState.HEALTHY);
      this.metrics.totalFailovers++;
      this.metrics.lastFailover = Date.now();
      
      const duration = Date.now() - startTime;
      
      this.emit('failover:completed', {
        from: previousRegion?.name,
        to: targetRegion.name,
        reason,
        duration
      });
      
      logger.info('Failover completed', {
        newPrimary: targetRegion.name,
        duration
      });
      
      // Send notifications
      await this.sendNotification('failover_completed', {
        from: previousRegion?.name,
        to: targetRegion.name,
        reason,
        duration
      });
      
    } catch (error) {
      logger.error('Failover failed', { error });
      
      this.updateState(RecoveryState.FAILED);
      
      this.emit('failover:failed', {
        error: error.message,
        reason
      });
      
      // Send critical alert
      await this.sendNotification('failover_failed', {
        error: error.message,
        reason
      });
      
      throw error;
    }
  }

  /**
   * Create failover snapshot
   */
  async createFailoverSnapshot() {
    const snapshot = {
      timestamp: Date.now(),
      currentRegion: this.currentRegion?.name,
      state: this.state,
      components: Array.from(this.components.entries()).map(([name, comp]) => ({
        name,
        health: comp.health,
        metrics: comp.metrics
      })),
      regions: Array.from(this.regions.entries()).map(([name, region]) => ({
        name,
        healthy: region.healthy,
        latency: region.latency,
        resources: region.resources
      }))
    };
    
    const backupId = await this.backupManager.performBackup(snapshot, {
      strategy: BackupStrategy.SNAPSHOT,
      metadata: {
        type: 'failover_snapshot',
        reason: 'pre_failover'
      }
    });
    
    logger.info('Failover snapshot created', { backupId });
    
    return backupId;
  }

  /**
   * Select failover target
   */
  async selectFailoverTarget() {
    const candidates = [];
    
    for (const [name, region] of this.regions) {
      if (region === this.currentRegion || !region.healthy) continue;
      
      // Check region capacity
      const capacity = await this.checkRegionCapacity(region);
      if (capacity < 0.8) { // 80% capacity threshold
        candidates.push({
          region,
          score: (region.priority * 100) - region.latency + (capacity * 50)
        });
      }
    }
    
    // Sort by score (higher is better)
    candidates.sort((a, b) => b.score - a.score);
    
    return candidates[0]?.region || null;
  }

  /**
   * Check region capacity
   */
  async checkRegionCapacity(region) {
    const { resources, capacity } = region;
    
    const cpuUsage = resources.cpu / (capacity.cpu || 100);
    const memoryUsage = resources.memory / (capacity.memory || 100);
    const storageUsage = resources.storage / (capacity.storage || 100);
    
    // Return remaining capacity (0-1)
    return 1 - Math.max(cpuUsage, memoryUsage, storageUsage);
  }

  /**
   * Execute failover procedures
   */
  async executeFailoverProcedures(targetRegion) {
    const procedures = [
      'pre_failover',
      'stop_writes',
      'sync_data',
      'update_dns',
      'update_load_balancer',
      'start_services',
      'verify_services',
      'resume_writes',
      'post_failover'
    ];
    
    for (const procedure of procedures) {
      if (this.recoveryProcedures.has(procedure)) {
        logger.info(`Executing procedure: ${procedure}`);
        
        const timeout = setTimeout(() => {
          throw new Error(`Procedure timeout: ${procedure}`);
        }, this.config.failoverTimeout);
        
        try {
          await this.recoveryProcedures.get(procedure)(targetRegion);
          clearTimeout(timeout);
        } catch (error) {
          clearTimeout(timeout);
          logger.error(`Procedure failed: ${procedure}`, { error });
          throw error;
        }
      }
    }
  }

  /**
   * Register recovery procedure
   */
  registerProcedure(name, handler) {
    this.recoveryProcedures.set(name, handler);
    logger.info(`Registered recovery procedure: ${name}`);
  }

  /**
   * Register default procedures
   */
  registerDefaultProcedures() {
    // Pre-failover validation
    this.registerProcedure('pre_failover', async (target) => {
      const health = await target.checkHealth();
      if (!health.healthy) {
        throw new Error('Target region is not healthy');
      }
      
      const capacity = await this.checkRegionCapacity(target);
      if (capacity < 0.2) {
        throw new Error('Target region has insufficient capacity');
      }
    });
    
    // Stop writes to prevent split-brain
    this.registerProcedure('stop_writes', async () => {
      await this.redis.set(
        `${this.config.redis.keyPrefix}writes_enabled`,
        'false'
      );
    });
    
    // Sync critical data
    this.registerProcedure('sync_data', async (target) => {
      // Implementation would sync data to target region
      logger.info('Syncing data to target region', { target: target.name });
    });
    
    // Resume writes
    this.registerProcedure('resume_writes', async () => {
      await this.redis.set(
        `${this.config.redis.keyPrefix}writes_enabled`,
        'true'
      );
    });
    
    // Verify services
    this.registerProcedure('verify_services', async (target) => {
      const health = await target.checkHealth();
      
      if (!health.healthy || !health.details?.operational) {
        throw new Error('Target services not operational');
      }
    });
  }

  /**
   * Start backup schedule
   */
  startBackupSchedule() {
    if (this.config.backupInterval <= 0) return;
    
    // Schedule regular backups
    this.intervals.backup = setInterval(() => {
      this.performScheduledBackup().catch(error => {
        logger.error('Scheduled backup failed', { error });
      });
    }, this.config.backupInterval);
    
    // Schedule based on cron if configured
    if (this.config.backupSchedule) {
      cron.schedule(this.config.backupSchedule, () => {
        this.performScheduledBackup().catch(error => {
          logger.error('Cron backup failed', { error });
        });
      });
    }
  }

  /**
   * Perform scheduled backup
   */
  async performScheduledBackup() {
    const data = await this.gatherBackupData();
    
    const backupId = await this.backupManager.performBackup(data, {
      strategy: this.config.backupStrategy,
      metadata: {
        type: 'scheduled',
        region: this.currentRegion?.name
      }
    });
    
    this.metrics.totalBackups++;
    
    logger.info('Scheduled backup completed', { backupId });
  }

  /**
   * Gather backup data
   */
  async gatherBackupData() {
    const data = {
      timestamp: Date.now(),
      version: '1.1.6',
      region: this.currentRegion?.name,
      state: this.state,
      metrics: this.metrics,
      components: {},
      custom: {}
    };
    
    // Gather component states
    for (const [name, component] of this.components) {
      data.components[name] = {
        health: component.health,
        metrics: component.metrics,
        restartCount: component.restartCount
      };
    }
    
    // Allow custom data gathering
    this.emit('backup:gather', data);
    
    return data;
  }

  /**
   * Manual backup
   */
  async backup(options = {}) {
    const data = await this.gatherBackupData();
    
    return await this.backupManager.performBackup(data, {
      ...options,
      metadata: {
        ...options.metadata,
        type: 'manual',
        region: this.currentRegion?.name
      }
    });
  }

  /**
   * Restore from backup
   */
  async restore(backupId, options = {}) {
    logger.info('Starting restore', { backupId });
    
    this.updateState(RecoveryState.RECOVERING);
    
    try {
      const data = await this.backupManager.restore(backupId, options);
      
      // Allow custom restore logic
      this.emit('restore:apply', data);
      
      // Restore component states if requested
      if (options.restoreComponents && data.components) {
        for (const [name, state of Object.entries(data.components)) {
          const component = this.components.get(name);
          if (component) {
            component.health = state.health;
            component.metrics = state.metrics;
          }
        }
      }
      
      this.updateState(RecoveryState.HEALTHY);
      
      logger.info('Restore completed', { backupId });
      
      return data;
      
    } catch (error) {
      this.updateState(RecoveryState.FAILED);
      throw error;
    }
  }

  /**
   * Update system state
   */
  updateState(newState) {
    const oldState = this.state;
    this.state = newState;
    
    if (oldState !== newState) {
      this.emit('state:changed', {
        from: oldState,
        to: newState,
        timestamp: Date.now()
      });
      
      logger.info('Disaster recovery state changed', {
        from: oldState,
        to: newState
      });
      
      // Store state in Redis
      this.redis.set(
        `${this.config.redis.keyPrefix}state`,
        JSON.stringify({
          state: newState,
          timestamp: Date.now(),
          region: this.currentRegion?.name
        })
      ).catch(error => {
        logger.error('Failed to store state', { error });
      });
    }
  }

  /**
   * Load saved state
   */
  async loadState() {
    try {
      const stateData = await this.redis.get(`${this.config.redis.keyPrefix}state`);
      if (stateData) {
        const state = JSON.parse(stateData);
        logger.info('Loaded previous state', state);
      }
      
      const primaryRegion = await this.redis.get(`${this.config.redis.keyPrefix}primary_region`);
      if (primaryRegion && this.regions.has(primaryRegion)) {
        const region = this.regions.get(primaryRegion);
        this.currentRegion = region;
        region.primary = true;
        
        logger.info('Restored primary region', { region: primaryRegion });
      }
    } catch (error) {
      logger.error('Failed to load state', { error });
    }
  }

  /**
   * Send notification
   */
  async sendNotification(type, data) {
    try {
      const notification = {
        type,
        timestamp: Date.now(),
        environment: 'production',
        region: this.currentRegion?.name,
        data
      };
      
      // Webhook notification
      if (this.config.notificationWebhook) {
        await fetch(this.config.notificationWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(notification)
        });
      }
      
      // Email notification (would integrate with email service)
      if (this.config.alertEmail) {
        logger.info('Email notification queued', {
          to: this.config.alertEmail,
          type
        });
      }
      
      this.emit('notification:sent', notification);
      
    } catch (error) {
      logger.error('Failed to send notification', { error });
    }
  }

  /**
   * Get status
   */
  getStatus() {
    const regions = Array.from(this.regions.values()).map(region => ({
      name: region.name,
      primary: region === this.currentRegion,
      healthy: region.healthy,
      latency: region.latency,
      lastCheck: region.lastHealthCheck,
      failureCount: region.failureCount,
      resources: region.resources
    }));
    
    const components = Array.from(this.components.values()).map(comp => ({
      name: comp.name,
      type: comp.type,
      health: comp.health,
      critical: comp.critical,
      failureCount: comp.failureCount,
      restartCount: comp.restartCount,
      metrics: comp.metrics
    }));
    
    return {
      state: this.state,
      mode: this.config.mode,
      currentRegion: this.currentRegion?.name,
      regions,
      components,
      backup: {
        lastBackup: this.backupManager.lastBackup?.timestamp,
        backupCount: this.backupManager.backupHistory.length
      },
      metrics: this.metrics,
      uptime: Date.now() - this.metrics.uptime
    };
  }

  /**
   * Perform health check
   */
  async healthCheck() {
    const status = this.getStatus();
    
    return {
      healthy: this.state === RecoveryState.HEALTHY,
      state: this.state,
      region: this.currentRegion?.name,
      summary: {
        regionsHealthy: status.regions.filter(r => r.healthy).length,
        regionsTotal: status.regions.length,
        componentsHealthy: status.components.filter(c => c.health === ComponentHealth.HEALTHY).length,
        componentsTotal: status.components.length
      }
    };
  }

  /**
   * Manual failover
   */
  async failoverTo(regionName) {
    const targetRegion = this.regions.get(regionName);
    
    if (!targetRegion) {
      throw new Error(`Unknown region: ${regionName}`);
    }
    
    if (targetRegion === this.currentRegion) {
      throw new Error('Already in target region');
    }
    
    logger.info('Manual failover requested', {
      from: this.currentRegion?.name,
      to: regionName
    });
    
    await this.initiateFailover('manual_request');
  }

  /**
   * Shutdown
   */
  async shutdown() {
    logger.info('Shutting down disaster recovery system');
    
    // Clear intervals
    Object.values(this.intervals).forEach(interval => {
      if (interval) clearInterval(interval);
    });
    
    // Close connections
    if (this.redis) {
      await this.redis.quit();
    }
    
    if (this.clusterNode) {
      await this.clusterNode.shutdown();
    }
    
    this.initialized = false;
    
    logger.info('Disaster recovery system shut down');
    this.emit('shutdown');
  }
}

/**
 * Factory function
 */
export function createUnifiedDisasterRecovery(config) {
  return new UnifiedDisasterRecovery(config);
}

export default UnifiedDisasterRecovery;