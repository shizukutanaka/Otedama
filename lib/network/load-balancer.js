/**
 * Load Balancer - Otedama
 * Simple, efficient load balancing for pool servers
 */

import { EventEmitter } from 'events';
import { createLogger } from '../core/logger.js';

const logger = createLogger('LoadBalancer');

export class LoadBalancer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.algorithm = options.algorithm || 'least-connections';
    this.healthCheckInterval = options.healthCheckInterval || 10000;
    this.connectionTimeout = options.connectionTimeout || 30000;
    
    this.servers = new Map();
    this.roundRobinIndex = 0;
    this.isRunning = false;
  }
  
  addServer(id, config) {
    const server = {
      id,
      host: config.host,
      port: config.port,
      weight: config.weight || 1,
      healthy: true,
      connections: 0,
      totalRequests: 0,
      failedRequests: 0,
      lastHealthCheck: Date.now()
    };
    
    this.servers.set(id, server);
    logger.info(`Added server ${id} at ${server.host}:${server.port}`);
    
    return server;
  }
  
  removeServer(id) {
    const removed = this.servers.delete(id);
    if (removed) {
      logger.info(`Removed server ${id}`);
    }
    return removed;
  }
  
  selectServer() {
    // Get healthy servers
    const healthyServers = Array.from(this.servers.values())
      .filter(s => s.healthy);
    
    if (healthyServers.length === 0) {
      return null;
    }
    
    // Select based on algorithm
    switch (this.algorithm) {
      case 'round-robin':
        return this.roundRobin(healthyServers);
        
      case 'least-connections':
        return this.leastConnections(healthyServers);
        
      case 'weighted':
        return this.weighted(healthyServers);
        
      case 'random':
        return healthyServers[Math.floor(Math.random() * healthyServers.length)];
        
      default:
        return healthyServers[0];
    }
  }
  
  roundRobin(servers) {
    const server = servers[this.roundRobinIndex % servers.length];
    this.roundRobinIndex++;
    return server;
  }
  
  leastConnections(servers) {
    return servers.reduce((min, server) => 
      server.connections < min.connections ? server : min
    );
  }
  
  weighted(servers) {
    const totalWeight = servers.reduce((sum, s) => sum + s.weight, 0);
    let random = Math.random() * totalWeight;
    
    for (const server of servers) {
      random -= server.weight;
      if (random <= 0) {
        return server;
      }
    }
    
    return servers[servers.length - 1];
  }
  
  // Connection tracking
  incrementConnections(serverId) {
    const server = this.servers.get(serverId);
    if (server) {
      server.connections++;
      server.totalRequests++;
    }
  }
  
  decrementConnections(serverId) {
    const server = this.servers.get(serverId);
    if (server && server.connections > 0) {
      server.connections--;
    }
  }
  
  reportFailure(serverId) {
    const server = this.servers.get(serverId);
    if (server) {
      server.failedRequests++;
      
      // Mark unhealthy if too many failures
      const failureRate = server.failedRequests / server.totalRequests;
      if (failureRate > 0.5 && server.totalRequests > 10) {
        server.healthy = false;
        logger.warn(`Server ${serverId} marked unhealthy due to high failure rate`);
      }
    }
  }
  
  // Health checks
  startHealthChecks() {
    if (this.healthCheckTimer) return;
    
    this.healthCheckTimer = setInterval(() => {
      this.checkAllServers();
    }, this.healthCheckInterval);
    
    // Initial check
    this.checkAllServers();
  }
  
  stopHealthChecks() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
  
  async checkAllServers() {
    const promises = Array.from(this.servers.values()).map(server => 
      this.checkServer(server)
    );
    
    await Promise.allSettled(promises);
  }
  
  async checkServer(server) {
    try {
      // Simple TCP health check
      const net = require('net');
      
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({
          port: server.port,
          host: server.host,
          timeout: 5000
        });
        
        socket.on('connect', () => {
          socket.destroy();
          resolve();
        });
        
        socket.on('error', reject);
        socket.on('timeout', () => {
          socket.destroy();
          reject(new Error('Timeout'));
        });
      });
      
      // Server is healthy
      if (!server.healthy) {
        server.healthy = true;
        logger.info(`Server ${server.id} is now healthy`);
        this.emit('server:healthy', server);
      }
      
      server.lastHealthCheck = Date.now();
      
    } catch (error) {
      // Server is unhealthy
      if (server.healthy) {
        server.healthy = false;
        logger.warn(`Server ${server.id} is now unhealthy: ${error.message}`);
        this.emit('server:unhealthy', server);
      }
      
      server.lastHealthCheck = Date.now();
    }
  }
  
  start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.startHealthChecks();
    
    logger.info(`Load balancer started with ${this.algorithm} algorithm`);
  }
  
  stop() {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    this.stopHealthChecks();
    
    logger.info('Load balancer stopped');
  }
  
  getStats() {
    const stats = {
      algorithm: this.algorithm,
      totalServers: this.servers.size,
      healthyServers: 0,
      totalConnections: 0,
      totalRequests: 0,
      servers: []
    };
    
    for (const server of this.servers.values()) {
      if (server.healthy) stats.healthyServers++;
      stats.totalConnections += server.connections;
      stats.totalRequests += server.totalRequests;
      
      stats.servers.push({
        id: server.id,
        healthy: server.healthy,
        connections: server.connections,
        requests: server.totalRequests,
        failures: server.failedRequests,
        failureRate: server.totalRequests > 0 ? 
          server.failedRequests / server.totalRequests : 0
      });
    }
    
    return stats;
  }
}

export default LoadBalancer;
