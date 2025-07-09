// Automatic Failover System with Multi-region Support
import { EventEmitter } from 'events';
import * as net from 'net';
import * as http from 'http';
import * as dgram from 'dgram';
import { createHash } from 'crypto';
import Redis from 'ioredis';

interface NodeConfig {
  id: string;
  host: string;
  port: number;
  region: string;
  priority: number;
  weight: number;
  type: 'primary' | 'secondary' | 'standby';
}

interface HealthCheck {
  tcp: boolean;
  http: boolean;
  custom?: boolean;
  latency: number;
  timestamp: number;
}

interface FailoverConfig {
  nodes: NodeConfig[];
  healthCheckInterval: number;
  healthCheckTimeout: number;
  failureThreshold: number;
  recoveryThreshold: number;
  quorumSize: number;
  fencingEnabled: boolean;
  splitBrainProtection: boolean;
  dataReplicationCheck: boolean;
}

interface ClusterState {
  leader?: string;
  epoch: number;
  nodes: Map<string, NodeState>;
  lastStateChange: number;
  consensusReached: boolean;
}

interface NodeState {
  config: NodeConfig;
  health: HealthCheck;
  failures: number;
  lastSeen: number;
  status: 'active' | 'failed' | 'recovering' | 'fenced';
  replicationLag?: number;
}

export class AutomaticFailoverSystem extends EventEmitter {
  private config: FailoverConfig;
  private clusterState: ClusterState;
  private redis?: Redis;
  private redisSubscriber?: Redis;
  private heartbeatSocket?: dgram.Socket;
  private healthCheckTimers: Map<string, NodeJS.Timer> = new Map();
  private isLeader: boolean = false;
  private nodeId: string;
  private consensusModule: ConsensusModule;
  
  constructor(nodeId: string, config: FailoverConfig, redis?: Redis) {
    super();
    this.nodeId = nodeId;
    this.config = config;
    this.redis = redis;
    
    this.clusterState = {
      epoch: 0,
      nodes: new Map(),
      lastStateChange: Date.now(),
      consensusReached: false
    };
    
    // Initialize nodes
    for (const nodeConfig of config.nodes) {
      this.clusterState.nodes.set(nodeConfig.id, {
        config: nodeConfig,
        health: {
          tcp: false,
          http: false,
          latency: Infinity,
          timestamp: 0
        },
        failures: 0,
        lastSeen: 0,
        status: 'active'
      });
    }
    
    // Initialize consensus module
    this.consensusModule = new ConsensusModule(this.nodeId, this.clusterState);
  }
  
  /**
   * Start the failover system
   */
  async start(): Promise<void> {
    this.emit('starting', { nodeId: this.nodeId });
    
    // Start heartbeat mechanism
    await this.startHeartbeat();
    
    // Start health monitoring
    this.startHealthMonitoring();
    
    // Subscribe to cluster events if Redis is available
    if (this.redis) {
      await this.subscribeToClusterEvents();
    }
    
    // Perform initial leader election
    await this.performLeaderElection();
    
    this.emit('started', { 
      nodeId: this.nodeId, 
      isLeader: this.isLeader,
      clusterSize: this.clusterState.nodes.size 
    });
  }
  
  /**
   * Stop the failover system
   */
  async stop(): Promise<void> {
    // Stop health checks
    for (const timer of this.healthCheckTimers.values()) {
      clearInterval(timer);
    }
    this.healthCheckTimers.clear();
    
    // Close heartbeat socket
    if (this.heartbeatSocket) {
      this.heartbeatSocket.close();
    }
    
    // Unsubscribe from Redis
    if (this.redisSubscriber) {
      await this.redisSubscriber.unsubscribe();
      this.redisSubscriber.disconnect();
    }
    
    this.emit('stopped', { nodeId: this.nodeId });
  }
  
  /**
   * Start heartbeat mechanism
   */
  private async startHeartbeat(): Promise<void> {
    this.heartbeatSocket = dgram.createSocket('udp4');
    
    // Listen for heartbeats
    this.heartbeatSocket.on('message', (msg, rinfo) => {
      try {
        const heartbeat = JSON.parse(msg.toString());
        this.handleHeartbeat(heartbeat, rinfo.address);
      } catch (error) {
        this.emit('error', { type: 'heartbeat_parse', error });
      }
    });
    
    const myNode = this.clusterState.nodes.get(this.nodeId);
    if (myNode) {
      await new Promise<void>((resolve, reject) => {
        this.heartbeatSocket!.bind(myNode.config.port + 1000, () => {
          resolve();
        });
      });
    }
    
    // Send heartbeats
    setInterval(() => {
      this.sendHeartbeat();
    }, 1000);
  }
  
  /**
   * Send heartbeat to all nodes
   */
  private sendHeartbeat(): void {
    const heartbeat = {
      nodeId: this.nodeId,
      epoch: this.clusterState.epoch,
      timestamp: Date.now(),
      isLeader: this.isLeader,
      status: this.clusterState.nodes.get(this.nodeId)?.status || 'unknown'
    };
    
    const message = Buffer.from(JSON.stringify(heartbeat));
    
    for (const [nodeId, nodeState] of this.clusterState.nodes) {
      if (nodeId === this.nodeId) continue;
      
      this.heartbeatSocket?.send(
        message,
        nodeState.config.port + 1000,
        nodeState.config.host,
        (error) => {
          if (error) {
            this.emit('error', { type: 'heartbeat_send', nodeId, error });
          }
        }
      );
    }
  }
  
  /**
   * Handle received heartbeat
   */
  private handleHeartbeat(heartbeat: any, fromAddress: string): void {
    const nodeState = this.clusterState.nodes.get(heartbeat.nodeId);
    if (!nodeState) return;
    
    // Update last seen
    nodeState.lastSeen = Date.now();
    
    // Check for epoch changes
    if (heartbeat.epoch > this.clusterState.epoch) {
      this.emit('epoch_change', { 
        oldEpoch: this.clusterState.epoch, 
        newEpoch: heartbeat.epoch 
      });
      this.clusterState.epoch = heartbeat.epoch;
    }
    
    // Update node status
    if (nodeState.status === 'failed' && heartbeat.status === 'active') {
      nodeState.status = 'recovering';
      nodeState.failures = 0;
    }
  }
  
  /**
   * Start health monitoring for all nodes
   */
  private startHealthMonitoring(): void {
    for (const [nodeId, nodeState] of this.clusterState.nodes) {
      if (nodeId === this.nodeId) {
        // Self health check
        nodeState.health = {
          tcp: true,
          http: true,
          latency: 0,
          timestamp: Date.now()
        };
        continue;
      }
      
      const timer = setInterval(async () => {
        const health = await this.performHealthCheck(nodeState);
        this.updateNodeHealth(nodeId, health);
      }, this.config.healthCheckInterval);
      
      this.healthCheckTimers.set(nodeId, timer);
    }
  }
  
  /**
   * Perform health check on a node
   */
  private async performHealthCheck(nodeState: NodeState): Promise<HealthCheck> {
    const startTime = Date.now();
    const health: HealthCheck = {
      tcp: false,
      http: false,
      latency: Infinity,
      timestamp: startTime
    };
    
    // TCP health check
    try {
      await this.tcpHealthCheck(nodeState.config.host, nodeState.config.port);
      health.tcp = true;
    } catch (error) {
      this.emit('health_check_failed', { 
        nodeId: nodeState.config.id, 
        type: 'tcp', 
        error 
      });
    }
    
    // HTTP health check
    if (health.tcp) {
      try {
        await this.httpHealthCheck(
          nodeState.config.host, 
          nodeState.config.port, 
          '/health'
        );
        health.http = true;
      } catch (error) {
        this.emit('health_check_failed', { 
          nodeId: nodeState.config.id, 
          type: 'http', 
          error 
        });
      }
    }
    
    // Custom health check (e.g., replication lag)
    if (health.http && this.config.dataReplicationCheck) {
      try {
        const lag = await this.checkReplicationLag(nodeState);
        nodeState.replicationLag = lag;
        health.custom = lag < 1000; // Less than 1 second lag
      } catch (error) {
        health.custom = false;
      }
    }
    
    health.latency = Date.now() - startTime;
    return health;
  }
  
  /**
   * TCP health check
   */
  private tcpHealthCheck(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('TCP health check timeout'));
      }, this.config.healthCheckTimeout);
      
      socket.on('connect', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve();
      });
      
      socket.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      
      socket.connect(port, host);
    });
  }
  
  /**
   * HTTP health check
   */
  private httpHealthCheck(host: string, port: number, path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = http.get({
        hostname: host,
        port,
        path,
        timeout: this.config.healthCheckTimeout
      }, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          reject(new Error(`HTTP health check failed: ${res.statusCode}`));
        }
        res.resume();
      });
      
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('HTTP health check timeout'));
      });
    });
  }
  
  /**
   * Check replication lag
   */
  private async checkReplicationLag(nodeState: NodeState): Promise<number> {
    // This would check actual replication lag
    // For now, return mock value
    return Math.random() * 2000; // 0-2 seconds
  }
  
  /**
   * Update node health status
   */
  private updateNodeHealth(nodeId: string, health: HealthCheck): void {
    const nodeState = this.clusterState.nodes.get(nodeId);
    if (!nodeState) return;
    
    const previousStatus = nodeState.status;
    nodeState.health = health;
    
    // Check if node is healthy
    const isHealthy = health.tcp && health.http && 
      (health.custom !== false) && 
      (Date.now() - nodeState.lastSeen < 5000);
    
    if (isHealthy) {
      if (nodeState.failures > 0) {
        nodeState.failures--;
      }
      
      if (nodeState.status === 'recovering' && 
          nodeState.failures <= this.config.recoveryThreshold) {
        nodeState.status = 'active';
        this.emit('node_recovered', { nodeId });
      }
    } else {
      nodeState.failures++;
      
      if (nodeState.failures >= this.config.failureThreshold) {
        nodeState.status = 'failed';
        
        if (previousStatus !== 'failed') {
          this.emit('node_failed', { nodeId });
          
          // Trigger failover if this was the leader
          if (this.clusterState.leader === nodeId) {
            this.initiateFailover('leader_failure');
          }
        }
      }
    }
  }
  
  /**
   * Initiate failover process
   */
  private async initiateFailover(reason: string): Promise<void> {
    this.emit('failover_initiated', { reason, currentLeader: this.clusterState.leader });
    
    // Increment epoch to prevent split-brain
    this.clusterState.epoch++;
    
    // Fence the old leader if enabled
    if (this.config.fencingEnabled && this.clusterState.leader) {
      await this.fenceNode(this.clusterState.leader);
    }
    
    // Perform leader election
    await this.performLeaderElection();
    
    // Promote new leader
    if (this.isLeader) {
      await this.promoteToLeader();
    }
    
    this.emit('failover_completed', { 
      newLeader: this.clusterState.leader,
      epoch: this.clusterState.epoch
    });
  }
  
  /**
   * Perform leader election using consensus
   */
  private async performLeaderElection(): Promise<void> {
    this.emit('election_started');
    
    // Get healthy nodes
    const healthyNodes = Array.from(this.clusterState.nodes.values())
      .filter(node => node.status === 'active')
      .sort((a, b) => {
        // Sort by priority, then by ID for deterministic ordering
        if (a.config.priority !== b.config.priority) {
          return b.config.priority - a.config.priority;
        }
        return a.config.id.localeCompare(b.config.id);
      });
    
    if (healthyNodes.length < this.config.quorumSize) {
      this.emit('election_failed', { reason: 'insufficient_quorum' });
      return;
    }
    
    // Use consensus module to elect leader
    const electionResult = await this.consensusModule.electLeader(healthyNodes);
    
    if (electionResult.success) {
      this.clusterState.leader = electionResult.leaderId;
      this.isLeader = electionResult.leaderId === this.nodeId;
      this.clusterState.consensusReached = true;
      
      this.emit('election_completed', { 
        leader: electionResult.leaderId,
        votes: electionResult.votes
      });
    } else {
      this.emit('election_failed', { reason: electionResult.reason });
    }
  }
  
  /**
   * Promote this node to leader
   */
  private async promoteToLeader(): Promise<void> {
    this.emit('promotion_started');
    
    // Update cluster state in Redis
    if (this.redis) {
      await this.redis.set(
        'cluster:leader',
        this.nodeId,
        'EX',
        30 // 30 second expiry
      );
      
      await this.redis.set(
        'cluster:epoch',
        this.clusterState.epoch.toString()
      );
    }
    
    // Notify all nodes
    await this.broadcastLeaderChange();
    
    // Start leader-specific tasks
    this.startLeaderTasks();
    
    this.emit('promotion_completed');
  }
  
  /**
   * Fence a node to prevent split-brain
   */
  private async fenceNode(nodeId: string): Promise<void> {
    const nodeState = this.clusterState.nodes.get(nodeId);
    if (!nodeState) return;
    
    this.emit('fencing_node', { nodeId });
    
    // STONITH (Shoot The Other Node In The Head)
    // This would implement actual fencing mechanisms:
    // - IPMI power off
    // - Network isolation
    // - Disk detachment
    
    nodeState.status = 'fenced';
    
    // Notify cluster about fencing
    if (this.redis) {
      await this.redis.publish('cluster:fencing', JSON.stringify({
        nodeId,
        timestamp: Date.now(),
        fencedBy: this.nodeId
      }));
    }
    
    this.emit('node_fenced', { nodeId });
  }
  
  /**
   * Subscribe to cluster events via Redis
   */
  private async subscribeToClusterEvents(): Promise<void> {
    this.redisSubscriber = this.redis!.duplicate();
    
    await this.redisSubscriber.subscribe(
      'cluster:leader_change',
      'cluster:node_failure',
      'cluster:fencing'
    );
    
    this.redisSubscriber.on('message', (channel, message) => {
      try {
        const data = JSON.parse(message);
        this.handleClusterEvent(channel, data);
      } catch (error) {
        this.emit('error', { type: 'cluster_event_parse', error });
      }
    });
  }
  
  /**
   * Handle cluster events
   */
  private handleClusterEvent(channel: string, data: any): void {
    switch (channel) {
      case 'cluster:leader_change':
        if (data.leaderId !== this.clusterState.leader) {
          this.clusterState.leader = data.leaderId;
          this.isLeader = data.leaderId === this.nodeId;
          this.emit('leader_changed', data);
        }
        break;
        
      case 'cluster:node_failure':
        const nodeState = this.clusterState.nodes.get(data.nodeId);
        if (nodeState) {
          nodeState.status = 'failed';
        }
        break;
        
      case 'cluster:fencing':
        const fencedNode = this.clusterState.nodes.get(data.nodeId);
        if (fencedNode) {
          fencedNode.status = 'fenced';
        }
        break;
    }
  }
  
  /**
   * Broadcast leader change to all nodes
   */
  private async broadcastLeaderChange(): Promise<void> {
    const announcement = {
      leaderId: this.nodeId,
      epoch: this.clusterState.epoch,
      timestamp: Date.now()
    };
    
    // Use Redis pub/sub
    if (this.redis) {
      await this.redis.publish(
        'cluster:leader_change',
        JSON.stringify(announcement)
      );
    }
    
    // Also send via heartbeat
    this.sendHeartbeat();
  }
  
  /**
   * Start leader-specific tasks
   */
  private startLeaderTasks(): void {
    // Monitor cluster health
    setInterval(() => {
      this.monitorClusterHealth();
    }, 5000);
    
    // Rebalance load if needed
    setInterval(() => {
      this.rebalanceLoad();
    }, 30000);
  }
  
  /**
   * Monitor overall cluster health
   */
  private monitorClusterHealth(): void {
    const stats = {
      total: this.clusterState.nodes.size,
      active: 0,
      failed: 0,
      recovering: 0,
      fenced: 0
    };
    
    for (const nodeState of this.clusterState.nodes.values()) {
      stats[nodeState.status]++;
    }
    
    this.emit('cluster_health', stats);
    
    // Check if intervention needed
    if (stats.failed > stats.total / 2) {
      this.emit('cluster_degraded', stats);
    }
  }
  
  /**
   * Rebalance load across healthy nodes
   */
  private async rebalanceLoad(): Promise<void> {
    if (!this.isLeader) return;
    
    const healthyNodes = Array.from(this.clusterState.nodes.values())
      .filter(node => node.status === 'active');
    
    if (healthyNodes.length < 2) return;
    
    // Calculate optimal load distribution
    const totalWeight = healthyNodes.reduce((sum, node) => sum + node.config.weight, 0);
    
    const loadDistribution = healthyNodes.map(node => ({
      nodeId: node.config.id,
      targetLoad: (node.config.weight / totalWeight) * 100
    }));
    
    this.emit('load_rebalanced', { distribution: loadDistribution });
  }
  
  /**
   * Get current cluster state
   */
  getClusterState(): {
    leader: string | undefined;
    nodes: Array<{
      id: string;
      status: string;
      health: boolean;
      latency: number;
    }>;
    epoch: number;
    quorum: boolean;
  } {
    const nodes = Array.from(this.clusterState.nodes.entries()).map(([id, state]) => ({
      id,
      status: state.status,
      health: state.health.tcp && state.health.http,
      latency: state.health.latency
    }));
    
    const activeNodes = nodes.filter(n => n.status === 'active').length;
    
    return {
      leader: this.clusterState.leader,
      nodes,
      epoch: this.clusterState.epoch,
      quorum: activeNodes >= this.config.quorumSize
    };
  }
}

/**
 * Consensus module for leader election
 */
class ConsensusModule {
  constructor(
    private nodeId: string,
    private clusterState: ClusterState
  ) {}
  
  async electLeader(candidates: NodeState[]): Promise<{
    success: boolean;
    leaderId?: string;
    votes?: Map<string, string>;
    reason?: string;
  }> {
    // Simple implementation - in production, use Raft or Paxos
    if (candidates.length === 0) {
      return { success: false, reason: 'no_candidates' };
    }
    
    // Highest priority node becomes leader
    const leader = candidates[0];
    
    return {
      success: true,
      leaderId: leader.config.id,
      votes: new Map(candidates.map(c => [c.config.id, leader.config.id]))
    };
  }
}

export default AutomaticFailoverSystem;
