// Geographic distribution and load balancing for mining pools
import { createComponentLogger } from '../logging/logger';
import * as dns from 'dns';
import * as net from 'net';
import { promisify } from 'util';

const resolveTxt = promisify(dns.resolveTxt);
const lookup = promisify(dns.lookup);

export interface PoolNode {
  id: string;
  region: string;
  endpoint: string;
  host: string;
  port: number;
  weight: number;
  capacity: number;
  currentLoad: number;
  healthy: boolean;
  latency?: number;
  lastCheck?: number;
}

export interface GeographicConfig {
  nodes: PoolNode[];
  healthCheckInterval: number;
  loadBalancingStrategy: 'round-robin' | 'least-connections' | 'weighted' | 'geo-nearest';
  geoIpDatabase?: string;
  dnsSeed?: string;
}

export interface MinerLocation {
  ip: string;
  country?: string;
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
}

// Geographic load balancer for distributed mining pools
export class GeographicLoadBalancer {
  private logger = createComponentLogger('GeographicLoadBalancer');
  private nodes = new Map<string, PoolNode>();
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private currentRoundRobinIndex = 0;
  
  constructor(private config: GeographicConfig) {
    // Initialize nodes
    for (const node of config.nodes) {
      this.nodes.set(node.id, { ...node });
    }
  }
  
  async start(): Promise<void> {
    this.logger.info('Starting geographic load balancer', {
      nodes: this.config.nodes.length,
      strategy: this.config.loadBalancingStrategy
    });
    
    // Start health checks
    await this.performHealthChecks();
    this.healthCheckTimer = setInterval(
      () => this.performHealthChecks(),
      this.config.healthCheckInterval
    );
    
    // Setup DNS seed if configured
    if (this.config.dnsSeed) {
      await this.setupDnsSeed();
    }
  }
  
  // Get best node for a miner based on location and load
  async getBestNode(minerIp: string): Promise<PoolNode | null> {
    const healthyNodes = this.getHealthyNodes();
    
    if (healthyNodes.length === 0) {
      this.logger.error('No healthy nodes available');
      return null;
    }
    
    switch (this.config.loadBalancingStrategy) {
      case 'round-robin':
        return this.getRoundRobinNode(healthyNodes);
        
      case 'least-connections':
        return this.getLeastConnectionsNode(healthyNodes);
        
      case 'weighted':
        return this.getWeightedNode(healthyNodes);
        
      case 'geo-nearest':
        return await this.getGeoNearestNode(minerIp, healthyNodes);
        
      default:
        return healthyNodes[0];
    }
  }
  
  // Round-robin selection
  private getRoundRobinNode(nodes: PoolNode[]): PoolNode {
    const node = nodes[this.currentRoundRobinIndex % nodes.length];
    this.currentRoundRobinIndex++;
    return node;
  }
  
  // Least connections selection
  private getLeastConnectionsNode(nodes: PoolNode[]): PoolNode {
    return nodes.reduce((best, node) => {
      const nodeLoad = node.currentLoad / node.capacity;
      const bestLoad = best.currentLoad / best.capacity;
      return nodeLoad < bestLoad ? node : best;
    });
  }
  
  // Weighted random selection
  private getWeightedNode(nodes: PoolNode[]): PoolNode {
    const totalWeight = nodes.reduce((sum, node) => sum + node.weight, 0);
    let random = Math.random() * totalWeight;
    
    for (const node of nodes) {
      random -= node.weight;
      if (random <= 0) {
        return node;
      }
    }
    
    return nodes[nodes.length - 1];
  }
  
  // Geographic nearest selection
  private async getGeoNearestNode(minerIp: string, nodes: PoolNode[]): Promise<PoolNode> {
    // In production, would use MaxMind GeoIP or similar
    // For now, use latency as a proxy for distance
    const minerLocation = await this.getMinerLocation(minerIp);
    
    if (!minerLocation.latitude || !minerLocation.longitude) {
      // Fallback to latency-based selection
      return this.getLowestLatencyNode(minerIp, nodes);
    }
    
    // Calculate distances to each node
    let nearestNode = nodes[0];
    let shortestDistance = Infinity;
    
    for (const node of nodes) {
      // Would need node locations in config
      const distance = this.calculateDistance(
        minerLocation.latitude,
        minerLocation.longitude,
        0, // node.latitude
        0  // node.longitude
      );
      
      if (distance < shortestDistance) {
        shortestDistance = distance;
        nearestNode = node;
      }
    }
    
    return nearestNode;
  }
  
  // Get node with lowest latency
  private async getLowestLatencyNode(minerIp: string, nodes: PoolNode[]): Promise<PoolNode> {
    // Measure latency to each node
    const latencies = await Promise.all(
      nodes.map(async node => ({
        node,
        latency: await this.measureLatency(minerIp, node.host)
      }))
    );
    
    return latencies.reduce((best, current) => 
      current.latency < best.latency ? current : best
    ).node;
  }
  
  // Calculate distance between two points
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }
  
  // Get miner location (mock implementation)
  private async getMinerLocation(ip: string): Promise<MinerLocation> {
    // In production, use GeoIP database
    return {
      ip,
      country: 'US',
      region: 'CA',
      city: 'San Francisco',
      latitude: 37.7749,
      longitude: -122.4194
    };
  }
  
  // Measure latency to a host
  private async measureLatency(fromIp: string, toHost: string): Promise<number> {
    // Simple TCP connect time measurement
    const start = Date.now();
    
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(999999); // High latency for timeout
      }, 5000);
      
      socket.connect(80, toHost, () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(Date.now() - start);
      });
      
      socket.on('error', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(999999);
      });
    });
  }
  
  // Perform health checks on all nodes
  private async performHealthChecks(): Promise<void> {
    const checks = Array.from(this.nodes.values()).map(async node => {
      try {
        const start = Date.now();
        
        // Try to connect to the node
        await new Promise<void>((resolve, reject) => {
          const socket = new net.Socket();
          const timeout = setTimeout(() => {
            socket.destroy();
            reject(new Error('Connection timeout'));
          }, 5000);
          
          socket.connect(node.port, node.host, () => {
            clearTimeout(timeout);
            socket.destroy();
            resolve();
          });
          
          socket.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });
        
        // Update node status
        node.healthy = true;
        node.latency = Date.now() - start;
        node.lastCheck = Date.now();
        
        // Get current load (would query actual node)
        // For now, simulate
        node.currentLoad = Math.floor(Math.random() * node.capacity);
        
      } catch (error) {
        node.healthy = false;
        node.lastCheck = Date.now();
        this.logger.warn('Node health check failed', {
          nodeId: node.id,
          error: (error as Error).message
        });
      }
    });
    
    await Promise.all(checks);
    
    const healthy = this.getHealthyNodes().length;
    const total = this.nodes.size;
    
    this.logger.info('Health check completed', {
      healthy,
      total,
      unhealthy: total - healthy
    });
  }
  
  // Get all healthy nodes
  private getHealthyNodes(): PoolNode[] {
    return Array.from(this.nodes.values()).filter(node => node.healthy);
  }
  
  // Setup DNS seed for node discovery
  private async setupDnsSeed(): Promise<void> {
    if (!this.config.dnsSeed) return;
    
    try {
      // Query DNS TXT records for node information
      const records = await resolveTxt(this.config.dnsSeed);
      
      for (const record of records) {
        const text = record.join('');
        // Parse node info from TXT record
        // Format: "node=id:region:host:port:weight"
        if (text.startsWith('node=')) {
          const [id, region, host, port, weight] = text.substring(5).split(':');
          
          const node: PoolNode = {
            id,
            region,
            endpoint: `${host}:${port}`,
            host,
            port: parseInt(port),
            weight: parseInt(weight) || 1,
            capacity: 1000,
            currentLoad: 0,
            healthy: false
          };
          
          this.nodes.set(id, node);
          this.logger.info('Discovered node via DNS', { node: id, region });
        }
      }
    } catch (error) {
      this.logger.error('DNS seed query failed', error as Error);
    }
  }
  
  // Update node status
  updateNodeStatus(nodeId: string, status: Partial<PoolNode>): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      Object.assign(node, status);
    }
  }
  
  // Get node statistics
  getNodeStats(): {
    total: number;
    healthy: number;
    byRegion: Record<string, number>;
    totalCapacity: number;
    totalLoad: number;
  } {
    const nodes = Array.from(this.nodes.values());
    const healthy = nodes.filter(n => n.healthy);
    
    const byRegion: Record<string, number> = {};
    for (const node of nodes) {
      byRegion[node.region] = (byRegion[node.region] || 0) + 1;
    }
    
    return {
      total: nodes.length,
      healthy: healthy.length,
      byRegion,
      totalCapacity: nodes.reduce((sum, n) => sum + n.capacity, 0),
      totalLoad: healthy.reduce((sum, n) => sum + n.currentLoad, 0)
    };
  }
  
  // Stop the load balancer
  stop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
}

// Stratum proxy for geographic distribution
export class StratumProxy {
  private logger = createComponentLogger('StratumProxy');
  private connections = new Map<string, net.Socket>();
  
  constructor(
    private localPort: number,
    private loadBalancer: GeographicLoadBalancer
  ) {}
  
  async start(): Promise<void> {
    const server = net.createServer(async (clientSocket) => {
      const clientId = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
      const clientIp = clientSocket.remoteAddress || '';
      
      this.logger.info('New proxy connection', { clientId });
      
      // Get best node for this client
      const node = await this.loadBalancer.getBestNode(clientIp);
      if (!node) {
        this.logger.error('No available nodes for client', { clientId });
        clientSocket.destroy();
        return;
      }
      
      // Connect to upstream node
      const upstreamSocket = new net.Socket();
      
      upstreamSocket.connect(node.port, node.host, () => {
        this.logger.info('Connected to upstream', {
          clientId,
          node: node.id,
          region: node.region
        });
        
        // Pipe data between client and upstream
        clientSocket.pipe(upstreamSocket);
        upstreamSocket.pipe(clientSocket);
        
        // Update node load
        this.loadBalancer.updateNodeStatus(node.id, {
          currentLoad: node.currentLoad + 1
        });
      });
      
      // Handle errors
      const cleanup = () => {
        clientSocket.destroy();
        upstreamSocket.destroy();
        this.connections.delete(clientId);
        
        // Update node load
        this.loadBalancer.updateNodeStatus(node.id, {
          currentLoad: Math.max(0, node.currentLoad - 1)
        });
      };
      
      clientSocket.on('error', cleanup);
      clientSocket.on('close', cleanup);
      upstreamSocket.on('error', cleanup);
      upstreamSocket.on('close', cleanup);
      
      // Track connection
      this.connections.set(clientId, clientSocket);
    });
    
    server.listen(this.localPort, () => {
      this.logger.info('Stratum proxy started', { port: this.localPort });
    });
  }
  
  getStats(): { connections: number } {
    return {
      connections: this.connections.size
    };
  }
}

// Example configuration
export const exampleGeographicConfig: GeographicConfig = {
  nodes: [
    {
      id: 'us-west-1',
      region: 'US-WEST',
      endpoint: 'us-west.pool.example.com:3333',
      host: 'us-west.pool.example.com',
      port: 3333,
      weight: 100,
      capacity: 10000,
      currentLoad: 0,
      healthy: true
    },
    {
      id: 'eu-central-1',
      region: 'EU-CENTRAL',
      endpoint: 'eu.pool.example.com:3333',
      host: 'eu.pool.example.com',
      port: 3333,
      weight: 80,
      capacity: 8000,
      currentLoad: 0,
      healthy: true
    },
    {
      id: 'asia-east-1',
      region: 'ASIA-EAST',
      endpoint: 'asia.pool.example.com:3333',
      host: 'asia.pool.example.com',
      port: 3333,
      weight: 60,
      capacity: 6000,
      currentLoad: 0,
      healthy: true
    }
  ],
  healthCheckInterval: 30000, // 30 seconds
  loadBalancingStrategy: 'geo-nearest',
  dnsSeed: 'pool-nodes.example.com'
};
