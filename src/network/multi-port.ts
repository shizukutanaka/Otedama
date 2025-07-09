// Multi-port support for different difficulty levels (Pike simplicity)
import * as net from 'net';
import { StratumHandler } from './stratum';
import { Channel } from './channels';
import { Share } from '../domain/share';
import { logger } from '../logging/logger';
import { DifficultyManager } from '../mining/difficulty';
import { TLSManager } from '../security/tls';

export interface PortConfiguration {
  port: number;
  difficulty: number;
  description: string;
  tls?: boolean;
  maxConnections?: number;
  vardiff?: {
    enabled: boolean;
    minDiff: number;
    maxDiff: number;
    targetTime: number;
  };
}

export interface MultiPortStats {
  port: number;
  connections: number;
  shares: number;
  hashrate: number;
  avgDifficulty: number;
}

export class MultiPortStratumServer {
  private servers = new Map<number, {
    server: net.Server;
    config: PortConfiguration;
    handler: StratumHandler;
    stats: MultiPortStats;
  }>();
  
  private shareChannel: Channel<Share>;
  private difficultyManager: DifficultyManager;
  private tlsManager?: TLSManager;
  
  constructor(
    shareChannel: Channel<Share>,
    private defaultPorts: PortConfiguration[] = [
      { port: 3333, difficulty: 1000, description: 'Low difficulty (1K)' },
      { port: 3334, difficulty: 10000, description: 'Medium difficulty (10K)' },
      { port: 3335, difficulty: 100000, description: 'High difficulty (100K)' },
      { port: 3336, difficulty: 1000000, description: 'Very high difficulty (1M)' }
    ]
  ) {
    this.shareChannel = shareChannel;
    this.difficultyManager = new DifficultyManager();
  }
  
  // Set TLS manager for secure ports
  setTLSManager(tlsManager: TLSManager): void {
    this.tlsManager = tlsManager;
  }
  
  // Start all configured ports
  async startAll(): Promise<void> {
    for (const config of this.defaultPorts) {
      await this.startPort(config);
    }
  }
  
  // Start a specific port
  async startPort(config: PortConfiguration): Promise<void> {
    if (this.servers.has(config.port)) {
      logger.warn('multi-port', `Port ${config.port} already started`);
      return;
    }
    
    // Create handler with port-specific settings
    const handler = new PortSpecificHandler(
      this.shareChannel,
      config,
      this.difficultyManager
    );
    
    // Create server (TLS or regular)
    let server: net.Server;
    
    if (config.tls && this.tlsManager) {
      const tlsServer = this.tlsManager.createServer((socket) => {
        handler.handleConnection(socket);
      });
      
      if (!tlsServer) {
        throw new Error('TLS not configured but required for port');
      }
      
      server = tlsServer;
    } else {
      server = net.createServer((socket) => {
        handler.handleConnection(socket);
      });
    }
    
    // Initialize stats
    const stats: MultiPortStats = {
      port: config.port,
      connections: 0,
      shares: 0,
      hashrate: 0,
      avgDifficulty: config.difficulty
    };
    
    // Store server info
    this.servers.set(config.port, {
      server,
      config,
      handler,
      stats
    });
    
    // Start listening
    await new Promise<void>((resolve, reject) => {
      server.listen(config.port, () => {
        logger.info('multi-port', 
          `Started ${config.tls ? 'TLS ' : ''}Stratum on port ${config.port}: ${config.description}`
        );
        resolve();
      });
      
      server.on('error', (error) => {
        logger.error('multi-port', `Port ${config.port} error:`, error);
        reject(error);
      });
    });
  }
  
  // Stop a specific port
  stopPort(port: number): void {
    const serverInfo = this.servers.get(port);
    if (!serverInfo) {
      return;
    }
    
    serverInfo.server.close();
    this.servers.delete(port);
    
    logger.info('multi-port', `Stopped Stratum on port ${port}`);
  }
  
  // Stop all ports
  stopAll(): void {
    for (const port of this.servers.keys()) {
      this.stopPort(port);
    }
  }
  
  // Get statistics for all ports
  getStatistics(): MultiPortStats[] {
    const stats: MultiPortStats[] = [];
    
    for (const [port, serverInfo] of this.servers) {
      // Update current stats
      const handler = serverInfo.handler as PortSpecificHandler;
      serverInfo.stats.connections = handler.getConnectionCount();
      serverInfo.stats.shares = handler.getShareCount();
      serverInfo.stats.hashrate = handler.getHashrate();
      
      stats.push({ ...serverInfo.stats });
    }
    
    return stats;
  }
  
  // Get port configuration
  getPortConfig(port: number): PortConfiguration | undefined {
    return this.servers.get(port)?.config;
  }
  
  // Update port configuration
  async updatePortConfig(port: number, updates: Partial<PortConfiguration>): Promise<void> {
    const serverInfo = this.servers.get(port);
    if (!serverInfo) {
      throw new Error(`Port ${port} not found`);
    }
    
    // Stop current server
    this.stopPort(port);
    
    // Update config
    const newConfig = { ...serverInfo.config, ...updates };
    
    // Restart with new config
    await this.startPort(newConfig);
  }
  
  // Add custom port
  async addCustomPort(config: PortConfiguration): Promise<void> {
    // Validate port
    if (config.port < 1 || config.port > 65535) {
      throw new Error('Invalid port number');
    }
    
    if (this.servers.has(config.port)) {
      throw new Error(`Port ${config.port} already in use`);
    }
    
    await this.startPort(config);
  }
  
  // Get available ports
  getAvailablePorts(): PortConfiguration[] {
    return Array.from(this.servers.values()).map(s => s.config);
  }
}

// Port-specific Stratum handler
class PortSpecificHandler extends StratumHandler {
  private shareCount = 0;
  private connectionCount = 0;
  private lastShareTime = Date.now();
  private shares: number[] = []; // Timestamp array for hashrate calculation
  
  constructor(
    shareChannel: Channel<Share>,
    private portConfig: PortConfiguration,
    private difficultyManager: DifficultyManager
  ) {
    super(shareChannel);
  }
  
  async handleConnection(socket: net.Socket): Promise<void> {
    // Check connection limit
    if (this.portConfig.maxConnections && 
        this.connectionCount >= this.portConfig.maxConnections) {
      socket.destroy();
      return;
    }
    
    this.connectionCount++;
    
    // Set initial difficulty based on port
    const minerId = `${socket.remoteAddress}:${socket.remotePort}`;
    this.setMinerDifficulty(minerId, this.portConfig.difficulty);
    
    // Call parent handler
    await super.handleConnection(socket);
    
    socket.on('close', () => {
      this.connectionCount--;
    });
  }
  
  private setMinerDifficulty(minerId: string, difficulty: number): void {
    // Set initial difficulty for miner
    // This would be integrated with the actual miner connection
  }
  
  // Override share submission to track stats
  protected async handleShareSubmission(share: Share): Promise<void> {
    this.shareCount++;
    this.shares.push(Date.now());
    
    // Clean old shares (older than 10 minutes)
    const cutoff = Date.now() - 600000;
    this.shares = this.shares.filter(t => t > cutoff);
    
    // Apply vardiff if enabled
    if (this.portConfig.vardiff?.enabled) {
      this.difficultyManager.recordShare(share.minerId);
      
      const newDiff = this.difficultyManager.getDifficulty(share.minerId);
      if (newDiff !== share.difficulty) {
        this.setMinerDifficulty(share.minerId, newDiff);
      }
    }
  }
  
  getConnectionCount(): number {
    return this.connectionCount;
  }
  
  getShareCount(): number {
    return this.shareCount;
  }
  
  getHashrate(): number {
    // Estimate hashrate based on shares and difficulty
    if (this.shares.length < 2) return 0;
    
    const timeSpan = (Date.now() - this.shares[0]) / 1000; // seconds
    const avgDifficulty = this.portConfig.difficulty;
    
    // Hashrate = (shares * difficulty * 2^32) / time
    return (this.shares.length * avgDifficulty * 4294967296) / timeSpan;
  }
}

// Port manager for dynamic port allocation
export class PortManager {
  private usedPorts = new Set<number>();
  private portRanges: Array<{ start: number; end: number }> = [];
  
  constructor(
    private multiPortServer: MultiPortStratumServer,
    portRanges: Array<{ start: number; end: number }> = [
      { start: 3333, end: 3399 },  // Stratum range
      { start: 4443, end: 4499 }   // TLS Stratum range
    ]
  ) {
    this.portRanges = portRanges;
    this.scanUsedPorts();
  }
  
  // Scan for ports already in use
  private scanUsedPorts(): void {
    for (const config of this.multiPortServer.getAvailablePorts()) {
      this.usedPorts.add(config.port);
    }
  }
  
  // Allocate next available port
  allocatePort(preferredRange?: { start: number; end: number }): number | null {
    const ranges = preferredRange ? [preferredRange] : this.portRanges;
    
    for (const range of ranges) {
      for (let port = range.start; port <= range.end; port++) {
        if (!this.usedPorts.has(port) && this.isPortAvailable(port)) {
          this.usedPorts.add(port);
          return port;
        }
      }
    }
    
    return null;
  }
  
  // Check if port is available on system
  private isPortAvailable(port: number): boolean {
    // Simple check - in production would actually test binding
    return !this.usedPorts.has(port);
  }
  
  // Release port
  releasePort(port: number): void {
    this.usedPorts.delete(port);
  }
  
  // Get port usage statistics
  getUsageStats(): {
    totalPorts: number;
    usedPorts: number;
    availablePorts: number;
    ranges: Array<{
      range: string;
      used: number;
      available: number;
    }>;
  } {
    const rangeStats = this.portRanges.map(range => {
      let used = 0;
      for (let port = range.start; port <= range.end; port++) {
        if (this.usedPorts.has(port)) used++;
      }
      
      const total = range.end - range.start + 1;
      return {
        range: `${range.start}-${range.end}`,
        used,
        available: total - used
      };
    });
    
    const totalPorts = this.portRanges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
    
    return {
      totalPorts,
      usedPorts: this.usedPorts.size,
      availablePorts: totalPorts - this.usedPorts.size,
      ranges: rangeStats
    };
  }
}
