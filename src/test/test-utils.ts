// Test utilities for mining pool tests
// John Carmack: "If you're willing to restrict the flexibility of your approach, you can almost always do something better"

import { IMiner, IShare, IJob, IBlock } from '../interfaces';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';

/**
 * Generate a random hex string
 */
export function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Generate a random Bitcoin address
 */
export function randomBitcoinAddress(): string {
  const prefixes = ['1', '3', 'bc1'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  
  if (prefix === 'bc1') {
    // Bech32 address
    return prefix + randomHex(20).toLowerCase();
  }
  
  // Legacy address
  const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let address = prefix;
  for (let i = 0; i < 33; i++) {
    address += chars[Math.floor(Math.random() * chars.length)];
  }
  return address;
}

/**
 * Create a mock miner
 */
export function createMockMiner(overrides?: Partial<IMiner>): IMiner {
  return {
    id: randomHex(8),
    address: randomBitcoinAddress(),
    workerName: 'test-worker',
    ipAddress: '127.0.0.1',
    userAgent: 'test-miner/1.0',
    connectedAt: Date.now(),
    lastShareAt: Date.now(),
    shareCount: 0,
    validShares: 0,
    invalidShares: 0,
    hashrate: 1000000000, // 1 GH/s
    difficulty: 1024,
    authorized: true,
    ...overrides,
  };
}

/**
 * Create a mock share
 */
export function createMockShare(overrides?: Partial<IShare>): IShare {
  return {
    id: randomHex(16),
    minerId: randomHex(8),
    jobId: randomHex(8),
    nonce: randomHex(4),
    time: Math.floor(Date.now() / 1000),
    difficulty: 1024,
    hash: randomHex(32),
    isValid: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Create a mock job
 */
export function createMockJob(overrides?: Partial<IJob>): IJob {
  return {
    id: randomHex(8),
    prevHash: randomHex(32),
    coinb1: randomHex(50),
    coinb2: randomHex(50),
    merkleBranch: [randomHex(32), randomHex(32), randomHex(32)],
    version: '20000000',
    nbits: '1a0ffff0',
    ntime: Math.floor(Date.now() / 1000).toString(16),
    cleanJobs: true,
    height: 700000 + Math.floor(Math.random() * 1000),
    difficulty: 1024,
    target: randomHex(32),
    createdAt: Date.now(),
    ...overrides,
  };
}

/**
 * Create a mock block
 */
export function createMockBlock(overrides?: Partial<IBlock>): IBlock {
  return {
    height: 700000 + Math.floor(Math.random() * 1000),
    hash: randomHex(32),
    previousHash: randomHex(32),
    timestamp: Date.now(),
    nonce: randomHex(4),
    difficulty: 50000000000,
    reward: 6.25,
    foundBy: randomHex(8),
    minerAddress: randomBitcoinAddress(),
    txCount: 2000 + Math.floor(Math.random() * 1000),
    confirmations: 0,
    ...overrides,
  };
}

/**
 * Create a mock RPC client
 */
export interface MockRPCClient {
  getBlockTemplate: jest.Mock;
  submitBlock: jest.Mock;
  getBlockchainInfo: jest.Mock;
  getNetworkInfo: jest.Mock;
  validateAddress: jest.Mock;
  sendToAddress: jest.Mock;
  sendMany: jest.Mock;
  getBalance: jest.Mock;
}

export function createMockRPCClient(): MockRPCClient {
  return {
    getBlockTemplate: jest.fn().mockResolvedValue({
      version: 536870912,
      previousblockhash: randomHex(32),
      transactions: [],
      coinbaseaux: { flags: '' },
      coinbasevalue: 625000000,
      target: randomHex(32),
      mintime: Date.now() / 1000 - 600,
      mutable: ['time', 'transactions', 'prevblock'],
      noncerange: '00000000ffffffff',
      sigoplimit: 80000,
      sizelimit: 4000000,
      weightlimit: 4000000,
      curtime: Date.now() / 1000,
      bits: '1a0ffff0',
      height: 700000,
    }),
    submitBlock: jest.fn().mockResolvedValue(null),
    getBlockchainInfo: jest.fn().mockResolvedValue({
      chain: 'main',
      blocks: 700000,
      headers: 700000,
      bestblockhash: randomHex(32),
      difficulty: 50000000000,
      mediantime: Date.now() / 1000 - 3600,
      verificationprogress: 0.999999,
      initialblockdownload: false,
      chainwork: randomHex(32),
      size_on_disk: 400000000000,
      pruned: false,
    }),
    getNetworkInfo: jest.fn().mockResolvedValue({
      version: 220000,
      subversion: '/Satoshi:22.0.0/',
      protocolversion: 70016,
      localservices: '0000000000000409',
      localservicesnames: ['NETWORK', 'WITNESS', 'NETWORK_LIMITED'],
      localrelay: true,
      timeoffset: 0,
      networkactive: true,
      connections: 125,
      connections_in: 60,
      connections_out: 65,
      networks: [],
      relayfee: 0.00001,
      incrementalfee: 0.00001,
      localaddresses: [],
      warnings: '',
    }),
    validateAddress: jest.fn().mockImplementation((address: string) => ({
      isvalid: /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^bc1[a-z0-9]{39,59}$/.test(address),
      address,
      scriptPubKey: randomHex(25),
      isscript: address.startsWith('3'),
      iswitness: address.startsWith('bc1'),
    })),
    sendToAddress: jest.fn().mockResolvedValue(randomHex(32)),
    sendMany: jest.fn().mockResolvedValue(randomHex(32)),
    getBalance: jest.fn().mockResolvedValue(10.5),
  };
}

/**
 * Create a mock database
 */
export interface MockDatabase {
  get: jest.Mock;
  all: jest.Mock;
  run: jest.Mock;
  prepare: jest.Mock;
  transaction: jest.Mock;
}

export function createMockDatabase(): MockDatabase {
  return {
    get: jest.fn().mockResolvedValue(undefined),
    all: jest.fn().mockResolvedValue([]),
    run: jest.fn().mockResolvedValue({ changes: 1, lastID: 1 }),
    prepare: jest.fn().mockReturnValue({
      get: jest.fn().mockResolvedValue(undefined),
      all: jest.fn().mockResolvedValue([]),
      run: jest.fn().mockResolvedValue({ changes: 1, lastID: 1 }),
      finalize: jest.fn(),
    }),
    transaction: jest.fn().mockImplementation((fn) => fn()),
  };
}

/**
 * Create a mock Redis client
 */
export interface MockRedisClient {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
  exists: jest.Mock;
  expire: jest.Mock;
  ttl: jest.Mock;
  hget: jest.Mock;
  hset: jest.Mock;
  hdel: jest.Mock;
  hgetall: jest.Mock;
  zadd: jest.Mock;
  zrange: jest.Mock;
  zrem: jest.Mock;
  pipeline: jest.Mock;
  multi: jest.Mock;
}

export function createMockRedisClient(): MockRedisClient {
  const pipeline = {
    get: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    del: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
  };

  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(0),
    expire: jest.fn().mockResolvedValue(1),
    ttl: jest.fn().mockResolvedValue(-1),
    hget: jest.fn().mockResolvedValue(null),
    hset: jest.fn().mockResolvedValue(1),
    hdel: jest.fn().mockResolvedValue(1),
    hgetall: jest.fn().mockResolvedValue({}),
    zadd: jest.fn().mockResolvedValue(1),
    zrange: jest.fn().mockResolvedValue([]),
    zrem: jest.fn().mockResolvedValue(1),
    pipeline: jest.fn().mockReturnValue(pipeline),
    multi: jest.fn().mockReturnValue(pipeline),
  };
}

/**
 * Create a mock WebSocket
 */
export class MockWebSocket extends EventEmitter {
  public readyState: number = 1; // OPEN
  public send = jest.fn();
  public close = jest.fn().mockImplementation(() => {
    this.readyState = 3; // CLOSED
    this.emit('close');
  });
  public ping = jest.fn();
  public pong = jest.fn();
  public terminate = jest.fn();

  constructor() {
    super();
    setTimeout(() => this.emit('open'), 0);
  }
}

/**
 * Create a mock mining pool core
 */
export class MockMiningPoolCore extends EventEmitter {
  public start = jest.fn().mockResolvedValue(undefined);
  public stop = jest.fn().mockResolvedValue(undefined);
  public getMiner = jest.fn().mockReturnValue(createMockMiner());
  public getMiners = jest.fn().mockReturnValue(new Map());
  public getActiveMiners = jest.fn().mockReturnValue([]);
  public kickMiner = jest.fn();
  public banMiner = jest.fn();
  public submitShare = jest.fn().mockResolvedValue(true);
  public getUnpaidShares = jest.fn().mockResolvedValue([]);
  public markSharesPaid = jest.fn().mockResolvedValue(undefined);
  public calculateRewards = jest.fn().mockReturnValue(new Map());
  public getPoolStats = jest.fn().mockResolvedValue({
    connectedMiners: 10,
    totalHashrate: 1000000000000,
    networkHashrate: 200000000000000000,
    networkDifficulty: 50000000000,
    poolFeePercent: 1,
    totalBlocksFound: 5,
    totalSharesSubmitted: 10000,
    currentRound: {
      shares: 1000,
      startedAt: Date.now() - 3600000,
      effort: 95.5,
    },
  });

  constructor() {
    super();
  }
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout: number = 5000,
  interval: number = 100
): Promise<void> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  
  throw new Error('Timeout waiting for condition');
}

/**
 * Create a test timeout
 */
export function createTimeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Test timeout')), ms);
  });
}

/**
 * Run a function with a timeout
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number
): Promise<T> {
  return Promise.race([promise, createTimeout(ms)]);
}

/**
 * Mock timers utilities
 */
export const mockTimers = {
  useFakeTimers() {
    jest.useFakeTimers();
  },
  
  useRealTimers() {
    jest.useRealTimers();
  },
  
  async runAllTimers() {
    await jest.runAllTimersAsync();
  },
  
  async advanceTimersByTime(ms: number) {
    await jest.advanceTimersByTimeAsync(ms);
  },
  
  clearAllTimers() {
    jest.clearAllTimers();
  },
};

/**
 * Create a test logger
 */
export interface TestLogger {
  debug: jest.Mock;
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  fatal: jest.Mock;
}

export function createTestLogger(): TestLogger {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
  };
}
