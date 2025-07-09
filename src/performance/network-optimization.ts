// Network buffer optimization for TCP performance (Carmack style)
import * as net from 'net';
import { createComponentLogger } from '../logging/logger';

const logger = createComponentLogger('network-optimization');

// TCP optimization settings
export interface TCPOptimizationConfig {
  // Socket buffer sizes
  sendBufferSize?: number;
  receiveBufferSize?: number;
  
  // Keep-alive settings
  keepAlive?: boolean;
  keepAliveInitialDelay?: number;
  
  // No delay (Nagle's algorithm)
  noDelay?: boolean;
  
  // Connection timeout
  timeout?: number;
  
  // Backlog size for server
  backlog?: number;
  
  // Socket options
  allowHalfOpen?: boolean;
  
  // Performance hints
  performancePreferences?: {
    connectionTime: number;
    latency: number;
    bandwidth: number;
  };
}

// Default optimized settings for mining pool
const DEFAULT_MINING_POOL_CONFIG: TCPOptimizationConfig = {
  sendBufferSize: 64 * 1024,      // 64KB send buffer
  receiveBufferSize: 64 * 1024,   // 64KB receive buffer
  keepAlive: true,
  keepAliveInitialDelay: 30000,   // 30 seconds
  noDelay: true,                  // Disable Nagle's for low latency
  timeout: 300000,                // 5 minutes
  backlog: 511,                   // Maximum pending connections
  allowHalfOpen: false,
  performancePreferences: {
    connectionTime: 0,
    latency: 1,      // Prioritize low latency
    bandwidth: 2
  }
};

// Optimize a socket for mining pool use
export function optimizeSocket(
  socket: net.Socket,
  config: TCPOptimizationConfig = DEFAULT_MINING_POOL_CONFIG
): void {
  try {
    // Set keep-alive
    if (config.keepAlive !== undefined) {
      socket.setKeepAlive(config.keepAlive, config.keepAliveInitialDelay || 30000);
    }
    
    // Set no delay (disable Nagle's algorithm)
    if (config.noDelay !== undefined) {
      socket.setNoDelay(config.noDelay);
    }
    
    // Set timeout
    if (config.timeout !== undefined) {
      socket.setTimeout(config.timeout);
    }
    
    // Platform-specific optimizations
    const handle = (socket as any)._handle;
    if (handle && handle.fd !== undefined) {
      // Linux/Unix specific optimizations
      optimizeSocketLinux(handle.fd, config);
    }
    
    logger.debug('Socket optimized', {
      remoteAddress: socket.remoteAddress,
      keepAlive: config.keepAlive,
      noDelay: config.noDelay
    });
  } catch (error) {
    logger.error('Failed to optimize socket', error as Error);
  }
}

// Linux-specific socket optimizations
function optimizeSocketLinux(fd: number, config: TCPOptimizationConfig): void {
  // In production, would use node-syscall or similar to set:
  // - SO_SNDBUF: Send buffer size
  // - SO_RCVBUF: Receive buffer size
  // - TCP_NODELAY: Already set via setNoDelay
  // - TCP_CORK: Batch small writes
  // - SO_REUSEADDR: Allow address reuse
  // - TCP_QUICKACK: Disable delayed ACKs
  
  logger.debug('Linux socket optimizations would be applied', { fd });
}

// Create optimized server
export function createOptimizedServer(
  config: TCPOptimizationConfig = DEFAULT_MINING_POOL_CONFIG
): net.Server {
  const server = net.createServer({
    allowHalfOpen: config.allowHalfOpen || false
  });
  
  // Set backlog
  const originalListen = server.listen.bind(server);
  server.listen = function(...args: any[]): net.Server {
    // Inject backlog into options
    if (typeof args[0] === 'object' && args[0] !== null) {
      args[0].backlog = config.backlog || 511;
    } else if (typeof args[0] === 'number') {
      // Port number provided, add options
      if (typeof args[1] === 'string') {
        // Host provided
        args[3] = config.backlog || 511;
      } else {
        args[2] = config.backlog || 511;
      }
    }
    
    return originalListen(...args);
  };
  
  // Optimize each incoming connection
  server.on('connection', (socket) => {
    optimizeSocket(socket, config);
  });
  
  return server;
}

// Buffer pool for network operations
export class NetworkBufferPool {
  private pools = new Map<number, Buffer[]>();
  private stats = {
    allocated: 0,
    reused: 0,
    active: 0
  };
  
  // Get buffer from pool
  acquire(size: number): Buffer {
    const poolSize = this.normalizeSize(size);
    
    if (!this.pools.has(poolSize)) {
      this.pools.set(poolSize, []);
    }
    
    const pool = this.pools.get(poolSize)!;
    
    if (pool.length > 0) {
      this.stats.reused++;
      this.stats.active++;
      return pool.pop()!;
    }
    
    // Allocate new buffer
    this.stats.allocated++;
    this.stats.active++;
    return Buffer.allocUnsafe(poolSize);
  }
  
  // Return buffer to pool
  release(buffer: Buffer): void {
    const poolSize = this.normalizeSize(buffer.length);
    const pool = this.pools.get(poolSize);
    
    if (pool && pool.length < 100) { // Keep max 100 buffers per size
      buffer.fill(0); // Clear sensitive data
      pool.push(buffer);
      this.stats.active--;
    }
  }
  
  // Normalize size to standard pool sizes
  private normalizeSize(size: number): number {
    // Standard sizes: 1KB, 4KB, 16KB, 64KB, 256KB, 1MB
    const sizes = [1024, 4096, 16384, 65536, 262144, 1048576];
    
    for (const standardSize of sizes) {
      if (size <= standardSize) {
        return standardSize;
      }
    }
    
    return size; // Use exact size for very large buffers
  }
  
  // Get pool statistics
  getStats(): typeof this.stats & { poolSizes: number[] } {
    return {
      ...this.stats,
      poolSizes: Array.from(this.pools.keys())
    };
  }
  
  // Clear all pools
  clear(): void {
    this.pools.clear();
    this.stats.active = 0;
  }
}

// Network congestion controller
export class CongestionController {
  private windowSize = 10;
  private minWindowSize = 2;
  private maxWindowSize = 100;
  private rtt = 100; // Estimated RTT in ms
  private packetLoss = 0;
  private lastAdjustment = Date.now();
  
  constructor(
    private onWindowChange?: (size: number) => void
  ) {}
  
  // Record successful transmission
  recordSuccess(rttMs: number): void {
    // Update RTT estimate (exponential moving average)
    this.rtt = this.rtt * 0.8 + rttMs * 0.2;
    
    // Increase window size (slow start / congestion avoidance)
    if (this.windowSize < this.maxWindowSize) {
      if (this.windowSize < 10) {
        // Slow start: exponential increase
        this.windowSize = Math.min(this.windowSize * 2, this.maxWindowSize);
      } else {
        // Congestion avoidance: linear increase
        this.windowSize = Math.min(this.windowSize + 1, this.maxWindowSize);
      }
      
      this.notifyWindowChange();
    }
    
    // Reset packet loss counter
    this.packetLoss = Math.max(0, this.packetLoss - 0.1);
  }
  
  // Record transmission failure
  recordFailure(): void {
    this.packetLoss++;
    
    // Multiplicative decrease on congestion
    if (this.packetLoss > 1) {
      this.windowSize = Math.max(
        this.minWindowSize,
        Math.floor(this.windowSize / 2)
      );
      
      this.notifyWindowChange();
      this.packetLoss = 0;
    }
  }
  
  // Get current window size
  getWindowSize(): number {
    return this.windowSize;
  }
  
  // Get estimated RTT
  getRTT(): number {
    return this.rtt;
  }
  
  // Calculate optimal timeout
  getTimeout(): number {
    // Timeout = RTT + 4 * RTT variance (simplified)
    return Math.max(1000, this.rtt * 3);
  }
  
  private notifyWindowChange(): void {
    if (this.onWindowChange) {
      this.onWindowChange(this.windowSize);
    }
  }
  
  // Get congestion statistics
  getStats(): {
    windowSize: number;
    rtt: number;
    packetLoss: number;
    timeout: number;
  } {
    return {
      windowSize: this.windowSize,
      rtt: this.rtt,
      packetLoss: this.packetLoss,
      timeout: this.getTimeout()
    };
  }
}

// Bandwidth throttler
export class BandwidthThrottler {
  private tokens: number;
  private lastRefill = Date.now();
  
  constructor(
    private bytesPerSecond: number,
    private burstSize: number = bytesPerSecond
  ) {
    this.tokens = burstSize;
  }
  
  // Check if can send data
  canSend(bytes: number): boolean {
    this.refillTokens();
    return this.tokens >= bytes;
  }
  
  // Consume tokens
  consume(bytes: number): boolean {
    this.refillTokens();
    
    if (this.tokens >= bytes) {
      this.tokens -= bytes;
      return true;
    }
    
    return false;
  }
  
  // Calculate wait time for bytes
  getWaitTime(bytes: number): number {
    this.refillTokens();
    
    if (this.tokens >= bytes) {
      return 0;
    }
    
    const tokensNeeded = bytes - this.tokens;
    const secondsToWait = tokensNeeded / this.bytesPerSecond;
    
    return Math.ceil(secondsToWait * 1000); // Convert to milliseconds
  }
  
  private refillTokens(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // Convert to seconds
    
    const tokensToAdd = elapsed * this.bytesPerSecond;
    this.tokens = Math.min(this.burstSize, this.tokens + tokensToAdd);
    
    this.lastRefill = now;
  }
  
  // Update rate limit
  setRate(bytesPerSecond: number, burstSize?: number): void {
    this.bytesPerSecond = bytesPerSecond;
    this.burstSize = burstSize || bytesPerSecond;
    this.tokens = Math.min(this.tokens, this.burstSize);
  }
  
  // Get current state
  getState(): {
    tokens: number;
    rate: number;
    burst: number;
  } {
    this.refillTokens();
    
    return {
      tokens: this.tokens,
      rate: this.bytesPerSecond,
      burst: this.burstSize
    };
  }
}

// Export singleton buffer pool
export const networkBufferPool = new NetworkBufferPool();
