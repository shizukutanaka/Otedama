/**
 * 軽量ブロックエクスプローラー統合
 * 設計思想: Carmack (シンプル・高速), Martin (クリーン), Pike (明瞭・効率性)
 * 
 * 主要機能:
 * - 複数ブロックチェーン対応
 * - インメモリキャッシュ（軽量）
 * - レート制限対応
 * - エラーハンドリング
 * - ブロック/トランザクション情報取得
 */

import { EventEmitter } from 'events';

// === 型定義 ===
interface ExplorerConfig {
  blockchain: 'bitcoin' | 'ethereum' | 'litecoin' | 'dogecoin';
  apiUrl: string;
  apiKey?: string;
  rateLimit: number; // requests per minute
  cacheSize: number;
  cacheTtl: number; // milliseconds
}

interface BlockInfo {
  hash: string;
  height: number;
  timestamp: number;
  difficulty: number;
  nonce: number;
  merkleRoot: string;
  size: number;
  reward: number;
  txCount: number;
  confirmations: number;
}

interface TransactionInfo {
  hash: string;
  blockHash: string;
  blockHeight: number;
  timestamp: number;
  fee: number;
  size: number;
  inputs: TransactionInput[];
  outputs: TransactionOutput[];
  confirmations: number;
}

interface TransactionInput {
  prevTxHash: string;
  prevTxIndex: number;
  address: string;
  value: number;
}

interface TransactionOutput {
  address: string;
  value: number;
  index: number;
}

interface AddressInfo {
  address: string;
  balance: number;
  totalReceived: number;
  totalSent: number;
  txCount: number;
  unconfirmedBalance?: number;
}

interface NetworkStats {
  height: number;
  difficulty: number;
  hashrate: number;
  memPoolSize: number;
  avgBlockTime: number;
}

// === 軽量キャッシュクラス ===
class LightCache<T> {
  private cache = new Map<string, { data: T; timestamp: number }>();
  private maxSize: number;
  private ttl: number;

  constructor(maxSize: number = 1000, ttl: number = 300000) {
    this.maxSize = maxSize;
    this.ttl = ttl;
    
    // 定期清掃（Pike: 効率的なリソース管理）
    setInterval(() => this.cleanup(), this.ttl);
  }

  set(key: string, value: T): void {
    // LRU実装（Carmack: シンプルで高速）
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, { data: value, timestamp: Date.now() });
  }

  get(key: string): T | null {
    const item = this.cache.get(key);
    if (!item) return null;
    
    // TTL チェック
    if (Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    return item.data;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, item] of this.cache) {
      if (now - item.timestamp > this.ttl) {
        this.cache.delete(key);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttl: this.ttl
    };
  }
}

// === レート制限クラス ===
class RateLimiter {
  private requests: number[] = [];
  private limit: number;
  private window: number = 60000; // 1分

  constructor(requestsPerMinute: number) {
    this.limit = requestsPerMinute;
  }

  async checkLimit(): Promise<boolean> {
    const now = Date.now();
    
    // 古いリクエストを削除
    this.requests = this.requests.filter(time => now - time < this.window);
    
    if (this.requests.length >= this.limit) {
      return false;
    }
    
    this.requests.push(now);
    return true;
  }

  getStats() {
    return {
      current: this.requests.length,
      limit: this.limit,
      window: this.window
    };
  }
}

// === ブロックチェーン統合インターフェース ===
abstract class BlockchainExplorer {
  protected config: ExplorerConfig;
  protected cache: LightCache<any>;
  protected rateLimiter: RateLimiter;

  constructor(config: ExplorerConfig) {
    this.config = config;
    this.cache = new LightCache(config.cacheSize, config.cacheTtl);
    this.rateLimiter = new RateLimiter(config.rateLimit);
  }

  abstract getBlock(hashOrHeight: string | number): Promise<BlockInfo>;
  abstract getTransaction(hash: string): Promise<TransactionInfo>;
  abstract getAddress(address: string): Promise<AddressInfo>;
  abstract getNetworkStats(): Promise<NetworkStats>;

  protected async request<T>(endpoint: string, cacheKey?: string): Promise<T> {
    // キャッシュチェック（Pike: 効率性）
    if (cacheKey) {
      const cached = this.cache.get(cacheKey);
      if (cached) return cached;
    }

    // レート制限チェック
    if (!(await this.rateLimiter.checkLimit())) {
      throw new Error('Rate limit exceeded');
    }

    try {
      const url = `${this.config.apiUrl}${endpoint}`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };

      if (this.config.apiKey) {
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      }

      const response = await fetch(url, { headers });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      
      // キャッシュに保存
      if (cacheKey) {
        this.cache.set(cacheKey, data);
      }

      return data;
    } catch (error) {
      throw new Error(`Explorer request failed: ${error.message}`);
    }
  }
}

// === Bitcoin エクスプローラー ===
class BitcoinExplorer extends BlockchainExplorer {
  async getBlock(hashOrHeight: string | number): Promise<BlockInfo> {
    const endpoint = `/block/${hashOrHeight}`;
    const cacheKey = `block:${hashOrHeight}`;
    
    const data = await this.request<any>(endpoint, cacheKey);
    
    return {
      hash: data.hash,
      height: data.height,
      timestamp: data.timestamp,
      difficulty: data.difficulty,
      nonce: data.nonce,
      merkleRoot: data.merkle_root,
      size: data.size,
      reward: data.reward / 100000000, // satoshi to BTC
      txCount: data.tx_count,
      confirmations: data.confirmations
    };
  }

  async getTransaction(hash: string): Promise<TransactionInfo> {
    const endpoint = `/tx/${hash}`;
    const cacheKey = `tx:${hash}`;
    
    const data = await this.request<any>(endpoint, cacheKey);
    
    return {
      hash: data.hash,
      blockHash: data.block_hash,
      blockHeight: data.block_height,
      timestamp: data.timestamp,
      fee: data.fee / 100000000,
      size: data.size,
      inputs: data.inputs.map((input: any) => ({
        prevTxHash: input.prev_hash,
        prevTxIndex: input.prev_index,
        address: input.address,
        value: input.value / 100000000
      })),
      outputs: data.outputs.map((output: any, index: number) => ({
        address: output.address,
        value: output.value / 100000000,
        index
      })),
      confirmations: data.confirmations
    };
  }

  async getAddress(address: string): Promise<AddressInfo> {
    const endpoint = `/address/${address}`;
    const cacheKey = `addr:${address}`;
    
    const data = await this.request<any>(endpoint, cacheKey);
    
    return {
      address: data.address,
      balance: data.balance / 100000000,
      totalReceived: data.total_received / 100000000,
      totalSent: data.total_sent / 100000000,
      txCount: data.tx_count,
      unconfirmedBalance: data.unconfirmed_balance ? data.unconfirmed_balance / 100000000 : undefined
    };
  }

  async getNetworkStats(): Promise<NetworkStats> {
    const endpoint = '/stats';
    const cacheKey = 'network:stats';
    
    const data = await this.request<any>(endpoint, cacheKey);
    
    return {
      height: data.height,
      difficulty: data.difficulty,
      hashrate: data.hashrate,
      memPoolSize: data.mempool_size,
      avgBlockTime: data.avg_block_time
    };
  }
}

// === Ethereum エクスプローラー ===
class EthereumExplorer extends BlockchainExplorer {
  async getBlock(hashOrHeight: string | number): Promise<BlockInfo> {
    const endpoint = `/api?module=proxy&action=eth_getBlockByNumber&tag=0x${Number(hashOrHeight).toString(16)}&boolean=true`;
    const cacheKey = `eth_block:${hashOrHeight}`;
    
    const data = await this.request<any>(endpoint, cacheKey);
    const block = data.result;
    
    return {
      hash: block.hash,
      height: parseInt(block.number, 16),
      timestamp: parseInt(block.timestamp, 16),
      difficulty: parseInt(block.difficulty, 16),
      nonce: parseInt(block.nonce, 16),
      merkleRoot: block.stateRoot,
      size: parseInt(block.size, 16),
      reward: 0, // ETH block reward calculation is complex
      txCount: block.transactions.length,
      confirmations: 0 // Will be calculated
    };
  }

  async getTransaction(hash: string): Promise<TransactionInfo> {
    const endpoint = `/api?module=proxy&action=eth_getTransactionByHash&txhash=${hash}`;
    const cacheKey = `eth_tx:${hash}`;
    
    const data = await this.request<any>(endpoint, cacheKey);
    const tx = data.result;
    
    return {
      hash: tx.hash,
      blockHash: tx.blockHash,
      blockHeight: parseInt(tx.blockNumber, 16),
      timestamp: 0, // Need to get from block
      fee: parseInt(tx.gasPrice, 16) * parseInt(tx.gas, 16) / 1e18,
      size: 0,
      inputs: [{
        prevTxHash: '',
        prevTxIndex: 0,
        address: tx.from,
        value: parseInt(tx.value, 16) / 1e18
      }],
      outputs: [{
        address: tx.to,
        value: parseInt(tx.value, 16) / 1e18,
        index: 0
      }],
      confirmations: 0
    };
  }

  async getAddress(address: string): Promise<AddressInfo> {
    const endpoint = `/api?module=account&action=balance&address=${address}&tag=latest`;
    const cacheKey = `eth_addr:${address}`;
    
    const data = await this.request<any>(endpoint, cacheKey);
    
    return {
      address,
      balance: parseInt(data.result) / 1e18,
      totalReceived: 0, // Not easily available
      totalSent: 0, // Not easily available
      txCount: 0
    };
  }

  async getNetworkStats(): Promise<NetworkStats> {
    const endpoint = '/api?module=stats&action=ethsupply';
    const cacheKey = 'eth_network:stats';
    
    // This is a simplified implementation
    return {
      height: 0,
      difficulty: 0,
      hashrate: 0,
      memPoolSize: 0,
      avgBlockTime: 12 // ETH average block time
    };
  }
}

// === ファクトリークラス（Martin: 責任分離） ===
class ExplorerFactory {
  static create(config: ExplorerConfig): BlockchainExplorer {
    switch (config.blockchain) {
      case 'bitcoin':
      case 'litecoin':
      case 'dogecoin':
        return new BitcoinExplorer(config);
      
      case 'ethereum':
        return new EthereumExplorer(config);
      
      default:
        throw new Error(`Unsupported blockchain: ${config.blockchain}`);
    }
  }
}

// === メインエクスプローラークラス ===
class LightBlockExplorer extends EventEmitter {
  private explorers = new Map<string, BlockchainExplorer>();
  private logger: any;

  constructor(logger?: any) {
    super();
    this.logger = logger || {
      info: (msg: string, data?: any) => console.log(`[INFO] ${msg}`, data || ''),
      error: (msg: string, err?: any) => console.error(`[ERROR] ${msg}`, err || ''),
      warn: (msg: string, data?: any) => console.warn(`[WARN] ${msg}`, data || '')
    };
  }

  addBlockchain(name: string, config: ExplorerConfig): void {
    try {
      const explorer = ExplorerFactory.create(config);
      this.explorers.set(name, explorer);
      this.logger.info(`Block explorer added for ${name}`, { blockchain: config.blockchain });
    } catch (error) {
      this.logger.error(`Failed to add explorer for ${name}`, error);
      throw error;
    }
  }

  async getBlock(blockchain: string, hashOrHeight: string | number): Promise<BlockInfo> {
    const explorer = this.explorers.get(blockchain);
    if (!explorer) {
      throw new Error(`Explorer not found for blockchain: ${blockchain}`);
    }

    try {
      const block = await explorer.getBlock(hashOrHeight);
      this.emit('blockRetrieved', { blockchain, block });
      return block;
    } catch (error) {
      this.logger.error(`Failed to get block from ${blockchain}`, error);
      throw error;
    }
  }

  async getTransaction(blockchain: string, hash: string): Promise<TransactionInfo> {
    const explorer = this.explorers.get(blockchain);
    if (!explorer) {
      throw new Error(`Explorer not found for blockchain: ${blockchain}`);
    }

    try {
      const tx = await explorer.getTransaction(hash);
      this.emit('transactionRetrieved', { blockchain, transaction: tx });
      return tx;
    } catch (error) {
      this.logger.error(`Failed to get transaction from ${blockchain}`, error);
      throw error;
    }
  }

  async getAddress(blockchain: string, address: string): Promise<AddressInfo> {
    const explorer = this.explorers.get(blockchain);
    if (!explorer) {
      throw new Error(`Explorer not found for blockchain: ${blockchain}`);
    }

    try {
      const addressInfo = await explorer.getAddress(address);
      this.emit('addressRetrieved', { blockchain, address: addressInfo });
      return addressInfo;
    } catch (error) {
      this.logger.error(`Failed to get address info from ${blockchain}`, error);
      throw error;
    }
  }

  async getNetworkStats(blockchain: string): Promise<NetworkStats> {
    const explorer = this.explorers.get(blockchain);
    if (!explorer) {
      throw new Error(`Explorer not found for blockchain: ${blockchain}`);
    }

    try {
      const stats = await explorer.getNetworkStats();
      this.emit('networkStatsRetrieved', { blockchain, stats });
      return stats;
    } catch (error) {
      this.logger.error(`Failed to get network stats from ${blockchain}`, error);
      throw error;
    }
  }

  getBlockchains(): string[] {
    return Array.from(this.explorers.keys());
  }

  getStats() {
    const stats: Record<string, any> = {};
    
    for (const [name, explorer] of this.explorers) {
      stats[name] = {
        cache: (explorer as any).cache.getStats(),
        rateLimit: (explorer as any).rateLimiter.getStats()
      };
    }

    return {
      blockchains: this.getBlockchains(),
      explorerStats: stats,
      totalExplorers: this.explorers.size
    };
  }

  removeBlockchain(name: string): boolean {
    const removed = this.explorers.delete(name);
    if (removed) {
      this.logger.info(`Block explorer removed for ${name}`);
    }
    return removed;
  }

  clear(): void {
    this.explorers.clear();
    this.logger.info('All block explorers cleared');
  }
}

export {
  LightBlockExplorer,
  ExplorerConfig,
  BlockInfo,
  TransactionInfo,
  AddressInfo,
  NetworkStats,
  ExplorerFactory
};