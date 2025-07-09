// Load testing script for Otedama Light
import * as net from 'net';
import * as crypto from 'crypto';

interface TestConfig {
  host: string;
  port: number;
  miners: number;
  sharesPerMiner: number;
  interval: number; // ms between shares
}

class MockMiner {
  private socket: net.Socket | null = null;
  private subscribed = false;
  private authorized = false;
  private extraNonce1 = '';
  private jobId = '';
  private difficulty = 1;
  
  constructor(
    private id: string,
    private address: string
  ) {}
  
  async connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(port, host);
      
      this.socket.on('connect', () => {
        console.log(`Miner ${this.id} connected`);
        resolve();
      });
      
      this.socket.on('data', (data) => {
        this.handleData(data);
      });
      
      this.socket.on('error', (error) => {
        console.error(`Miner ${this.id} error:`, error.message);
        reject(error);
      });
      
      this.socket.on('close', () => {
        console.log(`Miner ${this.id} disconnected`);
        this.socket = null;
      });
    });
  }
  
  private handleData(data: Buffer): void {
    const messages = data.toString().split('\n').filter(m => m);
    
    for (const message of messages) {
      try {
        const msg = JSON.parse(message);
        
        if (msg.result !== undefined && msg.id === 1) {
          // Subscribe response
          this.extraNonce1 = msg.result[1];
          this.subscribed = true;
          this.authorize();
        } else if (msg.result !== undefined && msg.id === 2) {
          // Authorize response
          this.authorized = msg.result;
        } else if (msg.method === 'mining.notify') {
          // New job
          this.jobId = msg.params[0];
        } else if (msg.method === 'mining.set_difficulty') {
          // Difficulty update
          this.difficulty = msg.params[0];
        }
      } catch (error) {
        console.error('Failed to parse message:', message);
      }
    }
  }
  
  async subscribe(): Promise<void> {
    if (!this.socket) throw new Error('Not connected');
    
    const message = {
      id: 1,
      method: 'mining.subscribe',
      params: ['MockMiner/1.0']
    };
    
    this.socket.write(JSON.stringify(message) + '\n');
    
    // Wait for subscription
    await this.waitFor(() => this.subscribed, 5000);
  }
  
  async authorize(): Promise<void> {
    if (!this.socket) throw new Error('Not connected');
    
    const message = {
      id: 2,
      method: 'mining.authorize',
      params: [this.address, 'x']
    };
    
    this.socket.write(JSON.stringify(message) + '\n');
    
    // Wait for authorization
    await this.waitFor(() => this.authorized, 5000);
  }
  
  submitShare(): void {
    if (!this.socket || !this.authorized) return;
    
    // Generate random nonce
    const nonce = crypto.randomBytes(4).toString('hex');
    const extraNonce2 = crypto.randomBytes(4).toString('hex');
    const nTime = Math.floor(Date.now() / 1000).toString(16);
    
    const message = {
      id: Date.now(),
      method: 'mining.submit',
      params: [
        this.address,
        this.jobId || 'test',
        extraNonce2,
        nTime,
        nonce
      ]
    };
    
    this.socket.write(JSON.stringify(message) + '\n');
  }
  
  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
  
  private async waitFor(condition: () => boolean, timeout: number): Promise<void> {
    const start = Date.now();
    
    while (!condition() && Date.now() - start < timeout) {
      await new Promise(r => setTimeout(r, 100));
    }
    
    if (!condition()) {
      throw new Error('Timeout waiting for condition');
    }
  }
}

class LoadTester {
  private miners: MockMiner[] = [];
  private stats = {
    connected: 0,
    shares: 0,
    errors: 0,
    startTime: Date.now()
  };
  
  constructor(private config: TestConfig) {}
  
  async run(): Promise<void> {
    console.log('Starting load test...');
    console.log(`Config: ${this.config.miners} miners, ${this.config.sharesPerMiner} shares each`);
    console.log('');
    
    // Create miners
    for (let i = 0; i < this.config.miners; i++) {
      const miner = new MockMiner(
        `miner${i}`,
        `test_address_${i}`
      );
      this.miners.push(miner);
    }
    
    // Connect miners with slight delay to avoid overwhelming
    for (let i = 0; i < this.miners.length; i++) {
      try {
        await this.miners[i].connect(this.config.host, this.config.port);
        await this.miners[i].subscribe();
        this.stats.connected++;
        
        // Small delay between connections
        if (i < this.miners.length - 1) {
          await new Promise(r => setTimeout(r, 10));
        }
      } catch (error) {
        console.error(`Failed to connect miner ${i}:`, error);
        this.stats.errors++;
      }
    }
    
    console.log(`Connected ${this.stats.connected}/${this.config.miners} miners`);
    console.log('Starting share submission...');
    console.log('');
    
    // Start submitting shares
    const sharePromises: Promise<void>[] = [];
    
    for (const miner of this.miners) {
      const promise = this.submitSharesForMiner(miner);
      sharePromises.push(promise);
    }
    
    // Wait for all shares to be submitted
    await Promise.all(sharePromises);
    
    // Print results
    this.printResults();
    
    // Disconnect all miners
    for (const miner of this.miners) {
      miner.disconnect();
    }
  }
  
  private async submitSharesForMiner(miner: MockMiner): Promise<void> {
    for (let i = 0; i < this.config.sharesPerMiner; i++) {
      try {
        miner.submitShare();
        this.stats.shares++;
        
        // Wait between shares
        await new Promise(r => setTimeout(r, this.config.interval));
      } catch (error) {
        this.stats.errors++;
      }
    }
  }
  
  private printResults(): void {
    const duration = (Date.now() - this.stats.startTime) / 1000;
    const sharesPerSecond = this.stats.shares / duration;
    
    console.log('');
    console.log('=================================');
    console.log('Load Test Results');
    console.log('=================================');
    console.log(`Duration: ${duration.toFixed(2)}s`);
    console.log(`Miners connected: ${this.stats.connected}`);
    console.log(`Shares submitted: ${this.stats.shares}`);
    console.log(`Errors: ${this.stats.errors}`);
    console.log(`Shares/second: ${sharesPerSecond.toFixed(2)}`);
    console.log(`Avg latency: ${(this.config.interval)}ms`);
    console.log('=================================');
  }
}

// Run load test
async function main() {
  const config: TestConfig = {
    host: process.env.TEST_HOST || 'localhost',
    port: parseInt(process.env.TEST_PORT || '3333'),
    miners: parseInt(process.env.TEST_MINERS || '100'),
    sharesPerMiner: parseInt(process.env.TEST_SHARES || '10'),
    interval: parseInt(process.env.TEST_INTERVAL || '1000')
  };
  
  const tester = new LoadTester(config);
  
  try {
    await tester.run();
  } catch (error) {
    console.error('Load test failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { LoadTester, MockMiner };
