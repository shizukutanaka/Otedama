// Core mining pool interface definitions
// Following Robert C. Martin's principles: Depend on abstractions, not concretions

import { EventEmitter } from 'events';

// Share data structure
export interface IShare {
  id: string;
  minerId: string;
  jobId: string;
  nonce: string;
  time: number;
  difficulty: number;
  hash?: string;
  isValid: boolean;
  timestamp: number;
}

// Miner information
export interface IMiner {
  id: string;
  address: string;
  workerName?: string;
  ipAddress: string;
  userAgent?: string;
  connectedAt: number;
  lastShareAt?: number;
  shareCount: number;
  validShares: number;
  invalidShares: number;
  hashrate: number;
  difficulty: number;
  authorized: boolean;
}

// Job information
export interface IJob {
  id: string;
  prevHash: string;
  coinb1: string;
  coinb2: string;
  merkleBranch: string[];
  version: string;
  nbits: string;
  ntime: string;
  cleanJobs: boolean;
  height: number;
  difficulty: number;
  target: string;
  createdAt: number;
}

// Block information
export interface IBlock {
  height: number;
  hash: string;
  previousHash: string;
  timestamp: number;
  nonce: string;
  difficulty: number;
  reward: number;
  foundBy: string;
  minerAddress: string;
  txCount: number;
  confirmations: number;
}

// Pool statistics
export interface IPoolStats {
  connectedMiners: number;
  totalHashrate: number;
  networkHashrate: number;
  networkDifficulty: number;
  lastBlockFound?: IBlock;
  totalBlocksFound: number;
  totalSharesSubmitted: number;
  poolFeePercent: number;
  currentRound: {
    shares: number;
    startedAt: number;
    effort: number;
  };
}

// Payment information
export interface IPayment {
  id: string;
  txid?: string;
  address: string;
  amount: number;
  timestamp: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  shares: number;
  blockHeight?: number;
  confirmations?: number;
  error?: string;
}

// Configuration options
export interface IPoolConfig {
  poolAddress: string;
  rpcUrl: string;
  rpcUser: string;
  rpcPassword: string;
  stratumPort: number;
  // Optional configurations
  poolName?: string;
  poolUrl?: string;
  minDifficulty?: number;
  maxDifficulty?: number;
  retargetInterval?: number;
  varianceFactor?: number;
  paymentInterval?: number;
  minPayout?: number;
  feePercent?: number;
  maxConnectionsPerIP?: number;
  banning?: {
    enabled: boolean;
    checkThreshold: number;
    invalidPercent: number;
    banTime: number;
  };
}

// Main mining pool interface
export interface IMiningPool extends EventEmitter {
  // Lifecycle methods
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  isRunning(): boolean;
  
  // Configuration
  getConfig(): IPoolConfig;
  updateConfig(config: Partial<IPoolConfig>): Promise<void>;
  
  // Miner management
  getMiner(minerId: string): IMiner | undefined;
  getMiners(): Map<string, IMiner>;
  getActiveMiners(): IMiner[];
  kickMiner(minerId: string, reason?: string): void;
  banMiner(ipAddress: string, duration: number, reason?: string): void;
  
  // Share management
  submitShare(minerId: string, share: IShare): Promise<boolean>;
  getShare(shareId: string): IShare | undefined;
  getSharesByMiner(minerId: string, limit?: number): IShare[];
  getUnpaidShares(): Promise<IShare[]>;
  markSharesPaid(shareIds: string[]): Promise<void>;
  
  // Job management
  getCurrentJob(): IJob;
  getJob(jobId: string): IJob | undefined;
  createNewJob(): IJob;
  
  // Block management
  submitBlock(block: IBlock): Promise<boolean>;
  getBlock(height: number): Promise<IBlock | undefined>;
  getBlocks(limit?: number, offset?: number): Promise<IBlock[]>;
  getLastBlock(): Promise<IBlock | undefined>;
  
  // Statistics
  getPoolStats(): Promise<IPoolStats>;
  getMinerStats(minerId: string): Promise<IMinerStats | undefined>;
  getHashrateHistory(duration: number): Promise<IHashratePoint[]>;
  
  // Payment management
  getPaymentHistory(address: string, limit?: number): Promise<IPayment[]>;
  getPendingPayments(): Promise<IPayment[]>;
  processPayments(): Promise<void>;
  
  // Events
  on(event: 'share', listener: (share: IShare, miner: IMiner) => void): this;
  on(event: 'block', listener: (block: IBlock) => void): this;
  on(event: 'miner:connected', listener: (miner: IMiner) => void): this;
  on(event: 'miner:disconnected', listener: (minerId: string) => void): this;
  on(event: 'miner:authorized', listener: (miner: IMiner) => void): this;
  on(event: 'job:new', listener: (job: IJob) => void): this;
  on(event: 'payment:processed', listener: (payment: IPayment) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

// Extended interfaces for specific features
export interface IMinerStats {
  minerId: string;
  address: string;
  currentHashrate: number;
  averageHashrate: {
    '5min': number;
    '1hour': number;
    '24hour': number;
  };
  shares: {
    valid: number;
    invalid: number;
    total: number;
    invalidPercent: number;
  };
  lastShare?: {
    timestamp: number;
    difficulty: number;
  };
  rewards: {
    paid: number;
    pending: number;
    immature: number;
  };
  performance: {
    efficiency: number;
    uptime: number;
    roundShares: number;
  };
}

export interface IHashratePoint {
  timestamp: number;
  hashrate: number;
  minerCount: number;
  difficulty: number;
}

// Service interfaces
export interface ICacheService {
  get(key: string): Promise<any>;
  set(key: string, value: any, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  clear(): Promise<void>;
}

export interface IDatabaseService {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  query<T>(sql: string, params?: any[]): Promise<T[]>;
  execute(sql: string, params?: any[]): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

export interface ILoggerService {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, error?: Error, ...args: any[]): void;
  fatal(message: string, error?: Error, ...args: any[]): void;
}

export interface INotificationService {
  sendAlert(title: string, message: string, severity?: 'info' | 'warning' | 'error' | 'critical'): Promise<void>;
  sendEmail(to: string, subject: string, body: string): Promise<void>;
  sendWebhook(url: string, payload: any): Promise<void>;
}

// Repository pattern interfaces
export interface IShareRepository {
  save(share: IShare): Promise<void>;
  findById(id: string): Promise<IShare | undefined>;
  findByMiner(minerId: string, limit?: number, offset?: number): Promise<IShare[]>;
  findUnpaid(): Promise<IShare[]>;
  markAsPaid(ids: string[]): Promise<void>;
  count(): Promise<number>;
  deleteOld(before: Date): Promise<number>;
}

export interface IMinerRepository {
  save(miner: IMiner): Promise<void>;
  findById(id: string): Promise<IMiner | undefined>;
  findByAddress(address: string): Promise<IMiner[]>;
  findActive(since: Date): Promise<IMiner[]>;
  update(id: string, updates: Partial<IMiner>): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface IBlockRepository {
  save(block: IBlock): Promise<void>;
  findByHeight(height: number): Promise<IBlock | undefined>;
  findByHash(hash: string): Promise<IBlock | undefined>;
  findRecent(limit: number): Promise<IBlock[]>;
  updateConfirmations(height: number, confirmations: number): Promise<void>;
}

export interface IPaymentRepository {
  save(payment: IPayment): Promise<void>;
  findById(id: string): Promise<IPayment | undefined>;
  findByAddress(address: string, limit?: number): Promise<IPayment[]>;
  findPending(): Promise<IPayment[]>;
  updateStatus(id: string, status: IPayment['status'], txid?: string): Promise<void>;
}
