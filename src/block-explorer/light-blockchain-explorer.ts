/**
 * 軽量ブロックチェーンエクスプローラー統合
 * 設計思想: Rob Pike (シンプル), John Carmack (高性能), Robert C. Martin (クリーン)
 * 
 * 特徴:
 * - 複数ブロックチェーン対応
 * - リアルタイムチェーン情報
 * - トランザクション検証
 * - ブロック情報取得
 * - アドレス残高確認
 * - 軽量かつ高速
 */

import { EventEmitter } from 'events';
import axios from 'axios';

// === 型定義 ===
export interface BlockchainConfig {
  type: 'bitcoin' | 'ethereum' | 'litecoin' | 'dogecoin';
  explorerUrl: string;
  apiKey?: string;
  rpcUrl?: string;
  websocketUrl?: string;
}

export interface BlockInfo {
  hash: string;
  height: number;
  timestamp: number;
  size: number;
  txCount: number;
  difficulty: number;
  bits: string;
  nonce: number;
  merkleRoot: string;
  prevHash: string;
  nextHash?: string;
  confirmations: number;
  miner?: string;
  reward: number;
  fees: number;
}

export interface TransactionInfo {
  txid: string;
  hash: string;
  version: number;
  size: number;
  lockTime: number;
  blockHash?: string;
  blockHeight?: number;
  blockTime?: number;
  confirmations: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  fee: number;
  feeRate: number;
  status: 'confirmed' | 'unconfirmed' | 'failed';
}

export interface TxInput {
  txid: string;
  vout: number;
  scriptSig: string;
  sequence: number;
  value?: number;
  address?: string;
}

export interface TxOutput {
  value: number;
  n: number;
  scriptPubKey: string;
  address?: string;
  type: string;
}

export interface AddressInfo {
  address: string;
  balance: number;
  totalReceived: number;
  totalSent: number;
  txCount: number;
  unconfirmedBalance: number;
  firstSeen?: number;
  lastSeen?: number;
}

export interface NetworkInfo {
  name: string;
  symbol: string;
  blockHeight: number;
  difficulty: number;
  hashrate: number;
  blockTime: number;
  totalSupply: number;
  circulatingSupply: number;
  price?: number;
}

export interface MempoolInfo {
  size: number;
  bytes: number;
  usage: number;
  maxMempool: number;
  mempoolMinFee: number;
  minRelayTxFee: number;
}

// === ブロックチェーンエクスプローラー統合 ===
export class LightBlockchainExplorer extends EventEmitter {
  private configs = new Map<string, BlockchainConfig>();
  private cache = new Map<string, { data: any; expires: number }>();
  private updateTimers = new Map<string, NodeJS.Timeout>();
  private cacheTimeout = 60000; // 1分

  constructor() {
    super();
    this.setupDefaultConfigs();
  }

  // === 設定管理 ===
  addBlockchain(name: string, config: BlockchainConfig): void {
    this.configs.set(name, config);
    console.log(`⛓️ Added blockchain: ${name} (${config.type})`);
  }

  removeBlockchain(name: string): boolean {
    const timer = this.updateTimers.get(name);
    if (timer) {
      clearInterval(timer);
      this.updateTimers.delete(name);
    }
    return this.configs.delete(name);
  }

  private setupDefaultConfigs(): void {
    // Bitcoin
    this.addBlockchain('bitcoin', {
      type: 'bitcoin',
      explorerUrl: 'https://blockstream.info/api',
      rpcUrl: process.env.BTC_RPC_URL,
      websocketUrl: 'wss://ws.blockchain.info/inv'
    });

    // Ethereum
    this.addBlockchain('ethereum', {
      type: 'ethereum',
      explorerUrl: 'https://api.etherscan.io/api',
      apiKey: process.env.ETHERSCAN_API_KEY,
      rpcUrl: process.env.ETH_RPC_URL
    });

    // Litecoin
    this.addBlockchain('litecoin', {
      type: 'litecoin',
      explorerUrl: 'https://api.blockcypher.com/v1/ltc/main',
      apiKey: process.env.BLOCKCYPHER_API_KEY,
      rpcUrl: process.env.LTC_RPC_URL
    });

    // Dogecoin
    this.addBlockchain('dogecoin', {
      type: 'dogecoin',
      explorerUrl: 'https://api.blockcypher.com/v1/doge/main',
      apiKey: process.env.BLOCKCYPHER_API_KEY,
      rpcUrl: process.env.DOGE_RPC_URL
    });
  }

  // === ブロック情報取得 ===
  async getBlock(blockchain: string, hashOrHeight: string | number): Promise<BlockInfo> {
    const cacheKey = `block-${blockchain}-${hashOrHeight}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    const config = this.configs.get(blockchain);
    if (!config) {
      throw new Error(`Blockchain ${blockchain} not configured`);
    }

    let blockInfo: BlockInfo;

    switch (config.type) {
      case 'bitcoin':
        blockInfo = await this.getBitcoinBlock(config, hashOrHeight);
        break;
      case 'ethereum':
        blockInfo = await this.getEthereumBlock(config, hashOrHeight);
        break;
      case 'litecoin':
      case 'dogecoin':
        blockInfo = await this.getBlockCypherBlock(config, hashOrHeight);
        break;
      default:
        throw new Error(`Unsupported blockchain type: ${config.type}`);
    }

    this.setCache(cacheKey, blockInfo);
    return blockInfo;
  }

  private async getBitcoinBlock(config: BlockchainConfig, hashOrHeight: string | number): Promise<BlockInfo> {
    const endpoint = typeof hashOrHeight === 'number' 
      ? `${config.explorerUrl}/block-height/${hashOrHeight}`
      : `${config.explorerUrl}/block/${hashOrHeight}`;

    const response = await axios.get(endpoint, { timeout: 10000 });
    const block = response.data;

    return {
      hash: block.id,
      height: block.height,
      timestamp: block.timestamp,
      size: block.size,
      txCount: block.tx_count,
      difficulty: block.difficulty,
      bits: block.bits.toString(16),
      nonce: block.nonce,
      merkleRoot: block.merkle_root,
      prevHash: block.previous_block_hash,
      nextHash: block.next_block_hash,
      confirmations: block.confirmations || 0,
      reward: block.reward || 0,
      fees: block.fee || 0
    };
  }

  private async getEthereumBlock(config: BlockchainConfig, hashOrHeight: string | number): Promise<BlockInfo> {
    const blockParam = typeof hashOrHeight === 'number' ? hashOrHeight.toString() : hashOrHeight;
    
    const response = await axios.get(config.explorerUrl, {
      params: {
        module: 'proxy',
        action: 'eth_getBlockByNumber',
        tag: blockParam,
        boolean: 'true',
        apikey: config.apiKey
      },
      timeout: 10000
    });

    const block = response.data.result;
    
    return {
      hash: block.hash,
      height: parseInt(block.number, 16),
      timestamp: parseInt(block.timestamp, 16),
      size: parseInt(block.size, 16),
      txCount: block.transactions.length,
      difficulty: parseInt(block.difficulty, 16),
      bits: block.difficulty,
      nonce: parseInt(block.nonce, 16),
      merkleRoot: block.transactionsRoot,
      prevHash: block.parentHash,
      confirmations: 0, // Ethereumでは別途計算が必要
      reward: 0, // 別途計算が必要
      fees: 0
    };
  }

  private async getBlockCypherBlock(config: BlockchainConfig, hashOrHeight: string | number): Promise<BlockInfo> {
    const endpoint = `${config.explorerUrl}/blocks/${hashOrHeight}`;
    const params = config.apiKey ? { token: config.apiKey } : {};

    const response = await axios.get(endpoint, { 
      params,
      timeout: 10000 
    });
    
    const block = response.data;
    
    return {
      hash: block.hash,
      height: block.height,
      timestamp: new Date(block.time).getTime() / 1000,
      size: block.size || 0,
      txCount: block.n_tx,
      difficulty: block.difficulty || 0,
      bits: block.bits?.toString(16) || '',
      nonce: block.nonce || 0,
      merkleRoot: block.mrkl_root,
      prevHash: block.prev_block,
      nextHash: block.next_block,
      confirmations: block.confirmations || 0,
      reward: block.reward || 0,
      fees: block.fees || 0
    };
  }

  // === トランザクション情報取得 ===
  async getTransaction(blockchain: string, txid: string): Promise<TransactionInfo> {
    const cacheKey = `tx-${blockchain}-${txid}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    const config = this.configs.get(blockchain);
    if (!config) {
      throw new Error(`Blockchain ${blockchain} not configured`);
    }

    let txInfo: TransactionInfo;

    switch (config.type) {
      case 'bitcoin':
        txInfo = await this.getBitcoinTransaction(config, txid);
        break;
      case 'ethereum':
        txInfo = await this.getEthereumTransaction(config, txid);
        break;
      case 'litecoin':
      case 'dogecoin':
        txInfo = await this.getBlockCypherTransaction(config, txid);
        break;
      default:
        throw new Error(`Unsupported blockchain type: ${config.type}`);
    }

    this.setCache(cacheKey, txInfo);
    return txInfo;
  }

  private async getBitcoinTransaction(config: BlockchainConfig, txid: string): Promise<TransactionInfo> {
    const response = await axios.get(`${config.explorerUrl}/tx/${txid}`, { timeout: 10000 });
    const tx = response.data;

    return {
      txid: tx.txid,
      hash: tx.hash || tx.txid,
      version: tx.version,
      size: tx.size,
      lockTime: tx.locktime,
      blockHash: tx.status?.block_hash,
      blockHeight: tx.status?.block_height,
      blockTime: tx.status?.block_time,
      confirmations: tx.status?.confirmed ? tx.status.confirmations : 0,
      inputs: tx.vin.map((input: any) => ({
        txid: input.txid,
        vout: input.vout,
        scriptSig: input.scriptsig || '',
        sequence: input.sequence,
        value: input.prevout?.value,
        address: input.prevout?.scriptpubkey_address
      })),
      outputs: tx.vout.map((output: any) => ({
        value: output.value,
        n: output.n,
        scriptPubKey: output.scriptpubkey || '',
        address: output.scriptpubkey_address,
        type: output.scriptpubkey_type
      })),
      fee: tx.fee || 0,
      feeRate: tx.fee && tx.size ? tx.fee / tx.size : 0,
      status: tx.status?.confirmed ? 'confirmed' : 'unconfirmed'
    };
  }

  private async getEthereumTransaction(config: BlockchainConfig, txid: string): Promise<TransactionInfo> {
    const response = await axios.get(config.explorerUrl, {
      params: {
        module: 'proxy',
        action: 'eth_getTransactionByHash',
        txhash: txid,
        apikey: config.apiKey
      },
      timeout: 10000
    });

    const tx = response.data.result;
    
    return {
      txid: tx.hash,
      hash: tx.hash,
      version: 1,
      size: parseInt(tx.gas, 16),
      lockTime: 0,
      blockHash: tx.blockHash,
      blockHeight: tx.blockNumber ? parseInt(tx.blockNumber, 16) : undefined,
      confirmations: 0, // 別途計算が必要
      inputs: [{
        txid: '',
        vout: 0,
        scriptSig: tx.input,
        sequence: 0,
        value: parseInt(tx.value, 16),
        address: tx.from
      }],
      outputs: [{
        value: parseInt(tx.value, 16),
        n: 0,
        scriptPubKey: '',
        address: tx.to,
        type: 'transfer'
      }],
      fee: parseInt(tx.gas, 16) * parseInt(tx.gasPrice, 16),
      feeRate: parseInt(tx.gasPrice, 16),
      status: tx.blockNumber ? 'confirmed' : 'unconfirmed'
    };
  }

  private async getBlockCypherTransaction(config: BlockchainConfig, txid: string): Promise<TransactionInfo> {
    const params = config.apiKey ? { token: config.apiKey } : {};
    const response = await axios.get(`${config.explorerUrl}/txs/${txid}`, { 
      params,
      timeout: 10000 
    });
    
    const tx = response.data;
    
    return {
      txid: tx.hash,
      hash: tx.hash,
      version: tx.ver || 1,
      size: tx.size || 0,
      lockTime: tx.lock_time || 0,
      blockHash: tx.block_hash,
      blockHeight: tx.block_height,
      blockTime: tx.confirmed ? new Date(tx.confirmed).getTime() / 1000 : undefined,
      confirmations: tx.confirmations || 0,
      inputs: tx.inputs.map((input: any) => ({
        txid: input.prev_hash,
        vout: input.output_index,
        scriptSig: input.script || '',
        sequence: input.sequence || 0,
        value: input.output_value,
        address: input.addresses?.[0]
      })),
      outputs: tx.outputs.map((output: any, index: number) => ({
        value: output.value,
        n: index,
        scriptPubKey: output.script || '',
        address: output.addresses?.[0],
        type: output.script_type || 'unknown'
      })),
      fee: tx.fees || 0,
      feeRate: tx.fees && tx.size ? tx.fees / tx.size : 0,
      status: tx.confirmed ? 'confirmed' : 'unconfirmed'
    };
  }

  // === アドレス情報取得 ===
  async getAddressInfo(blockchain: string, address: string): Promise<AddressInfo> {
    const cacheKey = `addr-${blockchain}-${address}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    const config = this.configs.get(blockchain);
    if (!config) {
      throw new Error(`Blockchain ${blockchain} not configured`);
    }

    let addressInfo: AddressInfo;

    switch (config.type) {
      case 'bitcoin':
        addressInfo = await this.getBitcoinAddressInfo(config, address);
        break;
      case 'ethereum':
        addressInfo = await this.getEthereumAddressInfo(config, address);
        break;
      case 'litecoin':
      case 'dogecoin':
        addressInfo = await this.getBlockCypherAddressInfo(config, address);
        break;
      default:
        throw new Error(`Unsupported blockchain type: ${config.type}`);
    }

    this.setCache(cacheKey, addressInfo, 30000); // 30秒キャッシュ（残高は頻繁に変わる）
    return addressInfo;
  }

  private async getBitcoinAddressInfo(config: BlockchainConfig, address: string): Promise<AddressInfo> {
    const response = await axios.get(`${config.explorerUrl}/address/${address}`, { timeout: 10000 });
    const addr = response.data;

    return {
      address,
      balance: addr.chain_stats.funded_txo_sum - addr.chain_stats.spent_txo_sum,
      totalReceived: addr.chain_stats.funded_txo_sum,
      totalSent: addr.chain_stats.spent_txo_sum,
      txCount: addr.chain_stats.tx_count,
      unconfirmedBalance: addr.mempool_stats.funded_txo_sum - addr.mempool_stats.spent_txo_sum
    };
  }

  private async getEthereumAddressInfo(config: BlockchainConfig, address: string): Promise<AddressInfo> {
    const balanceResponse = await axios.get(config.explorerUrl, {
      params: {
        module: 'account',
        action: 'balance',
        address,
        tag: 'latest',
        apikey: config.apiKey
      },
      timeout: 10000
    });

    const txCountResponse = await axios.get(config.explorerUrl, {
      params: {
        module: 'proxy',
        action: 'eth_getTransactionCount',
        address,
        tag: 'latest',
        apikey: config.apiKey
      },
      timeout: 10000
    });

    const balance = parseInt(balanceResponse.data.result, 16) / 1e18; // Wei to Ether
    const txCount = parseInt(txCountResponse.data.result, 16);

    return {
      address,
      balance,
      totalReceived: balance, // 簡略化
      totalSent: 0, // 別途計算が必要
      txCount,
      unconfirmedBalance: 0
    };
  }

  private async getBlockCypherAddressInfo(config: BlockchainConfig, address: string): Promise<AddressInfo> {
    const params = config.apiKey ? { token: config.apiKey } : {};
    const response = await axios.get(`${config.explorerUrl}/addrs/${address}/balance`, { 
      params,
      timeout: 10000 
    });
    
    const addr = response.data;
    
    return {
      address,
      balance: addr.balance,
      totalReceived: addr.total_received,
      totalSent: addr.total_sent,
      txCount: addr.n_tx,
      unconfirmedBalance: addr.unconfirmed_balance
    };
  }

  // === ネットワーク情報取得 ===
  async getNetworkInfo(blockchain: string): Promise<NetworkInfo> {
    const cacheKey = `network-${blockchain}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    const config = this.configs.get(blockchain);
    if (!config) {
      throw new Error(`Blockchain ${blockchain} not configured`);
    }

    let networkInfo: NetworkInfo;

    switch (config.type) {
      case 'bitcoin':
        networkInfo = await this.getBitcoinNetworkInfo(config);
        break;
      case 'ethereum':
        networkInfo = await this.getEthereumNetworkInfo(config);
        break;
      case 'litecoin':
        networkInfo = await this.getLitecoinNetworkInfo(config);
        break;
      case 'dogecoin':
        networkInfo = await this.getDogecoinNetworkInfo(config);
        break;
      default:
        throw new Error(`Unsupported blockchain type: ${config.type}`);
    }

    this.setCache(cacheKey, networkInfo, 300000); // 5分キャッシュ
    return networkInfo;
  }

  private async getBitcoinNetworkInfo(config: BlockchainConfig): Promise<NetworkInfo> {
    // 最新ブロック情報から基本情報を取得
    const latestBlock = await this.getBitcoinBlock(config, 'latest');
    
    return {
      name: 'Bitcoin',
      symbol: 'BTC',
      blockHeight: latestBlock.height,
      difficulty: latestBlock.difficulty,
      hashrate: latestBlock.difficulty * Math.pow(2, 32) / 600, // 概算
      blockTime: 600, // 10分
      totalSupply: 21000000,
      circulatingSupply: latestBlock.height * 6.25 // 簡略化
    };
  }

  private async getEthereumNetworkInfo(config: BlockchainConfig): Promise<NetworkInfo> {
    const blockResponse = await axios.get(config.explorerUrl, {
      params: {
        module: 'proxy',
        action: 'eth_blockNumber',
        apikey: config.apiKey
      }
    });

    const blockHeight = parseInt(blockResponse.data.result, 16);
    
    return {
      name: 'Ethereum',
      symbol: 'ETH',
      blockHeight,
      difficulty: 0, // PoSなので0
      hashrate: 0,
      blockTime: 13,
      totalSupply: 120000000, // 概算
      circulatingSupply: 120000000
    };
  }

  private async getLitecoinNetworkInfo(config: BlockchainConfig): Promise<NetworkInfo> {
    // BlockCypher APIから基本情報を取得
    const params = config.apiKey ? { token: config.apiKey } : {};
    const response = await axios.get(config.explorerUrl, { params });
    
    return {
      name: 'Litecoin',
      symbol: 'LTC',
      blockHeight: response.data.height,
      difficulty: 0, // 別途取得が必要
      hashrate: 0,
      blockTime: 150,
      totalSupply: 84000000,
      circulatingSupply: response.data.height * 12.5 // 簡略化
    };
  }

  private async getDogecoinNetworkInfo(config: BlockchainConfig): Promise<NetworkInfo> {
    const params = config.apiKey ? { token: config.apiKey } : {};
    const response = await axios.get(config.explorerUrl, { params });
    
    return {
      name: 'Dogecoin',
      symbol: 'DOGE',
      blockHeight: response.data.height,
      difficulty: 0,
      hashrate: 0,
      blockTime: 60,
      totalSupply: Infinity, // Dogecoinは上限なし
      circulatingSupply: response.data.height * 10000 // 簡略化
    };
  }

  // === リアルタイム更新 ===
  startRealtimeUpdates(blockchain: string, intervalMs = 30000): void {
    const existingTimer = this.updateTimers.get(blockchain);
    if (existingTimer) {
      clearInterval(existingTimer);
    }

    const timer = setInterval(async () => {
      try {
        const networkInfo = await this.getNetworkInfo(blockchain);
        this.emit('networkUpdate', { blockchain, networkInfo });
        
        // 最新ブロック情報も更新
        const latestBlock = await this.getBlock(blockchain, 'latest');
        this.emit('newBlock', { blockchain, block: latestBlock });
        
      } catch (error) {
        console.error(`Failed to update ${blockchain}:`, error);
      }
    }, intervalMs);

    this.updateTimers.set(blockchain, timer);
    console.log(`🔄 Started realtime updates for ${blockchain}`);
  }

  stopRealtimeUpdates(blockchain: string): void {
    const timer = this.updateTimers.get(blockchain);
    if (timer) {
      clearInterval(timer);
      this.updateTimers.delete(blockchain);
      console.log(`⏹️ Stopped realtime updates for ${blockchain}`);
    }
  }

  // === キャッシュ管理 ===
  private getFromCache(key: string): any | null {
    const cached = this.cache.get(key);
    if (cached && Date.now() < cached.expires) {
      return cached.data;
    }
    if (cached) {
      this.cache.delete(key);
    }
    return null;
  }

  private setCache(key: string, data: any, ttl = this.cacheTimeout): void {
    this.cache.set(key, {
      data,
      expires: Date.now() + ttl
    });
  }

  private clearCache(): void {
    this.cache.clear();
  }

  // === ユーティリティ ===
  async validateAddress(blockchain: string, address: string): Promise<boolean> {
    try {
      await this.getAddressInfo(blockchain, address);
      return true;
    } catch (error) {
      return false;
    }
  }

  async validateTransaction(blockchain: string, txid: string): Promise<boolean> {
    try {
      const tx = await this.getTransaction(blockchain, txid);
      return tx.status === 'confirmed';
    } catch (error) {
      return false;
    }
  }

  getSupportedBlockchains(): string[] {
    return Array.from(this.configs.keys());
  }

  getBlockchainConfig(blockchain: string): BlockchainConfig | undefined {
    return this.configs.get(blockchain);
  }

  // === 停止処理 ===
  stop(): void {
    // 全タイマーを停止
    for (const timer of this.updateTimers.values()) {
      clearInterval(timer);
    }
    this.updateTimers.clear();
    
    // キャッシュクリア
    this.clearCache();
    
    console.log('🛑 Blockchain explorer stopped');
  }
}

// === ヘルパークラス ===
export class BlockchainExplorerHelper {
  static createBitcoinConfig(explorerUrl?: string, rpcUrl?: string): BlockchainConfig {
    return {
      type: 'bitcoin',
      explorerUrl: explorerUrl || 'https://blockstream.info/api',
      rpcUrl
    };
  }

  static createEthereumConfig(apiKey?: string, explorerUrl?: string): BlockchainConfig {
    return {
      type: 'ethereum',
      explorerUrl: explorerUrl || 'https://api.etherscan.io/api',
      apiKey
    };
  }

  static formatBalance(balance: number, symbol: string): string {
    if (symbol === 'BTC' || symbol === 'LTC') {
      return `${(balance / 1e8).toFixed(8)} ${symbol}`;
    } else if (symbol === 'ETH') {
      return `${balance.toFixed(6)} ${symbol}`;
    } else {
      return `${balance.toFixed(2)} ${symbol}`;
    }
  }

  static formatBlockTime(timestamp: number): string {
    return new Date(timestamp * 1000).toISOString();
  }

  static isValidBitcoinAddress(address: string): boolean {
    return /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^bc1[a-z0-9]{39,59}$/.test(address);
  }

  static isValidEthereumAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  static isValidTransactionHash(hash: string): boolean {
    return /^[a-fA-F0-9]{64}$/.test(hash);
  }

  static shortenHash(hash: string, length = 8): string {
    return `${hash.substring(0, length)}...${hash.substring(hash.length - length)}`;
  }

  static calculateConfirmationTime(confirmations: number, blockTime: number): number {
    return confirmations * blockTime;
  }
}

export default LightBlockchainExplorer;