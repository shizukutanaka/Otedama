/**
 * Mesh Network Topology for P2P Mining Pool
 * Self-healing network with redundancy and automatic failover
 */

import { EventEmitter } from 'events';
import { Logger } from '../logger.js';

// Connection states
export const ConnectionState = {
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  FAILED: 'failed',
  RECONNECTING: 'reconnecting'
};

// Node roles in mesh network
export const NodeRole = {
  FULL: 'full',        // Full node with all capabilities
  MINER: 'miner',      // Mining node
  RELAY: 'relay',      // Relay node for routing
  BOOTSTRAP: 'bootstrap' // Bootstrap node for initial connections
};

export class MeshNetwork extends EventEmitter {
  constructor(nodeId, options = {}) {
    super();
    this.nodeId = nodeId;
    this.logger = options.logger || new Logger('MeshNetwork');
    this.options = {
      minConnections: options.minConnections || 3,
      maxConnections: options.maxConnections || 20,
      redundancy: options.redundancy || 3,
      healingInterval: options.healingInterval || 30000,
      heartbeatInterval: options.heartbeatInterval || 10000,
      connectionTimeout: options.connectionTimeout || 30000,
      maxRetries: options.maxRetries || 3,
      nodeRole: options.nodeRole || NodeRole.FULL,
      ...options
    };
    
    // Network state
    this.connections = new Map();
    this.nodes = new Map();
    this.routingTable = new Map();
    this.pendingConnections = new Map();
    
    // Network health monitoring
    this.healthMetrics = {
      totalNodes: 0,
      activeConnections: 0,
      avgLatency: 0,
      reliability: 1.0,
      networkFragmentation: 0,
      lastHealing: 0
    };
    
    // Message routing
    this.messageCache = new Map();
    this.routingCache = new Map();
    
    // Start network maintenance
    this.startNetworkHealing();
    this.startHeartbeat();
    this.startRoutingTableMaintenance();
  }
  
  /**
   * Add node to mesh network
   */
  async addNode(nodeId, nodeInfo) {
    if (nodeId === this.nodeId) return;
    
    const node = {
      id: nodeId,
      role: nodeInfo.role || NodeRole.FULL,
      endpoint: nodeInfo.endpoint,
      capabilities: nodeInfo.capabilities || [],
      location: nodeInfo.location,
      
      // Connection state
      state: ConnectionState.DISCONNECTED,
      lastSeen: Date.now(),
      latency: null,
      reliability: 1.0,
      
      // Connection attempts
      retryCount: 0,
      lastConnectionAttempt: 0,
      
      // Traffic statistics
      messagesSent: 0,
      messagesReceived: 0,
      bytesTransferred: 0,
      
      // Quality metrics
      packetLoss: 0,
      jitter: 0,
      bandwidth: nodeInfo.bandwidth || 1000,
      
      addedAt: Date.now()
    };
    
    this.nodes.set(nodeId, node);
    this.logger.info(`Added node to mesh: ${nodeId} (${node.role})`);
    
    // Attempt connection if we need more connections
    if (this.shouldConnect(node)) {
      await this.connectToNode(nodeId);
    }
    
    this.emit('node:added', { nodeId, node });
  }
  
  /**
   * Connect to a node
   */
  async connectToNode(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }
    
    // Check if already connected or connecting
    if (node.state === ConnectionState.CONNECTED || 
        node.state === ConnectionState.CONNECTING) {
      return;
    }
    
    // Check retry limits
    if (node.retryCount >= this.options.maxRetries) {
      this.logger.warn(`Max retries reached for node: ${nodeId}`);
      node.state = ConnectionState.FAILED;
      return;
    }
    
    node.state = ConnectionState.CONNECTING;
    node.lastConnectionAttempt = Date.now();
    node.retryCount++;
    
    this.logger.info(`Connecting to node: ${nodeId} (attempt ${node.retryCount})`);\n    
    try {\n      // Establish connection\n      const connection = await this.establishConnection(node);\n      \n      // Connection successful\n      node.state = ConnectionState.CONNECTED;\n      node.retryCount = 0;\n      node.lastSeen = Date.now();\n      \n      this.connections.set(nodeId, connection);\n      this.healthMetrics.activeConnections++;\n      \n      // Update routing table\n      this.updateRoutingTable(nodeId, 1);\n      \n      this.emit('connection:established', { nodeId, connection });\n      \n    } catch (error) {\n      node.state = ConnectionState.FAILED;\n      node.reliability = Math.max(0.1, node.reliability - 0.1);\n      \n      this.logger.error(`Connection failed to ${nodeId}: ${error.message}`);\n      \n      // Schedule retry\n      this.scheduleReconnection(nodeId);\n      \n      this.emit('connection:failed', { nodeId, error });\n    }\n  }\n  \n  /**\n   * Establish connection to node\n   */\n  async establishConnection(node) {\n    return new Promise((resolve, reject) => {\n      const timeout = setTimeout(() => {\n        reject(new Error('Connection timeout'));\n      }, this.options.connectionTimeout);\n      \n      // Simulate connection establishment\n      const connectionDelay = 100 + Math.random() * 200;\n      \n      setTimeout(() => {\n        clearTimeout(timeout);\n        \n        // Simulate connection failure\n        if (Math.random() < 0.1) {\n          reject(new Error('Connection refused'));\n          return;\n        }\n        \n        // Create connection object\n        const connection = {\n          nodeId: node.id,\n          endpoint: node.endpoint,\n          state: ConnectionState.CONNECTED,\n          establishedAt: Date.now(),\n          lastActivity: Date.now(),\n          \n          // Connection metrics\n          latency: 50 + Math.random() * 100,\n          bandwidth: node.bandwidth,\n          \n          // Methods\n          send: this.createSendMethod(node.id),\n          close: this.createCloseMethod(node.id)\n        };\n        \n        resolve(connection);\n        \n      }, connectionDelay);\n    });\n  }\n  \n  /**\n   * Create send method for connection\n   */\n  createSendMethod(nodeId) {\n    return async (message) => {\n      const node = this.nodes.get(nodeId);\n      if (!node) throw new Error(`Node not found: ${nodeId}`);\n      \n      // Simulate message sending\n      return new Promise((resolve, reject) => {\n        const delay = node.latency || 50;\n        \n        setTimeout(() => {\n          // Simulate packet loss\n          if (Math.random() < node.packetLoss) {\n            reject(new Error('Packet lost'));\n            return;\n          }\n          \n          node.messagesSent++;\n          node.bytesTransferred += JSON.stringify(message).length;\n          node.lastSeen = Date.now();\n          \n          resolve();\n        }, delay);\n      });\n    };\n  }\n  \n  /**\n   * Create close method for connection\n   */\n  createCloseMethod(nodeId) {\n    return () => {\n      this.disconnectFromNode(nodeId);\n    };\n  }\n  \n  /**\n   * Disconnect from node\n   */\n  disconnectFromNode(nodeId) {\n    const node = this.nodes.get(nodeId);\n    const connection = this.connections.get(nodeId);\n    \n    if (connection) {\n      this.connections.delete(nodeId);\n      this.healthMetrics.activeConnections--;\n    }\n    \n    if (node) {\n      node.state = ConnectionState.DISCONNECTED;\n      node.lastSeen = Date.now();\n    }\n    \n    // Remove from routing table\n    this.removeFromRoutingTable(nodeId);\n    \n    this.emit('connection:closed', { nodeId });\n    \n    // Schedule reconnection if needed\n    if (this.shouldReconnect(nodeId)) {\n      this.scheduleReconnection(nodeId);\n    }\n  }\n  \n  /**\n   * Send message through mesh network\n   */\n  async sendMessage(targetId, message, options = {}) {\n    const route = this.findRoute(targetId);\n    \n    if (!route) {\n      throw new Error(`No route to target: ${targetId}`);\n    }\n    \n    // Add routing header\n    const routedMessage = {\n      ...message,\n      _routing: {\n        from: this.nodeId,\n        to: targetId,\n        route: route,\n        hopCount: 0,\n        timestamp: Date.now()\n      }\n    };\n    \n    return await this.forwardMessage(routedMessage, route);\n  }\n  \n  /**\n   * Forward message through route\n   */\n  async forwardMessage(message, route) {\n    const nextHop = route[message._routing.hopCount];\n    \n    if (!nextHop) {\n      throw new Error('Invalid route');\n    }\n    \n    const connection = this.connections.get(nextHop);\n    \n    if (!connection) {\n      throw new Error(`No connection to next hop: ${nextHop}`);\n    }\n    \n    // Increment hop count\n    message._routing.hopCount++;\n    \n    // Send to next hop\n    await connection.send(message);\n    \n    // If we're the final hop, deliver message\n    if (message._routing.hopCount >= route.length) {\n      this.deliverMessage(message);\n    }\n  }\n  \n  /**\n   * Deliver message to local handler\n   */\n  deliverMessage(message) {\n    this.emit('message:received', message);\n  }\n  \n  /**\n   * Find route to target node\n   */\n  findRoute(targetId) {\n    // Check routing cache first\n    if (this.routingCache.has(targetId)) {\n      const cached = this.routingCache.get(targetId);\n      if (Date.now() - cached.timestamp < 60000) { // 1 minute cache\n        return cached.route;\n      }\n    }\n    \n    // Direct connection\n    if (this.connections.has(targetId)) {\n      return [targetId];\n    }\n    \n    // Find route through routing table\n    const route = this.dijkstraRoute(targetId);\n    \n    if (route) {\n      // Cache the route\n      this.routingCache.set(targetId, {\n        route,\n        timestamp: Date.now()\n      });\n    }\n    \n    return route;\n  }\n  \n  /**\n   * Dijkstra algorithm for route finding\n   */\n  dijkstraRoute(targetId) {\n    const distances = new Map();\n    const previous = new Map();\n    const unvisited = new Set();\n    \n    // Initialize distances\n    distances.set(this.nodeId, 0);\n    unvisited.add(this.nodeId);\n    \n    for (const [nodeId] of this.nodes) {\n      if (nodeId !== this.nodeId) {\n        distances.set(nodeId, Infinity);\n        unvisited.add(nodeId);\n      }\n    }\n    \n    while (unvisited.size > 0) {\n      // Find node with minimum distance\n      let current = null;\n      let minDistance = Infinity;\n      \n      for (const nodeId of unvisited) {\n        const distance = distances.get(nodeId);\n        if (distance < minDistance) {\n          minDistance = distance;\n          current = nodeId;\n        }\n      }\n      \n      if (current === null || minDistance === Infinity) {\n        break;\n      }\n      \n      unvisited.delete(current);\n      \n      // Check if we reached the target\n      if (current === targetId) {\n        break;\n      }\n      \n      // Update distances to neighbors\n      const neighbors = this.getNeighbors(current);\n      \n      for (const neighbor of neighbors) {\n        if (!unvisited.has(neighbor)) continue;\n        \n        const weight = this.getConnectionWeight(current, neighbor);\n        const altDistance = distances.get(current) + weight;\n        \n        if (altDistance < distances.get(neighbor)) {\n          distances.set(neighbor, altDistance);\n          previous.set(neighbor, current);\n        }\n      }\n    }\n    \n    // Reconstruct path\n    if (!previous.has(targetId)) {\n      return null;\n    }\n    \n    const path = [];\n    let current = targetId;\n    \n    while (current !== this.nodeId) {\n      path.unshift(current);\n      current = previous.get(current);\n    }\n    \n    return path;\n  }\n  \n  /**\n   * Get neighbors of a node\n   */\n  getNeighbors(nodeId) {\n    const neighbors = [];\n    \n    // Direct connections\n    if (nodeId === this.nodeId) {\n      for (const [connectedNodeId] of this.connections) {\n        neighbors.push(connectedNodeId);\n      }\n    } else {\n      // Get neighbors from routing table\n      const routes = this.routingTable.get(nodeId) || [];\n      neighbors.push(...routes.map(route => route.nextHop));\n    }\n    \n    return neighbors;\n  }\n  \n  /**\n   * Get connection weight (cost)\n   */\n  getConnectionWeight(from, to) {\n    const node = this.nodes.get(to);\n    if (!node) return Infinity;\n    \n    let weight = 1;\n    \n    // Factor in latency\n    if (node.latency) {\n      weight += node.latency / 100;\n    }\n    \n    // Factor in reliability\n    weight += (1 - node.reliability) * 2;\n    \n    // Factor in packet loss\n    weight += node.packetLoss * 5;\n    \n    return weight;\n  }\n  \n  /**\n   * Update routing table\n   */\n  updateRoutingTable(nodeId, distance, nextHop = nodeId) {\n    if (!this.routingTable.has(nodeId)) {\n      this.routingTable.set(nodeId, []);\n    }\n    \n    const routes = this.routingTable.get(nodeId);\n    const existingRoute = routes.find(r => r.nextHop === nextHop);\n    \n    if (existingRoute) {\n      existingRoute.distance = distance;\n      existingRoute.lastUpdated = Date.now();\n    } else {\n      routes.push({\n        nextHop,\n        distance,\n        lastUpdated: Date.now()\n      });\n    }\n    \n    // Sort routes by distance\n    routes.sort((a, b) => a.distance - b.distance);\n  }\n  \n  /**\n   * Remove from routing table\n   */\n  removeFromRoutingTable(nodeId) {\n    // Remove direct routes\n    this.routingTable.delete(nodeId);\n    \n    // Remove as next hop\n    for (const [targetId, routes] of this.routingTable) {\n      const filtered = routes.filter(r => r.nextHop !== nodeId);\n      if (filtered.length > 0) {\n        this.routingTable.set(targetId, filtered);\n      } else {\n        this.routingTable.delete(targetId);\n      }\n    }\n  }\n  \n  /**\n   * Check if we should connect to a node\n   */\n  shouldConnect(node) {\n    // Don't connect to ourselves\n    if (node.id === this.nodeId) return false;\n    \n    // Don't connect if already connected\n    if (node.state === ConnectionState.CONNECTED) return false;\n    \n    // Don't connect if failed too many times\n    if (node.state === ConnectionState.FAILED) return false;\n    \n    // Connect if below minimum connections\n    if (this.connections.size < this.options.minConnections) return true;\n    \n    // Connect if below maximum and node is valuable\n    if (this.connections.size < this.options.maxConnections) {\n      return this.isNodeValuable(node);\n    }\n    \n    return false;\n  }\n  \n  /**\n   * Check if node is valuable for connection\n   */\n  isNodeValuable(node) {\n    // Prefer bootstrap nodes\n    if (node.role === NodeRole.BOOTSTRAP) return true;\n    \n    // Prefer nodes with high reliability\n    if (node.reliability > 0.8) return true;\n    \n    // Prefer nodes with unique capabilities\n    const uniqueCapabilities = node.capabilities.filter(cap => \n      !Array.from(this.connections.values()).some(conn => \n        this.nodes.get(conn.nodeId)?.capabilities.includes(cap)\n      )\n    );\n    \n    return uniqueCapabilities.length > 0;\n  }\n  \n  /**\n   * Check if we should reconnect to a node\n   */\n  shouldReconnect(nodeId) {\n    const node = this.nodes.get(nodeId);\n    if (!node) return false;\n    \n    // Reconnect if below minimum connections\n    if (this.connections.size < this.options.minConnections) return true;\n    \n    // Reconnect if node is valuable\n    return this.isNodeValuable(node);\n  }\n  \n  /**\n   * Schedule reconnection to node\n   */\n  scheduleReconnection(nodeId) {\n    const node = this.nodes.get(nodeId);\n    if (!node) return;\n    \n    // Exponential backoff\n    const delay = Math.min(30000, 1000 * Math.pow(2, node.retryCount));\n    \n    setTimeout(() => {\n      if (this.shouldReconnect(nodeId)) {\n        this.connectToNode(nodeId);\n      }\n    }, delay);\n  }\n  \n  /**\n   * Start network healing process\n   */\n  startNetworkHealing() {\n    setInterval(() => {\n      this.healNetwork();\n    }, this.options.healingInterval);\n  }\n  \n  /**\n   * Heal network by ensuring connectivity\n   */\n  healNetwork() {\n    this.healthMetrics.lastHealing = Date.now();\n    \n    // Ensure minimum connections\n    if (this.connections.size < this.options.minConnections) {\n      this.addMoreConnections();\n    }\n    \n    // Remove stale connections\n    this.removeStaleConnections();\n    \n    // Update network health metrics\n    this.updateNetworkHealth();\n    \n    this.emit('network:healed', this.healthMetrics);\n  }\n  \n  /**\n   * Add more connections to meet minimum\n   */\n  addMoreConnections() {\n    const needed = this.options.minConnections - this.connections.size;\n    \n    const candidates = Array.from(this.nodes.values())\n      .filter(node => this.shouldConnect(node))\n      .sort((a, b) => b.reliability - a.reliability);\n    \n    for (let i = 0; i < Math.min(needed, candidates.length); i++) {\n      this.connectToNode(candidates[i].id);\n    }\n  }\n  \n  /**\n   * Remove stale connections\n   */\n  removeStaleConnections() {\n    const now = Date.now();\n    const staleThreshold = this.options.heartbeatInterval * 3;\n    \n    for (const [nodeId, node] of this.nodes) {\n      if (node.state === ConnectionState.CONNECTED && \n          now - node.lastSeen > staleThreshold) {\n        this.disconnectFromNode(nodeId);\n      }\n    }\n  }\n  \n  /**\n   * Update network health metrics\n   */\n  updateNetworkHealth() {\n    const activeNodes = Array.from(this.nodes.values())\n      .filter(node => node.state === ConnectionState.CONNECTED);\n    \n    this.healthMetrics.totalNodes = this.nodes.size;\n    this.healthMetrics.activeConnections = this.connections.size;\n    \n    // Calculate average latency\n    const latencies = activeNodes\n      .map(node => node.latency)\n      .filter(l => l !== null);\n    \n    this.healthMetrics.avgLatency = latencies.length > 0 \n      ? latencies.reduce((sum, l) => sum + l, 0) / latencies.length\n      : 0;\n    \n    // Calculate average reliability\n    this.healthMetrics.reliability = activeNodes.length > 0\n      ? activeNodes.reduce((sum, node) => sum + node.reliability, 0) / activeNodes.length\n      : 0;\n    \n    // Calculate network fragmentation\n    this.healthMetrics.networkFragmentation = this.calculateFragmentation();\n  }\n  \n  /**\n   * Calculate network fragmentation\n   */\n  calculateFragmentation() {\n    // Simple fragmentation metric: ratio of unreachable nodes\n    const totalNodes = this.nodes.size;\n    const reachableNodes = this.routingTable.size;\n    \n    return totalNodes > 0 ? 1 - (reachableNodes / totalNodes) : 0;\n  }\n  \n  /**\n   * Start heartbeat process\n   */\n  startHeartbeat() {\n    setInterval(() => {\n      this.sendHeartbeats();\n    }, this.options.heartbeatInterval);\n  }\n  \n  /**\n   * Send heartbeats to connected nodes\n   */\n  sendHeartbeats() {\n    const heartbeat = {\n      type: 'heartbeat',\n      from: this.nodeId,\n      timestamp: Date.now(),\n      role: this.options.nodeRole\n    };\n    \n    for (const [nodeId, connection] of this.connections) {\n      connection.send(heartbeat).catch(error => {\n        this.logger.warn(`Heartbeat failed to ${nodeId}: ${error.message}`);\n        this.disconnectFromNode(nodeId);\n      });\n    }\n  }\n  \n  /**\n   * Start routing table maintenance\n   */\n  startRoutingTableMaintenance() {\n    setInterval(() => {\n      this.maintainRoutingTable();\n    }, 60000); // Every minute\n  }\n  \n  /**\n   * Maintain routing table\n   */\n  maintainRoutingTable() {\n    const now = Date.now();\n    const staleThreshold = 300000; // 5 minutes\n    \n    // Remove stale routes\n    for (const [nodeId, routes] of this.routingTable) {\n      const freshRoutes = routes.filter(route => \n        now - route.lastUpdated < staleThreshold\n      );\n      \n      if (freshRoutes.length > 0) {\n        this.routingTable.set(nodeId, freshRoutes);\n      } else {\n        this.routingTable.delete(nodeId);\n      }\n    }\n  }\n  \n  /**\n   * Get mesh network statistics\n   */\n  getMeshStats() {\n    const stats = {\n      ...this.healthMetrics,\n      connectionsByState: {},\n      nodesByRole: {},\n      routingTableSize: this.routingTable.size\n    };\n    \n    // Count connections by state\n    for (const node of this.nodes.values()) {\n      stats.connectionsByState[node.state] = \n        (stats.connectionsByState[node.state] || 0) + 1;\n      \n      stats.nodesByRole[node.role] = \n        (stats.nodesByRole[node.role] || 0) + 1;\n    }\n    \n    return stats;\n  }\n}