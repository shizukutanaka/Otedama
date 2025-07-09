/**
 * Type definitions for Otedama Pool SDK
 */

export interface OtedamaConfig {
  baseUrl: string;
  apiKey?: string;
  timeout?: number;
  retries?: number;
  debug?: boolean;
}

export interface PoolStats {
  pool: {
    hashrate: number;
    miners: number;
    workers: number;
    difficulty: number;
    blockHeight: number;
    networkDifficulty: number;
    poolFee: number;
  };
  blocks: {
    pending: number;
    confirmed: number;
    orphaned: number;
    total: number;
    lastFound?: {
      height: number;
      hash: string;
      reward: number;
      timestamp: string;
    };
  };
  payments: {
    total: number;
    pending: number;
    lastPayout?: {
      amount: number;
      timestamp: string;
      txHash: string;
    };
  };
}

export interface MinerStats {
  address: string;
  hashrate: number;
  shares: {
    valid: number;
    invalid: number;
    stale: number;
  };
  balance: number;
  paid: number;
  lastShare: string;
  workers: WorkerStats[];
}

export interface WorkerStats {
  name: string;
  hashrate: number;
  lastSeen: string;
  shares: {
    valid: number;
    invalid: number;
  };
}

export interface Block {
  height: number;
  hash: string;
  reward: number;
  timestamp: string;
  status: 'pending' | 'confirmed' | 'orphaned';
  confirmations: number;
  difficulty: number;
  shares: number;
  luck: number;
}

export interface Payment {
  id: string;
  address: string;
  amount: number;
  txHash?: string;
  timestamp: string;
  status: 'pending' | 'processing' | 'confirmed' | 'failed';
  confirmations?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export interface AuthResponse {
  token: string;
  refreshToken: string;
  expiresIn: number;
}

export interface WebSocketMessage {
  type: 'stats' | 'block' | 'payment' | 'share';
  data: any;
  timestamp: string;
}
