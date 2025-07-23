const EventEmitter = require('events');
const EnhancedMeshNetwork = require('./enhanced-mesh-network');
const crypto = require('crypto');

class MeshNetworkCoordinator extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // Coordinator settings
      coordinatorId: options.coordinatorId || crypto.randomBytes(16).toString('hex'),
      region: options.region || 'global',
      
      // Network configuration
      networkConfig: {
        port: options.port || 6001,
        wsPort: options.wsPort || 6002,
        ...options.networkConfig
      },
      
      // Coordination features
      enableLoadBalancing: options.enableLoadBalancing !== false,
      enableFailover: options.enableFailover !== false,
      enableAutoScaling: options.enableAutoScaling !== false,
      enableGeoRouting: options.enableGeoRouting !== false,
      
      // Performance
      rebalanceInterval: options.rebalanceInterval || 60000, // 1 minute
      healthCheckInterval: options.healthCheckInterval || 10000, // 10 seconds
      
      // Thresholds
      maxLoadPerNode: options.maxLoadPerNode || 1000, // messages/second
      minNodesPerRegion: options.minNodesPerRegion || 3,
      targetRedundancy: options.targetRedundancy || 3
    };
    
    // Network components
    this.meshNetwork = new EnhancedMeshNetwork(this.config.networkConfig);
    
    // Coordination state
    this.nodes = new Map();
    this.regions = new Map();
    this.workloads = new Map();
    this.failoverGroups = new Map();
    
    // Statistics
    this.stats = {
      totalNodes: 0,
      activeNodes: 0,
      totalMessages: 0,
      totalData: 0,
      coordinationEvents: 0
    };
  }
  
  async initialize() {
    this.emit('initializing');
    
    try {
      // Initialize mesh network
      await this.meshNetwork.initialize();
      
      // Setup coordination protocols
      this.setupCoordinationProtocols();
      
      // Setup event handlers
      this.setupEventHandlers();
      
      // Start coordination services
      await this.startCoordinationServices();
      
      // Register as coordinator
      await this.registerAsCoordinator();
      
      this.emit('initialized', {
        coordinatorId: this.config.coordinatorId,
        peerId: this.meshNetwork.node.peerId.toB58String()
      });
      
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  setupCoordinationProtocols() {
    // Node registration protocol
    this.meshNetwork.node.handle('/otedama/coord/register/1.0.0', async ({ stream, connection }) => {
      await this.handleNodeRegistration(stream, connection);
    });
    
    // Load balancing protocol
    this.meshNetwork.node.handle('/otedama/coord/balance/1.0.0', async ({ stream }) => {
      await this.handleLoadBalanceRequest(stream);
    });
    
    // Failover protocol
    this.meshNetwork.node.handle('/otedama/coord/failover/1.0.0', async ({ stream }) => {
      await this.handleFailoverRequest(stream);
    });
    
    // Workload reporting protocol
    this.meshNetwork.node.handle('/otedama/coord/workload/1.0.0', async ({ stream }) => {
      await this.handleWorkloadReport(stream);
    });
  }
  
  setupEventHandlers() {
    // Network events
    this.meshNetwork.on('peer:connected', (data) => {
      this.handlePeerConnected(data);
    });
    
    this.meshNetwork.on('peer:disconnected', (data) => {
      this.handlePeerDisconnected(data);
    });
    
    // Message events
    this.meshNetwork.on('message', (msg) => {
      this.handleNetworkMessage(msg);
    });
  }
  
  async startCoordinationServices() {
    // Start load balancer
    if (this.config.enableLoadBalancing) {
      this.startLoadBalancer();
    }
    
    // Start health monitoring
    this.startHealthMonitoring();
    
    // Start failover monitoring
    if (this.config.enableFailover) {
      this.startFailoverMonitoring();
    }
    
    // Start auto-scaling
    if (this.config.enableAutoScaling) {
      this.startAutoScaling();
    }
  }
  
  // Node Registration and Management
  
  async handleNodeRegistration(stream, connection) {
    try {
      const data = await this.meshNetwork.readStream(stream);
      const registration = JSON.parse(data.toString());
      
      const nodeId = registration.nodeId;
      const nodeInfo = {
        id: nodeId,
        peerId: connection.remotePeer.toB58String(),
        type: registration.type || 'worker',
        region: registration.region || 'unknown',
        capabilities: registration.capabilities || {},
        capacity: registration.capacity || {},
        joinedAt: Date.now(),
        lastSeen: Date.now(),
        status: 'active',
        workload: {
          current: 0,
          max: registration.capacity.maxLoad || this.config.maxLoadPerNode
        }
      };
      
      // Register node
      this.nodes.set(nodeId, nodeInfo);
      
      // Update region mapping
      if (!this.regions.has(nodeInfo.region)) {
        this.regions.set(nodeInfo.region, new Set());
      }
      this.regions.get(nodeInfo.region).add(nodeId);
      
      // Setup failover group
      await this.assignFailoverGroup(nodeId);
      
      // Send acknowledgment
      const response = {
        status: 'registered',
        coordinatorId: this.config.coordinatorId,
        assignedGroup: this.failoverGroups.get(nodeId),
        networkTopology: this.getNetworkTopology()
      };
      
      await this.meshNetwork.writeStream(stream, JSON.stringify(response));
      
      this.stats.totalNodes++;
      this.stats.activeNodes++;
      
      this.emit('node:registered', nodeInfo);
      
    } catch (error) {
      console.error('Failed to handle node registration:', error);
    }
  }
  
  async assignFailoverGroup(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    
    // Find or create failover group for the region
    const region = node.region;
    let group = null;
    
    for (const [groupId, members] of this.failoverGroups) {
      const groupRegion = this.nodes.get(members[0])?.region;
      if (groupRegion === region && members.length < this.config.targetRedundancy) {
        group = groupId;
        break;
      }
    }
    
    if (!group) {
      group = `group_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      this.failoverGroups.set(group, []);
    }
    
    this.failoverGroups.get(group).push(nodeId);
    node.failoverGroup = group;
  }
  
  // Load Balancing
  
  startLoadBalancer() {
    this.balanceInterval = setInterval(() => {
      this.rebalanceNetwork();
    }, this.config.rebalanceInterval);
  }
  
  async rebalanceNetwork() {
    const overloadedNodes = [];
    const underutilizedNodes = [];
    
    // Categorize nodes by load
    for (const [nodeId, node] of this.nodes) {
      if (node.status !== 'active') continue;
      
      const loadPercentage = node.workload.current / node.workload.max;
      
      if (loadPercentage > 0.8) {
        overloadedNodes.push({ nodeId, load: loadPercentage });
      } else if (loadPercentage < 0.3) {
        underutilizedNodes.push({ nodeId, load: loadPercentage });
      }
    }
    
    // Sort nodes
    overloadedNodes.sort((a, b) => b.load - a.load);
    underutilizedNodes.sort((a, b) => a.load - b.load);
    
    // Perform rebalancing
    for (const overloaded of overloadedNodes) {
      if (underutilizedNodes.length === 0) break;
      
      const target = underutilizedNodes.shift();
      await this.migrateWorkload(overloaded.nodeId, target.nodeId);
    }
    
    this.stats.coordinationEvents++;
  }
  
  async migrateWorkload(sourceNodeId, targetNodeId) {
    const sourceNode = this.nodes.get(sourceNodeId);
    const targetNode = this.nodes.get(targetNodeId);
    
    if (!sourceNode || !targetNode) return;
    
    try {
      // Calculate workload to migrate
      const excessLoad = sourceNode.workload.current - (sourceNode.workload.max * 0.7);
      const availableCapacity = (targetNode.workload.max * 0.7) - targetNode.workload.current;
      const migrateAmount = Math.min(excessLoad, availableCapacity);
      
      if (migrateAmount <= 0) return;
      
      // Send migration command
      const migrationRequest = {
        type: 'migrate_workload',
        source: sourceNodeId,
        target: targetNodeId,
        amount: migrateAmount,
        timestamp: Date.now()
      };
      
      await this.meshNetwork.sendMessage(sourceNode.peerId, migrationRequest);
      
      this.emit('workload:migrated', {
        source: sourceNodeId,
        target: targetNodeId,
        amount: migrateAmount
      });
      
    } catch (error) {
      console.error('Failed to migrate workload:', error);
    }
  }
  
  async handleLoadBalanceRequest(stream) {
    try {
      const data = await this.meshNetwork.readStream(stream);
      const request = JSON.parse(data.toString());
      
      // Find best node for the workload
      const bestNode = this.findBestNodeForWorkload(request);
      
      const response = {
        status: 'success',
        assignedNode: bestNode,
        alternativeNodes: this.findAlternativeNodes(bestNode, 3)
      };
      
      await this.meshNetwork.writeStream(stream, JSON.stringify(response));
      
    } catch (error) {
      console.error('Failed to handle load balance request:', error);
    }
  }
  
  findBestNodeForWorkload(request) {
    const { region, requiredCapacity, preferredType } = request;
    
    let candidates = Array.from(this.nodes.values()).filter(node => 
      node.status === 'active' &&
      (region ? node.region === region : true) &&
      (preferredType ? node.type === preferredType : true)
    );
    
    // Score nodes
    candidates = candidates.map(node => ({
      ...node,
      score: this.calculateNodeScore(node, requiredCapacity)
    }));
    
    // Sort by score
    candidates.sort((a, b) => b.score - a.score);
    
    return candidates[0]?.id || null;
  }
  
  calculateNodeScore(node, requiredCapacity) {
    const availableCapacity = node.workload.max - node.workload.current;
    const capacityScore = Math.min(availableCapacity / requiredCapacity, 1) * 100;
    
    const loadScore = (1 - (node.workload.current / node.workload.max)) * 50;
    
    const uptimeScore = Math.min((Date.now() - node.joinedAt) / 3600000, 1) * 20; // Up to 20 points for 1 hour uptime
    
    return capacityScore + loadScore + uptimeScore;
  }
  
  findAlternativeNodes(primaryNode, count) {
    if (!primaryNode) return [];
    
    const primary = this.nodes.get(primaryNode);
    if (!primary) return [];
    
    // Find nodes in same failover group
    const groupMembers = this.failoverGroups.get(primary.failoverGroup) || [];
    
    return groupMembers
      .filter(id => id !== primaryNode)
      .slice(0, count);
  }
  
  // Failover Management
  
  startFailoverMonitoring() {
    this.meshNetwork.on('peer:disconnected', async (data) => {
      const disconnectedNode = Array.from(this.nodes.values())
        .find(node => node.peerId === data.peerId);
      
      if (disconnectedNode) {
        await this.handleNodeFailure(disconnectedNode.id);
      }
    });
  }
  
  async handleNodeFailure(failedNodeId) {
    const failedNode = this.nodes.get(failedNodeId);
    if (!failedNode) return;
    
    failedNode.status = 'failed';
    this.stats.activeNodes--;
    
    // Get failover group
    const groupMembers = this.failoverGroups.get(failedNode.failoverGroup) || [];
    const activeMembers = groupMembers.filter(id => 
      id !== failedNodeId && this.nodes.get(id)?.status === 'active'
    );
    
    if (activeMembers.length === 0) {
      this.emit('critical:no_failover', { failedNode: failedNodeId });
      return;
    }
    
    // Distribute workload to group members
    const workloadPerNode = failedNode.workload.current / activeMembers.length;
    
    for (const nodeId of activeMembers) {
      const node = this.nodes.get(nodeId);
      if (!node) continue;
      
      try {
        const failoverCommand = {
          type: 'failover',
          failedNode: failedNodeId,
          workload: workloadPerNode,
          data: failedNode.lastKnownData || {}
        };
        
        await this.meshNetwork.sendMessage(node.peerId, failoverCommand);
        
        // Update workload
        node.workload.current += workloadPerNode;
        
      } catch (error) {
        console.error(`Failed to send failover command to ${nodeId}:`, error);
      }
    }
    
    this.emit('failover:completed', {
      failedNode: failedNodeId,
      failoverNodes: activeMembers
    });
  }
  
  // Health Monitoring
  
  startHealthMonitoring() {
    this.healthInterval = setInterval(() => {
      this.checkNodesHealth();
    }, this.config.healthCheckInterval);
  }
  
  async checkNodesHealth() {
    const now = Date.now();
    
    for (const [nodeId, node] of this.nodes) {
      if (node.status !== 'active') continue;
      
      // Check if node is responsive
      if (now - node.lastSeen > 30000) { // 30 seconds
        node.status = 'unresponsive';
        await this.handleNodeFailure(nodeId);
      }
    }
  }
  
  async handleWorkloadReport(stream) {
    try {
      const data = await this.meshNetwork.readStream(stream);
      const report = JSON.parse(data.toString());
      
      const node = this.nodes.get(report.nodeId);
      if (!node) return;
      
      // Update workload
      node.workload.current = report.currentLoad;
      node.lastSeen = Date.now();
      
      // Store workload history
      if (!this.workloads.has(report.nodeId)) {
        this.workloads.set(report.nodeId, []);
      }
      
      const history = this.workloads.get(report.nodeId);
      history.push({
        timestamp: Date.now(),
        load: report.currentLoad,
        metrics: report.metrics
      });
      
      // Keep only last hour
      const oneHourAgo = Date.now() - 3600000;
      this.workloads.set(
        report.nodeId,
        history.filter(h => h.timestamp > oneHourAgo)
      );
      
      await this.meshNetwork.writeStream(stream, JSON.stringify({ status: 'received' }));
      
    } catch (error) {
      console.error('Failed to handle workload report:', error);
    }
  }
  
  // Auto-scaling
  
  startAutoScaling() {
    this.scaleInterval = setInterval(() => {
      this.evaluateScaling();
    }, 60000); // Every minute
  }
  
  async evaluateScaling() {
    // Calculate network-wide metrics
    let totalCapacity = 0;
    let totalLoad = 0;
    const regionLoads = new Map();
    
    for (const [nodeId, node] of this.nodes) {
      if (node.status !== 'active') continue;
      
      totalCapacity += node.workload.max;
      totalLoad += node.workload.current;
      
      if (!regionLoads.has(node.region)) {
        regionLoads.set(node.region, { capacity: 0, load: 0, nodes: 0 });
      }
      
      const regionData = regionLoads.get(node.region);
      regionData.capacity += node.workload.max;
      regionData.load += node.workload.current;
      regionData.nodes++;
    }
    
    const utilizationRate = totalLoad / totalCapacity;
    
    // Scale up if utilization > 80%
    if (utilizationRate > 0.8) {
      this.emit('scale:up', {
        currentUtilization: utilizationRate,
        recommendation: Math.ceil(this.stats.activeNodes * 0.2) // Add 20% more nodes
      });
    }
    
    // Scale down if utilization < 30%
    if (utilizationRate < 0.3 && this.stats.activeNodes > this.config.minNodesPerRegion * this.regions.size) {
      this.emit('scale:down', {
        currentUtilization: utilizationRate,
        recommendation: Math.floor(this.stats.activeNodes * 0.2) // Remove 20% nodes
      });
    }
    
    // Check regional requirements
    for (const [region, data] of regionLoads) {
      if (data.nodes < this.config.minNodesPerRegion) {
        this.emit('scale:region', {
          region,
          currentNodes: data.nodes,
          required: this.config.minNodesPerRegion
        });
      }
    }
  }
  
  // Geo-routing
  
  async routeByGeography(message, targetRegion) {
    if (!this.config.enableGeoRouting) {
      throw new Error('Geo-routing is not enabled');
    }
    
    // Find nodes in target region
    const regionNodes = this.regions.get(targetRegion);
    if (!regionNodes || regionNodes.size === 0) {
      throw new Error(`No nodes available in region: ${targetRegion}`);
    }
    
    // Select best node in region
    const candidates = Array.from(regionNodes)
      .map(id => this.nodes.get(id))
      .filter(node => node && node.status === 'active');
    
    if (candidates.length === 0) {
      throw new Error(`No active nodes in region: ${targetRegion}`);
    }
    
    // Sort by load
    candidates.sort((a, b) => {
      const loadA = a.workload.current / a.workload.max;
      const loadB = b.workload.current / b.workload.max;
      return loadA - loadB;
    });
    
    const selectedNode = candidates[0];
    
    return await this.meshNetwork.sendMessage(selectedNode.peerId, message);
  }
  
  // Coordinator registration
  
  async registerAsCoordinator() {
    // Announce coordinator status
    const announcement = {
      type: 'coordinator_announce',
      coordinatorId: this.config.coordinatorId,
      region: this.config.region,
      capabilities: {
        loadBalancing: this.config.enableLoadBalancing,
        failover: this.config.enableFailover,
        autoScaling: this.config.enableAutoScaling,
        geoRouting: this.config.enableGeoRouting
      },
      contact: {
        peerId: this.meshNetwork.node.peerId.toB58String(),
        addresses: this.meshNetwork.node.multiaddrs.map(addr => addr.toString())
      }
    };
    
    await this.meshNetwork.publish('otedama:coordinators', announcement);
  }
  
  // Public API
  
  getNetworkTopology() {
    const topology = {
      nodes: Array.from(this.nodes.values()).map(node => ({
        id: node.id,
        region: node.region,
        type: node.type,
        status: node.status,
        load: node.workload.current / node.workload.max
      })),
      regions: Array.from(this.regions.entries()).map(([region, nodes]) => ({
        region,
        nodeCount: nodes.size
      })),
      failoverGroups: Array.from(this.failoverGroups.entries()).map(([group, members]) => ({
        group,
        members,
        size: members.length
      }))
    };
    
    return topology;
  }
  
  getNodeStatus(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) return null;
    
    const workloadHistory = this.workloads.get(nodeId) || [];
    
    return {
      ...node,
      workloadHistory,
      averageLoad: this.calculateAverageLoad(workloadHistory)
    };
  }
  
  calculateAverageLoad(history) {
    if (history.length === 0) return 0;
    
    const sum = history.reduce((acc, h) => acc + h.load, 0);
    return sum / history.length;
  }
  
  getStatistics() {
    const utilizationRate = this.calculateNetworkUtilization();
    
    return {
      ...this.stats,
      utilizationRate,
      regionsActive: this.regions.size,
      failoverGroupsActive: this.failoverGroups.size,
      averageNodeLoad: this.calculateAverageNetworkLoad()
    };
  }
  
  calculateNetworkUtilization() {
    let totalCapacity = 0;
    let totalLoad = 0;
    
    for (const node of this.nodes.values()) {
      if (node.status === 'active') {
        totalCapacity += node.workload.max;
        totalLoad += node.workload.current;
      }
    }
    
    return totalCapacity > 0 ? totalLoad / totalCapacity : 0;
  }
  
  calculateAverageNetworkLoad() {
    const activeNodes = Array.from(this.nodes.values())
      .filter(node => node.status === 'active');
    
    if (activeNodes.length === 0) return 0;
    
    const totalLoad = activeNodes.reduce((sum, node) => 
      sum + (node.workload.current / node.workload.max), 0
    );
    
    return totalLoad / activeNodes.length;
  }
  
  async stop() {
    if (this.balanceInterval) clearInterval(this.balanceInterval);
    if (this.healthInterval) clearInterval(this.healthInterval);
    if (this.scaleInterval) clearInterval(this.scaleInterval);
    
    await this.meshNetwork.stop();
    
    this.emit('stopped');
  }
}

module.exports = MeshNetworkCoordinator;