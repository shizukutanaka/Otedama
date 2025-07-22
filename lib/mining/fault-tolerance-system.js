// Advanced Fault Tolerance and Failover System for P2P Mining Pool
// Ensures high availability and automatic recovery from failures

import EventEmitter from 'events';
import { createLogger } from '../core/logger.js';

const logger = createLogger('fault-tolerance-system');

export class FaultToleranceSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // Health check intervals
      healthCheckInterval: options.healthCheckInterval || 5000, // 5 seconds
      nodeHealthTimeout: options.nodeHealthTimeout || 30000, // 30 seconds
      
      // Failover settings
      failoverThreshold: options.failoverThreshold || 3, // Failed health checks before failover
      failoverGracePeriod: options.failoverGracePeriod || 60000, // 1 minute
      maxFailovers: options.maxFailovers || 5, // Max failovers per hour
      
      // Recovery settings
      recoveryAttempts: options.recoveryAttempts || 3,
      recoveryDelay: options.recoveryDelay || 10000, // 10 seconds
      recoveryBackoff: options.recoveryBackoff || 2, // Exponential backoff multiplier
      
      // Redundancy settings
      minActiveNodes: options.minActiveNodes || 3,
      replicationFactor: options.replicationFactor || 3,
      
      ...options
    };
    
    // System state
    this.nodes = new Map();
    this.services = new Map();
    this.failoverHistory = [];
    this.isFailingOver = false;
    
    // Health monitoring
    this.healthChecks = new Map();
    this.healthHistory = new Map();
    
    // Backup systems
    this.backupNodes = new Map();
    this.dataSyncStatus = new Map();
  }

  async initialize(poolSystem) {
    this.poolSystem = poolSystem;
    
    logger.info('Initializing fault tolerance system');
    
    // Register system components
    this.registerSystemComponents();
    
    // Start health monitoring
    this.startHealthMonitoring();
    
    // Initialize backup systems
    await this.initializeBackupSystems();
    
    // Set up event handlers
    this.setupEventHandlers();
    
    logger.info('Fault tolerance system initialized');
    
    return this;
  }

  registerSystemComponents() {
    // Register core services
    const services = [
      {
        id: 'consensus',
        name: 'PBFT Consensus',
        critical: true,
        healthCheck: () => this.checkConsensusHealth(),
        failover: () => this.failoverConsensus(),
        recover: () => this.recoverConsensus()
      },
      {
        id: 'dht',
        name: 'Kademlia DHT',
        critical: true,
        healthCheck: () => this.checkDHTHealth(),
        failover: () => this.failoverDHT(),
        recover: () => this.recoverDHT()
      },
      {
        id: 'stratum',
        name: 'Stratum Server',
        critical: true,
        healthCheck: () => this.checkStratumHealth(),
        failover: () => this.failoverStratum(),
        recover: () => this.recoverStratum()
      },
      {
        id: 'gpu',
        name: 'GPU Manager',
        critical: false,
        healthCheck: () => this.checkGPUHealth(),
        failover: () => this.failoverGPU(),
        recover: () => this.recoverGPU()
      },
      {
        id: 'database',
        name: 'Database',
        critical: true,
        healthCheck: () => this.checkDatabaseHealth(),
        failover: () => this.failoverDatabase(),
        recover: () => this.recoverDatabase()
      }
    ];
    
    for (const service of services) {
      this.services.set(service.id, {
        ...service,
        status: 'healthy',
        failureCount: 0,
        lastHealthCheck: Date.now(),
        lastFailure: null
      });
    }
  }

  startHealthMonitoring() {
    // Regular health checks
    this.healthCheckInterval = setInterval(() => {
      this.performHealthChecks();
    }, this.config.healthCheckInterval);
    
    // Node monitoring
    this.nodeMonitoringInterval = setInterval(() => {
      this.monitorNodes();
    }, this.config.healthCheckInterval * 2);
  }

  async performHealthChecks() {
    for (const [serviceId, service] of this.services) {
      try {
        const health = await service.healthCheck();
        
        this.updateServiceHealth(serviceId, health);
        
        if (!health.healthy) {
          await this.handleServiceFailure(serviceId, health.reason);
        }
      } catch (error) {
        logger.error(`Health check failed for ${service.name}:`, error);
        await this.handleServiceFailure(serviceId, error.message);
      }
    }
  }

  updateServiceHealth(serviceId, health) {
    const service = this.services.get(serviceId);
    
    // Update health history
    if (!this.healthHistory.has(serviceId)) {
      this.healthHistory.set(serviceId, []);
    }
    
    const history = this.healthHistory.get(serviceId);
    history.push({
      timestamp: Date.now(),
      healthy: health.healthy,
      metrics: health.metrics || {}
    });
    
    // Keep only recent history
    if (history.length > 100) {
      history.shift();
    }
    
    // Update service status
    if (health.healthy) {
      service.status = 'healthy';
      service.failureCount = 0;
    } else {
      service.status = 'unhealthy';
      service.failureCount++;
    }
    
    service.lastHealthCheck = Date.now();
  }

  async handleServiceFailure(serviceId, reason) {
    const service = this.services.get(serviceId);
    
    logger.warn(`Service ${service.name} is unhealthy: ${reason}`);
    
    // Check if failover threshold reached
    if (service.failureCount >= this.config.failoverThreshold) {
      logger.error(`Service ${service.name} has failed ${service.failureCount} times, initiating failover`);
      
      service.lastFailure = Date.now();
      
      // Check failover limits
      if (this.canFailover(serviceId)) {
        await this.initiateFailover(serviceId);
      } else {
        logger.error(`Failover limit reached for ${service.name}, attempting recovery`);
        await this.attemptRecovery(serviceId);
      }
    }
  }

  canFailover(serviceId) {
    const recentFailovers = this.failoverHistory.filter(f =>
      f.serviceId === serviceId &&
      Date.now() - f.timestamp < 3600000 // 1 hour
    );
    
    return recentFailovers.length < this.config.maxFailovers;
  }

  async initiateFailover(serviceId) {
    if (this.isFailingOver) {
      logger.warn('Failover already in progress');
      return;
    }
    
    this.isFailingOver = true;
    const service = this.services.get(serviceId);
    
    try {
      logger.info(`Starting failover for ${service.name}`);
      
      // Record failover
      this.failoverHistory.push({
        serviceId,
        timestamp: Date.now(),
        reason: `Failed health checks: ${service.failureCount}`
      });
      
      // Emit failover event
      this.emit('failover-start', { serviceId, service: service.name });
      
      // Execute service-specific failover
      await service.failover();
      
      // Update service status
      service.status = 'failover';
      
      // Wait for grace period
      await new Promise(resolve => 
        setTimeout(resolve, this.config.failoverGracePeriod)
      );
      
      // Attempt recovery
      await this.attemptRecovery(serviceId);
      
      logger.info(`Failover completed for ${service.name}`);
      
      this.emit('failover-complete', { serviceId, service: service.name });
      
    } catch (error) {
      logger.error(`Failover failed for ${service.name}:`, error);
      
      this.emit('failover-failed', { 
        serviceId, 
        service: service.name,
        error: error.message 
      });
      
      // Try emergency recovery
      await this.emergencyRecovery(serviceId);
      
    } finally {
      this.isFailingOver = false;
    }
  }

  async attemptRecovery(serviceId) {
    const service = this.services.get(serviceId);
    let recovered = false;
    
    for (let attempt = 1; attempt <= this.config.recoveryAttempts; attempt++) {
      logger.info(`Recovery attempt ${attempt} for ${service.name}`);
      
      try {
        await service.recover();
        
        // Verify recovery with health check
        const health = await service.healthCheck();
        
        if (health.healthy) {
          recovered = true;
          service.status = 'healthy';
          service.failureCount = 0;
          
          logger.info(`Successfully recovered ${service.name}`);
          
          this.emit('service-recovered', { 
            serviceId, 
            service: service.name,
            attempts: attempt 
          });
          
          break;
        }
      } catch (error) {
        logger.error(`Recovery attempt ${attempt} failed for ${service.name}:`, error);
      }
      
      // Wait before next attempt (exponential backoff)
      if (attempt < this.config.recoveryAttempts) {
        const delay = this.config.recoveryDelay * Math.pow(this.config.recoveryBackoff, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    if (!recovered) {
      logger.error(`Failed to recover ${service.name} after ${this.config.recoveryAttempts} attempts`);
      
      this.emit('service-recovery-failed', { 
        serviceId, 
        service: service.name 
      });
      
      // Mark service as failed
      service.status = 'failed';
    }
    
    return recovered;
  }

  async emergencyRecovery(serviceId) {
    const service = this.services.get(serviceId);
    
    logger.warn(`Initiating emergency recovery for ${service.name}`);
    
    if (service.critical) {
      // For critical services, try to switch to backup node
      const backupNode = await this.findBackupNode(serviceId);
      
      if (backupNode) {
        logger.info(`Switching to backup node for ${service.name}`);
        await this.switchToBackupNode(serviceId, backupNode);
      } else {
        logger.error(`No backup node available for critical service ${service.name}`);
        
        // Last resort: restart entire system
        this.emit('critical-failure', { 
          serviceId, 
          service: service.name,
          action: 'system-restart-required' 
        });
      }
    } else {
      // For non-critical services, disable and continue
      logger.warn(`Disabling non-critical service ${service.name}`);
      service.status = 'disabled';
      
      this.emit('service-disabled', { 
        serviceId, 
        service: service.name 
      });
    }
  }

  // Service-specific health checks
  async checkConsensusHealth() {
    if (!this.poolSystem?.consensus) {
      return { healthy: false, reason: 'Consensus not initialized' };
    }
    
    const stats = this.poolSystem.consensus.getStatistics();
    
    // Check if consensus is making progress
    const lastView = this.healthChecks.get('consensus-view') || stats.view;
    this.healthChecks.set('consensus-view', stats.view);
    
    // Check pending requests
    if (stats.pendingRequests > 100) {
      return { 
        healthy: false, 
        reason: 'Too many pending requests',
        metrics: stats 
      };
    }
    
    // Check if primary is responsive
    if (stats.state === 'view-change' && Date.now() - stats.lastViewChange > 60000) {
      return { 
        healthy: false, 
        reason: 'Stuck in view change',
        metrics: stats 
      };
    }
    
    return { 
      healthy: true,
      metrics: stats 
    };
  }

  async checkDHTHealth() {
    if (!this.poolSystem?.dht) {
      return { healthy: false, reason: 'DHT not initialized' };
    }
    
    const stats = this.poolSystem.dht.getStatistics();
    
    // Check routing table
    if (stats.routingTable.totalNodes < this.config.minActiveNodes) {
      return { 
        healthy: false, 
        reason: 'Insufficient nodes in routing table',
        metrics: stats 
      };
    }
    
    // Test DHT operations
    try {
      const testKey = 'health-check-' + Date.now();
      await this.poolSystem.dht.store(testKey, { test: true });
      const retrieved = await this.poolSystem.dht.findValue(testKey);
      
      if (!retrieved) {
        return { 
          healthy: false, 
          reason: 'DHT store/retrieve failed',
          metrics: stats 
        };
      }
    } catch (error) {
      return { 
        healthy: false, 
        reason: `DHT operation failed: ${error.message}`,
        metrics: stats 
      };
    }
    
    return { 
      healthy: true,
      metrics: stats 
    };
  }

  async checkStratumHealth() {
    if (!this.poolSystem?.stratumServer) {
      return { healthy: false, reason: 'Stratum server not initialized' };
    }
    
    // Check if server is accepting connections
    try {
      const net = require('net');
      const client = new net.Socket();
      
      await new Promise((resolve, reject) => {
        client.setTimeout(5000);
        
        client.connect(this.poolSystem.config.stratumPort, 'localhost', () => {
          client.destroy();
          resolve();
        });
        
        client.on('error', reject);
        client.on('timeout', () => {
          client.destroy();
          reject(new Error('Connection timeout'));
        });
      });
    } catch (error) {
      return { 
        healthy: false, 
        reason: `Stratum server not accepting connections: ${error.message}` 
      };
    }
    
    return { healthy: true };
  }

  async checkGPUHealth() {
    if (!this.poolSystem?.gpuManager) {
      return { healthy: true, reason: 'GPU manager not enabled' };
    }
    
    const stats = this.poolSystem.gpuManager.getStatistics();
    
    // Check if GPU kernels are compiled
    if (stats.compiledKernels.length === 0) {
      return { 
        healthy: false, 
        reason: 'No GPU kernels compiled',
        metrics: stats 
      };
    }
    
    // Check GPU performance
    for (const [algo, perf] of Object.entries(stats.performance)) {
      if (perf.averageHashRate === 0 && perf.executions > 0) {
        return { 
          healthy: false, 
          reason: `GPU performance degraded for ${algo}`,
          metrics: stats 
        };
      }
    }
    
    return { 
      healthy: true,
      metrics: stats 
    };
  }

  async checkDatabaseHealth() {
    // Check database connectivity and performance
    try {
      const startTime = Date.now();
      
      // Simple database operation
      const testQuery = await this.performDatabaseTest();
      
      const responseTime = Date.now() - startTime;
      
      if (responseTime > 1000) {
        return { 
          healthy: false, 
          reason: `Database response time too high: ${responseTime}ms` 
        };
      }
      
      return { 
        healthy: true,
        metrics: { responseTime } 
      };
    } catch (error) {
      return { 
        healthy: false, 
        reason: `Database error: ${error.message}` 
      };
    }
  }

  async performDatabaseTest() {
    // Simulate database test
    return new Promise(resolve => {
      setTimeout(() => resolve({ success: true }), Math.random() * 100);
    });
  }

  // Service-specific failover procedures
  async failoverConsensus() {
    logger.info('Failing over consensus service');
    
    // Trigger view change to elect new primary
    if (this.poolSystem?.consensus) {
      await this.poolSystem.consensus.initiateViewChange();
    }
    
    // Wait for new view to stabilize
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  async failoverDHT() {
    logger.info('Failing over DHT service');
    
    // Find alternative bootstrap nodes
    const backupNodes = await this.findBackupDHTNodes();
    
    // Re-bootstrap DHT with backup nodes
    if (this.poolSystem?.dht && backupNodes.length > 0) {
      for (const node of backupNodes) {
        await this.poolSystem.dht.ping(node);
      }
    }
  }

  async failoverStratum() {
    logger.info('Failing over Stratum service');
    
    // Start backup Stratum server on alternative port
    const backupPort = this.poolSystem.config.stratumPort + 1;
    
    try {
      // Stop current server
      if (this.poolSystem?.stratumServer) {
        await this.poolSystem.stratumServer.stop();
      }
      
      // Start on backup port
      this.poolSystem.config.stratumPort = backupPort;
      await this.poolSystem.initializeStratum();
      
      // Notify miners of port change
      this.emit('stratum-port-changed', { newPort: backupPort });
    } catch (error) {
      logger.error('Stratum failover failed:', error);
      throw error;
    }
  }

  async failoverGPU() {
    logger.info('Failing over GPU service');
    
    // Switch to CPU mining
    if (this.poolSystem) {
      this.poolSystem.config.mining.gpuMining = false;
      this.poolSystem.config.mining.cpuMining = true;
      
      // Re-initialize mining components
      await this.poolSystem.initializeMining();
    }
  }

  async failoverDatabase() {
    logger.info('Failing over database service');
    
    // Switch to backup database or in-memory storage
    // This is highly dependent on the actual database implementation
    
    this.emit('database-failover', { 
      mode: 'in-memory',
      warning: 'Data persistence may be affected' 
    });
  }

  // Service recovery procedures
  async recoverConsensus() {
    logger.info('Recovering consensus service');
    
    // Re-initialize consensus with current nodes
    const nodes = await this.poolSystem.discoverNodes();
    await this.poolSystem.consensus.initialize(nodes);
  }

  async recoverDHT() {
    logger.info('Recovering DHT service');
    
    // Re-initialize DHT
    await this.poolSystem.dht.initialize();
    
    // Re-bootstrap with known nodes
    if (this.poolSystem.config.bootstrapNodes) {
      for (const node of this.poolSystem.config.bootstrapNodes) {
        await this.poolSystem.dht.ping(node);
      }
    }
  }

  async recoverStratum() {
    logger.info('Recovering Stratum service');
    
    // Restart Stratum server on original port
    await this.poolSystem.stratumServer.stop();
    await this.poolSystem.initializeStratum();
  }

  async recoverGPU() {
    logger.info('Recovering GPU service');
    
    // Re-initialize GPU manager
    try {
      await this.poolSystem.gpuManager.initialize();
      this.poolSystem.config.mining.gpuMining = true;
    } catch (error) {
      logger.error('GPU recovery failed:', error);
      throw error;
    }
  }

  async recoverDatabase() {
    logger.info('Recovering database service');
    
    // Attempt to reconnect to database
    // Implementation depends on actual database system
  }

  // Node monitoring
  async monitorNodes() {
    // Monitor P2P nodes
    if (this.poolSystem?.dht) {
      const stats = this.poolSystem.dht.getStatistics();
      
      if (stats.routingTable.totalNodes < this.config.minActiveNodes) {
        logger.warn(`Low node count: ${stats.routingTable.totalNodes}`);
        
        // Try to discover more nodes
        await this.discoverAdditionalNodes();
      }
    }
    
    // Check node health
    for (const [nodeId, node] of this.nodes) {
      if (Date.now() - node.lastSeen > this.config.nodeHealthTimeout) {
        await this.handleNodeFailure(nodeId);
      }
    }
  }

  async handleNodeFailure(nodeId) {
    logger.warn(`Node ${nodeId} appears to be offline`);
    
    const node = this.nodes.get(nodeId);
    if (!node) return;
    
    // Mark node as failed
    node.status = 'failed';
    node.failureTime = Date.now();
    
    // Check if node was providing critical services
    if (node.services && node.services.length > 0) {
      for (const serviceId of node.services) {
        await this.redistributeService(serviceId, nodeId);
      }
    }
    
    this.emit('node-failed', { nodeId, services: node.services });
  }

  async redistributeService(serviceId, failedNodeId) {
    logger.info(`Redistributing service ${serviceId} from failed node ${failedNodeId}`);
    
    // Find healthy nodes that can take over
    const candidates = Array.from(this.nodes.values())
      .filter(node => 
        node.status === 'healthy' &&
        node.id !== failedNodeId &&
        node.capacity > 0.8 // Has at least 80% capacity
      );
    
    if (candidates.length === 0) {
      logger.error(`No healthy nodes available to redistribute ${serviceId}`);
      return;
    }
    
    // Select node with most available capacity
    const targetNode = candidates.reduce((best, node) => 
      node.capacity > best.capacity ? node : best
    );
    
    // Assign service to target node
    targetNode.services = targetNode.services || [];
    targetNode.services.push(serviceId);
    targetNode.capacity *= 0.9; // Reduce available capacity
    
    logger.info(`Service ${serviceId} redistributed to node ${targetNode.id}`);
    
    this.emit('service-redistributed', { 
      serviceId, 
      fromNode: failedNodeId,
      toNode: targetNode.id 
    });
  }

  // Backup system management
  async initializeBackupSystems() {
    // Identify potential backup nodes
    await this.identifyBackupNodes();
    
    // Start data synchronization
    await this.startDataSync();
    
    // Set up automatic backups
    this.backupInterval = setInterval(() => {
      this.performBackup();
    }, 300000); // Every 5 minutes
  }

  async identifyBackupNodes() {
    // In a real implementation, this would discover and validate backup nodes
    // For now, simulate with mock data
    
    const backupNodes = [
      {
        id: 'backup-1',
        endpoint: 'backup1.pool.com:3333',
        capacity: 1.0,
        services: [],
        location: 'us-east'
      },
      {
        id: 'backup-2',
        endpoint: 'backup2.pool.com:3333',
        capacity: 1.0,
        services: [],
        location: 'eu-west'
      }
    ];
    
    for (const node of backupNodes) {
      this.backupNodes.set(node.id, node);
    }
    
    logger.info(`Identified ${backupNodes.length} backup nodes`);
  }

  async startDataSync() {
    // Initialize data synchronization with backup nodes
    for (const [nodeId, node] of this.backupNodes) {
      this.dataSyncStatus.set(nodeId, {
        lastSync: Date.now(),
        syncedData: 0,
        status: 'active'
      });
    }
  }

  async performBackup() {
    // Backup critical data to backup nodes
    const criticalData = await this.collectCriticalData();
    
    for (const [nodeId, node] of this.backupNodes) {
      try {
        await this.syncDataToNode(nodeId, criticalData);
        
        const syncStatus = this.dataSyncStatus.get(nodeId);
        syncStatus.lastSync = Date.now();
        syncStatus.syncedData += JSON.stringify(criticalData).length;
        
      } catch (error) {
        logger.error(`Failed to sync data to backup node ${nodeId}:`, error);
        
        const syncStatus = this.dataSyncStatus.get(nodeId);
        syncStatus.status = 'failed';
      }
    }
  }

  async collectCriticalData() {
    // Collect critical system data for backup
    const data = {
      timestamp: Date.now(),
      poolState: this.poolSystem?.getPoolStatistics() || {},
      minerData: this.collectMinerData(),
      shareHistory: this.collectRecentShares(),
      blockHistory: this.collectRecentBlocks()
    };
    
    return data;
  }

  collectMinerData() {
    // Collect miner information
    if (!this.poolSystem) return [];
    
    const miners = [];
    for (const [minerId, miner] of this.poolSystem.miners) {
      miners.push({
        id: minerId,
        worker: miner.worker,
        shares: miner.shares,
        lastShareAt: miner.lastShareAt
      });
    }
    
    return miners;
  }

  collectRecentShares() {
    // Collect recent share data
    if (!this.poolSystem) return [];
    
    const shares = [];
    const cutoff = Date.now() - 3600000; // Last hour
    
    for (const [shareId, share] of this.poolSystem.shares) {
      if (share.timestamp > cutoff) {
        shares.push({
          id: shareId,
          minerId: share.minerId,
          timestamp: share.timestamp,
          difficulty: share.difficulty
        });
      }
    }
    
    return shares;
  }

  collectRecentBlocks() {
    // Collect recent block data
    if (!this.poolSystem) return [];
    
    const blocks = [];
    for (const [hash, block] of this.poolSystem.blocks) {
      blocks.push({
        hash,
        height: block.height,
        finder: block.finder,
        timestamp: block.timestamp,
        reward: block.reward
      });
    }
    
    return blocks.slice(-10); // Last 10 blocks
  }

  async syncDataToNode(nodeId, data) {
    // Simulate data sync to backup node
    // In production, this would use actual network protocols
    
    logger.debug(`Syncing ${JSON.stringify(data).length} bytes to backup node ${nodeId}`);
    
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  async findBackupNode(serviceId) {
    // Find suitable backup node for service
    const candidates = Array.from(this.backupNodes.values())
      .filter(node => node.capacity > 0.5);
    
    if (candidates.length === 0) return null;
    
    // Select node with highest capacity
    return candidates.reduce((best, node) => 
      node.capacity > best.capacity ? node : best
    );
  }

  async switchToBackupNode(serviceId, backupNode) {
    logger.info(`Switching service ${serviceId} to backup node ${backupNode.id}`);
    
    // Update service configuration
    const service = this.services.get(serviceId);
    service.backupActive = true;
    service.backupNode = backupNode.id;
    
    // Restore data from backup
    await this.restoreFromBackup(serviceId, backupNode);
    
    // Update routing
    this.emit('backup-activated', {
      serviceId,
      backupNode: backupNode.id
    });
  }

  async restoreFromBackup(serviceId, backupNode) {
    // Restore service data from backup node
    logger.info(`Restoring ${serviceId} data from backup node ${backupNode.id}`);
    
    // In production, this would retrieve and restore actual data
    // For now, simulate restoration
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  async findBackupDHTNodes() {
    // Find backup DHT bootstrap nodes
    return Array.from(this.backupNodes.values()).map(node => ({
      id: Buffer.from(node.id),
      address: node.endpoint.split(':')[0],
      port: parseInt(node.endpoint.split(':')[1])
    }));
  }

  async discoverAdditionalNodes() {
    // Try to discover more P2P nodes
    logger.info('Attempting to discover additional P2P nodes');
    
    // Use backup nodes as bootstrap
    const backupDHTNodes = await this.findBackupDHTNodes();
    
    for (const node of backupDHTNodes) {
      try {
        await this.poolSystem.dht.findNode(node.id);
      } catch (error) {
        logger.error(`Failed to contact backup node ${node.id}:`, error);
      }
    }
  }

  // Event handlers
  setupEventHandlers() {
    // Monitor pool system events
    if (this.poolSystem) {
      this.poolSystem.on('error', (error) => {
        this.handleSystemError(error);
      });
      
      this.poolSystem.on('component-failure', (data) => {
        this.handleComponentFailure(data);
      });
    }
  }

  handleSystemError(error) {
    logger.error('System error detected:', error);
    
    // Determine affected component
    const affectedService = this.identifyAffectedService(error);
    
    if (affectedService) {
      this.handleServiceFailure(affectedService, error.message);
    }
  }

  identifyAffectedService(error) {
    // Analyze error to determine affected service
    const errorString = error.toString().toLowerCase();
    
    if (errorString.includes('consensus')) return 'consensus';
    if (errorString.includes('dht') || errorString.includes('kademlia')) return 'dht';
    if (errorString.includes('stratum')) return 'stratum';
    if (errorString.includes('gpu')) return 'gpu';
    if (errorString.includes('database')) return 'database';
    
    return null;
  }

  handleComponentFailure(data) {
    const { component, error } = data;
    
    logger.error(`Component failure: ${component}`, error);
    
    // Map component to service
    const serviceId = this.mapComponentToService(component);
    
    if (serviceId) {
      this.handleServiceFailure(serviceId, error);
    }
  }

  mapComponentToService(component) {
    const mapping = {
      'pbft-consensus': 'consensus',
      'kademlia-dht': 'dht',
      'stratum-server': 'stratum',
      'gpu-kernel-manager': 'gpu',
      'database-manager': 'database'
    };
    
    return mapping[component] || null;
  }

  // Statistics and reporting
  getStatistics() {
    const stats = {
      services: {},
      nodes: {
        active: this.nodes.size,
        backup: this.backupNodes.size,
        failed: Array.from(this.nodes.values()).filter(n => n.status === 'failed').length
      },
      failovers: {
        total: this.failoverHistory.length,
        recent: this.failoverHistory.filter(f => 
          Date.now() - f.timestamp < 3600000
        ).length
      },
      dataSync: {}
    };
    
    // Service statistics
    for (const [serviceId, service] of this.services) {
      stats.services[serviceId] = {
        name: service.name,
        status: service.status,
        failureCount: service.failureCount,
        lastHealthCheck: service.lastHealthCheck,
        lastFailure: service.lastFailure
      };
    }
    
    // Data sync statistics
    for (const [nodeId, syncStatus] of this.dataSyncStatus) {
      stats.dataSync[nodeId] = {
        lastSync: syncStatus.lastSync,
        syncedData: syncStatus.syncedData,
        status: syncStatus.status
      };
    }
    
    return stats;
  }

  getHealthReport() {
    const report = {
      overall: 'healthy',
      services: {},
      recommendations: []
    };
    
    // Check each service
    for (const [serviceId, service] of this.services) {
      report.services[serviceId] = {
        status: service.status,
        health: service.status === 'healthy' ? 100 : 
                service.status === 'unhealthy' ? 50 : 0
      };
      
      if (service.status !== 'healthy') {
        report.overall = 'degraded';
      }
      
      if (service.status === 'failed') {
        report.overall = 'critical';
      }
    }
    
    // Generate recommendations
    if (this.nodes.size < this.config.minActiveNodes) {
      report.recommendations.push('Add more nodes to improve redundancy');
    }
    
    if (this.failoverHistory.length > 10) {
      report.recommendations.push('System experiencing frequent failovers, investigate root cause');
    }
    
    return report;
  }

  // Cleanup
  async shutdown() {
    logger.info('Shutting down fault tolerance system');
    
    // Clear intervals
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    
    if (this.nodeMonitoringInterval) {
      clearInterval(this.nodeMonitoringInterval);
    }
    
    if (this.backupInterval) {
      clearInterval(this.backupInterval);
    }
    
    // Final backup
    await this.performBackup();
    
    logger.info('Fault tolerance system shutdown complete');
  }
}

export default FaultToleranceSystem;