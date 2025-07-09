#!/usr/bin/env node
// Mining Pool Simulator - Test the pool without real hardware
import * as net from 'net';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';

interface SimulatorConfig {
  poolHost: string;
  poolPort: number;
  numMiners: number;
  minerPrefix: string;
  targetHashrate: number; // Total hashrate in H/s
  shareSubmissionRate: number; // Shares per second per miner
  invalidShareRate: number; // Percentage of invalid shares (0-100)
  reconnectOnError: boolean;
  variableHashrate: boolean; // Simulate hashrate fluctuations
  simulateDisconnects: boolean;
  logLevel: 'debug' | 'info' | 'error';
}

interface MinerStats {
  connected: boolean;
  shares: number;
  accepted: number;
  rejected: number;
  hashrate: number;
  lastShare: number;
  errors: number;
}

class VirtualMiner extends EventEmitter {
  private socket: net.Socket | null = null;
  private address: string;
  private stats: MinerStats;
  private shareTimer: NodeJS.Timeout | null = null;
  private currentJob: any = null;
  private extraNonce1: string = '';
  private extraNonce2Size: number = 4;
  private difficulty: number = 1;
  
  constructor(
    private id: number,
    private config: SimulatorConfig
  ) {
    super();
    this.address = `${config.minerPrefix}${id.toString().padStart(4, '0')}`;
    this.stats = {
      connected: false,
      shares: 0,
      accepted: 0,
      rejected: 0,
      hashrate: config.targetHashrate / config.numMiners,
      lastShare: Date.now(),
      errors: 0
    };
  }
  
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      
      this.socket.on('connect', () => {
        this.stats.connected = true;
        this.log('info', `Miner ${this.id} connected`);
        this.sendSubscribe();
        this.sendAuthorize();
        resolve();
      });
      
      this.socket.on('data', (data) => {
        this.handleStratumMessage(data.toString());
      });
      
      this.socket.on('error', (error) => {
        this.stats.errors++;
        this.log('error', `Miner ${this.id} error: ${error.message}`);
        if (this.config.reconnectOnError) {
          setTimeout(() => this.reconnect(), 5000);
        }
      });
      
      this.socket.on('close', () => {
        this.stats.connected = false;
        this.stopMining();
        this.log('info', `Miner ${this.id} disconnected`);
      });
      
      this.socket.connect(this.config.poolPort, this.config.poolHost);
      
      // Timeout connection attempt
      setTimeout(() => {
        if (!this.stats.connected) {
          reject(new Error('Connection timeout'));
        }
      }, 10000);
    });
  }
  
  private handleStratumMessage(data: string): void {
    const lines = data.trim().split('\n');
    
    for (const line of lines) {
      try {
        const message = JSON.parse(line);
        this.processStratumMessage(message);
      } catch (error) {
        this.log('error', `Failed to parse message: ${line}`);
      }
    }
  }
  
  private processStratumMessage(message: any): void {
    // Handle responses
    if (message.id !== null && message.result !== undefined) {
      if (message.id === 1) {
        // Subscribe response
        if (Array.isArray(message.result) && message.result.length >= 2) {
          this.extraNonce1 = message.result[1];
          this.extraNonce2Size = message.result[2];
          this.log('debug', `Received subscribe response: extraNonce1=${this.extraNonce1}`);
        }
      } else if (message.id === 2) {
        // Authorize response
        if (message.result === true) {
          this.log('info', `Miner ${this.id} authorized`);
          this.startMining();
        } else {
          this.log('error', `Miner ${this.id} authorization failed`);
        }
      } else if (message.id >= 1000) {
        // Share submission response
        if (message.result === true) {
          this.stats.accepted++;
          this.log('debug', `Share accepted for miner ${this.id}`);
        } else {
          this.stats.rejected++;
          this.log('debug', `Share rejected for miner ${this.id}`);
        }
      }
    }
    
    // Handle notifications
    if (message.method) {
      switch (message.method) {
        case 'mining.notify':
          this.currentJob = message.params;
          this.log('debug', `New job received for miner ${this.id}`);
          break;
          
        case 'mining.set_difficulty':
          this.difficulty = message.params[0];
          this.log('debug', `Difficulty set to ${this.difficulty} for miner ${this.id}`);
          break;
          
        case 'client.reconnect':
          this.log('info', `Reconnect requested for miner ${this.id}`);
          this.reconnect();
          break;
      }
    }
  }
  
  private sendSubscribe(): void {
    const subscribe = {
      id: 1,
      method: 'mining.subscribe',
      params: [`OtedamaSimulator/${this.id}`, null]
    };
    this.sendMessage(subscribe);
  }
  
  private sendAuthorize(): void {
    const authorize = {
      id: 2,
      method: 'mining.authorize',
      params: [this.address, 'x']
    };
    this.sendMessage(authorize);
  }
  
  private sendMessage(message: any): void {
    if (this.socket && this.stats.connected) {
      this.socket.write(JSON.stringify(message) + '\n');
    }
  }
  
  private startMining(): void {
    const baseInterval = 1000 / this.config.shareSubmissionRate;
    
    const submitShare = () => {
      if (!this.stats.connected || !this.currentJob) return;
      
      // Simulate hashrate variations
      let interval = baseInterval;
      if (this.config.variableHashrate) {
        // Add ±20% variation
        interval = baseInterval * (0.8 + Math.random() * 0.4);
      }
      
      // Generate and submit share
      this.submitShare();
      
      // Update stats
      this.stats.shares++;
      this.stats.lastShare = Date.now();
      
      // Calculate actual hashrate based on share submission
      const difficulty = this.difficulty || 1;
      this.stats.hashrate = (difficulty * Math.pow(2, 32)) / interval * 1000;
      
      // Schedule next share
      this.shareTimer = setTimeout(submitShare, interval);
    };
    
    // Start with random delay to spread load
    setTimeout(submitShare, Math.random() * baseInterval);
  }
  
  private stopMining(): void {
    if (this.shareTimer) {
      clearTimeout(this.shareTimer);
      this.shareTimer = null;
    }
  }
  
  private submitShare(): void {
    if (!this.currentJob) return;
    
    const jobId = this.currentJob[0];
    const prevHash = this.currentJob[1];
    const coinbase1 = this.currentJob[2];
    const coinbase2 = this.currentJob[3];
    const merkleBranches = this.currentJob[4];
    const version = this.currentJob[5];
    const nbits = this.currentJob[6];
    const ntime = this.currentJob[7];
    
    // Generate random nonce and extraNonce2
    const nonce = crypto.randomBytes(4).toString('hex');
    const extraNonce2 = crypto.randomBytes(this.extraNonce2Size).toString('hex');
    
    // Simulate invalid shares based on configured rate
    const isInvalid = Math.random() * 100 < this.config.invalidShareRate;
    const submittedNonce = isInvalid ? '00000000' : nonce;
    
    const share = {
      id: 1000 + this.stats.shares,
      method: 'mining.submit',
      params: [
        this.address,
        jobId,
        extraNonce2,
        ntime,
        submittedNonce
      ]
    };
    
    this.sendMessage(share);
  }
  
  private async reconnect(): Promise<void> {
    this.disconnect();
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    try {
      await this.connect();
    } catch (error) {
      this.log('error', `Reconnection failed for miner ${this.id}`);
    }
  }
  
  disconnect(): void {
    this.stopMining();
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.stats.connected = false;
  }
  
  getStats(): MinerStats {
    return { ...this.stats };
  }
  
  simulateDisconnect(): void {
    if (this.stats.connected) {
      this.log('info', `Simulating disconnect for miner ${this.id}`);
      this.disconnect();
      
      // Reconnect after random delay
      if (this.config.reconnectOnError) {
        const delay = 5000 + Math.random() * 10000;
        setTimeout(() => this.reconnect(), delay);
      }
    }
  }
  
  private log(level: string, message: string): void {
    if (this.config.logLevel === 'debug' || 
        (this.config.logLevel === 'info' && level !== 'debug') ||
        (this.config.logLevel === 'error' && level === 'error')) {
      console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`);
    }
  }
}

class PoolSimulator {
  private miners: VirtualMiner[] = [];
  private stats: {
    totalShares: number;
    totalAccepted: number;
    totalRejected: number;
    startTime: number;
  };
  
  constructor(private config: SimulatorConfig) {
    this.stats = {
      totalShares: 0,
      totalAccepted: 0,
      totalRejected: 0,
      startTime: Date.now()
    };
  }
  
  async start(): Promise<void> {
    console.log(`🚀 Starting mining pool simulator with ${this.config.numMiners} miners\n`);
    
    // Create virtual miners
    for (let i = 0; i < this.config.numMiners; i++) {
      const miner = new VirtualMiner(i, this.config);
      this.miners.push(miner);
    }
    
    // Connect miners with staggered timing
    for (let i = 0; i < this.miners.length; i++) {
      try {
        await this.miners[i].connect();
        // Small delay between connections to avoid overwhelming the pool
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`Failed to connect miner ${i}:`, error);
      }
    }
    
    // Start monitoring
    this.startMonitoring();
    
    // Simulate random disconnects if enabled
    if (this.config.simulateDisconnects) {
      this.startDisconnectSimulation();
    }
    
    // Handle graceful shutdown
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }
  
  private startMonitoring(): void {
    // Update stats every 10 seconds
    setInterval(() => {
      this.printStats();
    }, 10000);
    
    // Detailed report every minute
    setInterval(() => {
      this.printDetailedReport();
    }, 60000);
  }
  
  private startDisconnectSimulation(): void {
    setInterval(() => {
      // Randomly disconnect 1-5% of miners
      const numToDisconnect = Math.ceil(this.miners.length * (0.01 + Math.random() * 0.04));
      const connected = this.miners.filter(m => m.getStats().connected);
      
      for (let i = 0; i < numToDisconnect && i < connected.length; i++) {
        const randomMiner = connected[Math.floor(Math.random() * connected.length)];
        randomMiner.simulateDisconnect();
      }
    }, 30000); // Every 30 seconds
  }
  
  private printStats(): void {
    const minerStats = this.miners.map(m => m.getStats());
    const connected = minerStats.filter(s => s.connected).length;
    const totalHashrate = minerStats.reduce((sum, s) => sum + s.hashrate, 0);
    
    this.stats.totalShares = minerStats.reduce((sum, s) => sum + s.shares, 0);
    this.stats.totalAccepted = minerStats.reduce((sum, s) => sum + s.accepted, 0);
    this.stats.totalRejected = minerStats.reduce((sum, s) => sum + s.rejected, 0);
    
    const runtime = (Date.now() - this.stats.startTime) / 1000;
    const shareRate = this.stats.totalShares / runtime;
    const acceptRate = this.stats.totalAccepted / this.stats.totalShares * 100 || 0;
    
    console.log('\n📊 Pool Simulator Statistics');
    console.log('═══════════════════════════════════════');
    console.log(`Connected Miners: ${connected}/${this.config.numMiners}`);
    console.log(`Total Hashrate: ${this.formatHashrate(totalHashrate)}`);
    console.log(`Shares Submitted: ${this.stats.totalShares}`);
    console.log(`Shares Accepted: ${this.stats.totalAccepted} (${acceptRate.toFixed(2)}%)`);
    console.log(`Shares Rejected: ${this.stats.totalRejected}`);
    console.log(`Share Rate: ${shareRate.toFixed(2)}/s`);
    console.log(`Runtime: ${this.formatTime(runtime)}`);
  }
  
  private printDetailedReport(): void {
    console.log('\n📈 Detailed Miner Report');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('ID    | Status     | Hashrate    | Shares | Accepted | Rejected');
    console.log('------|------------|-------------|--------|----------|----------');
    
    const minerStats = this.miners.slice(0, 10).map(m => m.getStats());
    
    minerStats.forEach((stats, id) => {
      const status = stats.connected ? '🟢 Online ' : '🔴 Offline';
      console.log(
        `${id.toString().padEnd(5)} | ${status} | ${this.formatHashrate(stats.hashrate).padEnd(11)} | ` +
        `${stats.shares.toString().padEnd(6)} | ${stats.accepted.toString().padEnd(8)} | ${stats.rejected}`
      );
    });
    
    if (this.miners.length > 10) {
      console.log(`... and ${this.miners.length - 10} more miners`);
    }
  }
  
  private formatHashrate(hashrate: number): string {
    if (hashrate > 1e15) return (hashrate / 1e15).toFixed(2) + ' PH/s';
    if (hashrate > 1e12) return (hashrate / 1e12).toFixed(2) + ' TH/s';
    if (hashrate > 1e9) return (hashrate / 1e9).toFixed(2) + ' GH/s';
    if (hashrate > 1e6) return (hashrate / 1e6).toFixed(2) + ' MH/s';
    if (hashrate > 1e3) return (hashrate / 1e3).toFixed(2) + ' KH/s';
    return hashrate.toFixed(2) + ' H/s';
  }
  
  private formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    }
    return `${secs}s`;
  }
  
  async stop(): Promise<void> {
    console.log('\n\n🛑 Stopping simulator...');
    
    // Print final stats
    this.printStats();
    
    // Disconnect all miners
    await Promise.all(this.miners.map(m => {
      m.disconnect();
      return Promise.resolve();
    }));
    
    console.log('\n✅ Simulator stopped');
    process.exit(0);
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  
  // Default configuration
  const config: SimulatorConfig = {
    poolHost: 'localhost',
    poolPort: 3333,
    numMiners: 10,
    minerPrefix: 'sim',
    targetHashrate: 1e12, // 1 TH/s total
    shareSubmissionRate: 0.1, // 0.1 shares per second per miner
    invalidShareRate: 0.5, // 0.5% invalid shares
    reconnectOnError: true,
    variableHashrate: true,
    simulateDisconnects: false,
    logLevel: 'info'
  };
  
  // Parse command line arguments
  for (let i = 0; i < args.length; i += 2) {
    const arg = args[i];
    const value = args[i + 1];
    
    switch (arg) {
      case '--host':
        config.poolHost = value;
        break;
      case '--port':
        config.poolPort = parseInt(value);
        break;
      case '--miners':
        config.numMiners = parseInt(value);
        break;
      case '--prefix':
        config.minerPrefix = value;
        break;
      case '--hashrate':
        config.targetHashrate = parseFloat(value);
        break;
      case '--share-rate':
        config.shareSubmissionRate = parseFloat(value);
        break;
      case '--invalid-rate':
        config.invalidShareRate = parseFloat(value);
        break;
      case '--disconnects':
        config.simulateDisconnects = value === 'true';
        break;
      case '--log-level':
        config.logLevel = value as any;
        break;
      case '--help':
        printHelp();
        process.exit(0);
    }
  }
  
  // Validate configuration
  if (config.numMiners < 1 || config.numMiners > 10000) {
    console.error('Number of miners must be between 1 and 10000');
    process.exit(1);
  }
  
  // Start simulator
  const simulator = new PoolSimulator(config);
  
  try {
    await simulator.start();
  } catch (error) {
    console.error('Failed to start simulator:', error);
    process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
Otedama Pool Simulator - Test your mining pool without real hardware

Usage: pool-simulator.ts [options]

Options:
  --host <host>          Pool hostname (default: localhost)
  --port <port>          Pool stratum port (default: 3333)
  --miners <count>       Number of virtual miners (default: 10)
  --prefix <prefix>      Miner address prefix (default: sim)
  --hashrate <h/s>       Total target hashrate (default: 1e12)
  --share-rate <rate>    Shares per second per miner (default: 0.1)
  --invalid-rate <pct>   Percentage of invalid shares (default: 0.5)
  --disconnects <bool>   Simulate random disconnects (default: false)
  --log-level <level>    Log level: debug, info, error (default: info)
  --help                 Show this help message

Examples:
  # Simulate 100 miners with 10 TH/s total hashrate
  pool-simulator.ts --miners 100 --hashrate 1e13

  # Test against remote pool with disconnects
  pool-simulator.ts --host pool.example.com --port 3333 --disconnects true

  # High load test with 1000 miners
  pool-simulator.ts --miners 1000 --share-rate 0.5 --log-level error
`);
}

if (require.main === module) {
  main();
}

export { PoolSimulator, VirtualMiner, SimulatorConfig };
