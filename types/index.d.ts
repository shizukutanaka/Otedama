/**
 * Otedama Type Definitions
 * Main type declarations for the mining pool system
 */

declare namespace Otedama {
  // Core Types
  export interface Config {
    pool: PoolConfig;
    network: NetworkConfig;
    security: SecurityConfig;
    database: DatabaseConfig;
    monitoring: MonitoringConfig;
  }

  export interface PoolConfig {
    name: string;
    port: number;
    difficulty: number;
    fee: number;
    minPayout: number;
    payoutInterval: number;
    algorithm: string | string[];
  }

  export interface NetworkConfig {
    p2pPort: number;
    maxPeers: number;
    seedNodes: string[];
    networkId: string;
  }

  export interface SecurityConfig {
    enableTLS: boolean;
    enable2FA: boolean;
    rateLimit: RateLimitConfig;
    cors: CorsConfig;
  }

  export interface DatabaseConfig {
    type: 'sqlite' | 'postgres' | 'mysql';
    connectionString: string;
    poolMin: number;
    poolMax: number;
  }

  export interface MonitoringConfig {
    enabled: boolean;
    metricsPort: number;
    logLevel: 'error' | 'warn' | 'info' | 'debug';
  }

  // Mining Types
  export interface Miner {
    id: string;
    address: string;
    worker: string;
    hashrate: number;
    shares: ShareStats;
    difficulty: number;
    lastSeen: Date;
    connected: boolean;
  }

  export interface Share {
    id: string;
    minerId: string;
    jobId: string;
    nonce: string;
    hash: string;
    difficulty: number;
    timestamp: Date;
    valid: boolean;
  }

  export interface Block {
    height: number;
    hash: string;
    previousHash: string;
    timestamp: Date;
    difficulty: number;
    nonce: string;
    reward: bigint;
    foundBy: string;
  }

  export interface Job {
    id: string;
    height: number;
    previousHash: string;
    coinbase: string;
    target: string;
    difficulty: number;
    timestamp: Date;
  }

  // Statistics
  export interface PoolStats {
    hashrate: number;
    miners: number;
    workers: number;
    difficulty: number;
    blocksFound: number;
    totalShares: number;
    validShares: number;
    invalidShares: number;
    uptime: number;
  }

  export interface ShareStats {
    valid: number;
    invalid: number;
    stale: number;
    duplicate: number;
    total: number;
  }

  export interface MinerStats extends ShareStats {
    hashrate: number;
    averageHashrate: number;
    balance: bigint;
    paid: bigint;
    blocksFound: number;
    lastShare: Date;
  }

  // Payment Types
  export interface Payment {
    id: string;
    address: string;
    amount: bigint;
    fee: bigint;
    txid: string;
    status: PaymentStatus;
    timestamp: Date;
  }

  export type PaymentStatus = 'pending' | 'processing' | 'confirmed' | 'failed';

  export interface Payout {
    minAmount: bigint;
    fee: bigint;
    interval: number;
    threshold: bigint;
  }

  // API Types
  export interface ApiRequest<T = any> {
    method: string;
    params: T;
    id: string | number;
  }

  export interface ApiResponse<T = any> {
    result?: T;
    error?: ApiError;
    id: string | number;
  }

  export interface ApiError {
    code: number;
    message: string;
    data?: any;
  }

  // Event Types
  export interface PoolEvents {
    'miner:connected': (miner: Miner) => void;
    'miner:disconnected': (miner: Miner) => void;
    'share:submitted': (share: Share) => void;
    'share:accepted': (share: Share) => void;
    'share:rejected': (share: Share, reason: string) => void;
    'block:found': (block: Block) => void;
    'payment:sent': (payment: Payment) => void;
    'error': (error: Error) => void;
  }

  // Middleware Types
  export interface Middleware {
    (req: Request, res: Response, next: NextFunction): void | Promise<void>;
  }

  export interface Request extends Express.Request {
    validated?: any;
    user?: User;
    miner?: Miner;
    rateLimit?: RateLimitInfo;
  }

  export interface Response extends Express.Response {
    // Custom response methods
  }

  export interface NextFunction {
    (err?: any): void;
  }

  // Security Types
  export interface User {
    id: string;
    username: string;
    email: string;
    role: UserRole;
    twoFactorEnabled: boolean;
    apiKeys: ApiKey[];
  }

  export type UserRole = 'admin' | 'operator' | 'user';

  export interface ApiKey {
    id: string;
    key: string;
    name: string;
    permissions: Permission[];
    expiresAt: Date;
    lastUsed: Date;
  }

  export type Permission = 'read' | 'write' | 'admin';

  export interface RateLimitInfo {
    limit: number;
    remaining: number;
    resetTime: Date;
  }

  export interface RateLimitConfig {
    windowMs: number;
    max: number;
    keyGenerator?: (req: Request) => string;
  }

  export interface CorsConfig {
    origins: string[];
    methods: string[];
    headers: string[];
    credentials: boolean;
  }

  // Validation Types
  export interface ValidationSchema {
    [field: string]: FieldSchema;
  }

  export interface FieldSchema {
    type: FieldType;
    required?: boolean;
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    enum?: any[];
    validate?: (value: any) => boolean | Promise<boolean>;
  }

  export type FieldType = 
    | 'string'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'array'
    | 'object'
    | 'date'
    | 'email'
    | 'url'
    | 'uuid'
    | 'address'
    | 'hash'
    | 'amount';

  // Health Check Types
  export interface HealthStatus {
    status: 'healthy' | 'degraded' | 'unhealthy';
    score: number;
    checks: HealthChecks;
    uptime: number;
    timestamp: Date;
  }

  export interface HealthChecks {
    system: HealthCheck;
    database: HealthCheck;
    blockchain: HealthCheck;
    cache: HealthCheck;
    network: HealthCheck;
  }

  export interface HealthCheck {
    status: 'healthy' | 'degraded' | 'unhealthy';
    message?: string;
    metrics?: any;
  }

  // Error Types
  export interface ErrorInfo {
    id: string;
    code: string;
    message: string;
    category: ErrorCategory;
    severity: ErrorSeverity;
    timestamp: Date;
    context?: any;
  }

  export type ErrorCategory = 
    | 'network'
    | 'database'
    | 'validation'
    | 'authentication'
    | 'authorization'
    | 'blockchain'
    | 'mining'
    | 'payment'
    | 'internal';

  export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

  // P2P Types
  export interface Peer {
    id: string;
    address: string;
    port: number;
    version: string;
    lastSeen: Date;
    latency: number;
  }

  export interface P2PMessage {
    type: string;
    payload: any;
    timestamp: Date;
    signature?: string;
  }

  // Blockchain Types
  export interface BlockchainInfo {
    height: number;
    hash: string;
    difficulty: number;
    networkHashrate: number;
    connections: number;
    synced: boolean;
  }

  export interface Transaction {
    txid: string;
    inputs: TxInput[];
    outputs: TxOutput[];
    fee: bigint;
    timestamp: Date;
    confirmations: number;
  }

  export interface TxInput {
    txid: string;
    vout: number;
    scriptSig: string;
    sequence: number;
  }

  export interface TxOutput {
    value: bigint;
    scriptPubKey: string;
    address: string;
  }
}

// Module declarations
declare module 'otedama' {
  export = Otedama;
}

// Global augmentations
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NODE_ENV: 'development' | 'test' | 'production';
      PORT: string;
      API_PORT: string;
      P2P_PORT: string;
      JWT_SECRET: string;
      SESSION_SECRET: string;
      DATABASE_URL: string;
      BLOCKCHAIN_URL: string;
      BLOCKCHAIN_USER: string;
      BLOCKCHAIN_PASS: string;
      POOL_NAME: string;
      POOL_FEE: string;
      MIN_PAYOUT: string;
    }
  }
}