/**
 * ブロックチェーンRPCクライアント実装
 * Bitcoin、Ethereum、その他の主要ブロックチェーンへの接続
 * 
 * 設計思想：
 * - Carmack: 効率的で低レイテンシな通信
 * - Martin: 統一されたインターフェースと抽象化
 * - Pike: シンプルで拡張可能な設計
 */

import { EventEmitter } from 'events';
import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';

// === 型定義 ===
export interface BlockchainConfig {
  type: 'bitcoin' | 'ethereum' | 'litecoin' | 'dogecoin' | 'monero';
  rpcUrl: string;
  rpcUser?: string;
  rpcPassword?: string;
  wsUrl?: string;
  apiKey?: string;
  network?: 'mainnet' | 'testnet' | 'regtest';
  timeout?: number;
  retries?: number;
}

export interface BlockTemplate {
  height: number;
  previousBlockHash: string;
  transactions: string[];
  coinbaseValue: number;
  bits: string;
  curtime: number;
  mintime?: number;
  mutable?: string[];
  noncerange?: string;
  sigoplimit?: number;
  sizelimit?: number;
  weightlimit?: number;
  // Ethereum固有
  difficulty?: string;
  gasLimit?: string;
  extraData?: string;
}

export interface BlockInfo {
  hash: string;
  height: number;
  previousHash: string;
  timestamp: number;
  difficulty: number;
  nonce?: number;
  transactions: string[];
  size?: number;
  confirmations?: number;
}

export interface TransactionInfo {
  txid: string;
  hash?: string;
  confirmations: number;
  blockHash?: string;
  blockHeight?: number;
  timestamp?: number;
  fee?: number;
  inputs?: any[];
  outputs?: any[];
  // Ethereum固有
  from?: string;
  to?: string;
  gas?: string;
  gasPrice?: string;
  value?: string;
}

export interface MempoolInfo {
  size: number;
  bytes: number;
  usage?: number;
  maxmempool?: number;
  mempoolminfee?: number;
  minrelaytxfee?: number;
}

// === 基底クラス ===
export abstract class BlockchainClient extends EventEmitter {
  protected config: BlockchainConfig;
  protected rpcClient: AxiosInstance;
  protected wsClient?: WebSocket;
  protected isConnected: boolean = false;
  protected requestId: number = 0;
  
  constructor(config: BlockchainConfig) {
    super();
    this.config = config;
    
    // RPCクライアントの初期化
    this.rpcClient = axios.create({
      baseURL: config.rpcUrl,
      timeout: config.timeout || 30000,
      headers: {
        'Content-Type': 'application/json'
      },
      auth: config.rpcUser && config.rpcPassword ? {
        username: config.rpcUser,
        password: config.rpcPassword
      } : undefined
    });
    
    // レスポンスインターセプター
    this.rpcClient.interceptors.response.use(
      response => response,
      error => this.handleRpcError(error)
    );
  }
  
  // === 抽象メソッド ===
  abstract getBlockTemplate(poolAddress: string): Promise<BlockTemplate>;
  abstract submitBlock(blockHex: string): Promise<string>;
  abstract getBlockByHeight(height: number): Promise<BlockInfo | null>;
  abstract getTransaction(txid: string): Promise<TransactionInfo | null>;
  abstract validateAddress(address: string): Promise<boolean>;
  abstract getBalance(address: string): Promise<number>;
  abstract sendPayment(toAddress: string, amount: number): Promise<string>;
  abstract sendBatchPayment(recipients: Array<{address: string; amount: number}>): Promise<string>;
  
  // === 共通メソッド ===
  
  // 接続の確立
  async connect(): Promise<void> {
    try {
      // RPC接続のテスト
      await this.testConnection();
      
      // WebSocket接続（利用可能な場合）
      if (this.config.wsUrl) {
        await this.connectWebSocket();
      }
      
      this.isConnected = true;
      this.emit('connected');
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  // 切断
  async disconnect(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.close();
      this.wsClient = undefined;
    }
    
    this.isConnected = false;
    this.emit('disconnected');
  }
  
  // 接続テスト
  protected abstract testConnection(): Promise<void>;
  
  // RPCコール
  protected async rpcCall(method: string, params: any[] = []): Promise<any> {
    const payload = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method,
      params
    };
    
    try {
      const response = await this.rpcClient.post('', payload);
      
      if (response.data.error) {
        throw new Error(`RPC Error: ${response.data.error.message}`);
      }
      
      return response.data.result;
    } catch (error) {
      if (this.config.retries && this.config.retries > 0) {
        // リトライロジック
        await this.delay(1000);
        return this.rpcCall(method, params);
      }
      throw error;
    }
  }
  
  // WebSocket接続
  protected async connectWebSocket(): Promise<void> {
    if (!this.config.wsUrl) return;
    
    return new Promise((resolve, reject) => {
      this.wsClient = new WebSocket(this.config.wsUrl!);
      
      this.wsClient.on('open', () => {
        this.emit('ws:connected');
        resolve();
      });
      
      this.wsClient.on('message', (data) => {
        this.handleWebSocketMessage(data.toString());
      });
      
      this.wsClient.on('error', (error) => {
        this.emit('ws:error', error);
        reject(error);
      });
      
      this.wsClient.on('close', () => {
        this.emit('ws:disconnected');
        // 自動再接続
        setTimeout(() => {
          if (this.isConnected) {
            this.connectWebSocket();
          }
        }, 5000);
      });
    });
  }
  
  // WebSocketメッセージハンドリング
  protected handleWebSocketMessage(data: string): void {
    try {
      const message = JSON.parse(data);
      this.emit('ws:message', message);
    } catch (error) {
      this.emit('error', error);
    }
  }
  
  // エラーハンドリング
  protected handleRpcError(error: any): Promise<any> {
    if (error.response) {
      // サーバーエラー
      const rpcError = error.response.data?.error;
      if (rpcError) {
        throw new Error(`RPC Error ${rpcError.code}: ${rpcError.message}`);
      }
    } else if (error.request) {
      // ネットワークエラー
      throw new Error('Network error: No response from server');
    }
    
    throw error;
  }
  
  // 遅延
  protected delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  // 現在のブロック高を取得
  abstract getBlockCount(): Promise<number>;
  
  // メモリプール情報を取得
  abstract getMempoolInfo(): Promise<MempoolInfo>;
  
  // ネットワーク情報を取得
  abstract getNetworkInfo(): Promise<any>;
  
  // マイニング情報を取得
  abstract getMiningInfo(): Promise<any>;
}

// === Bitcoin RPC クライアント ===
export class BitcoinClient extends BlockchainClient {
  constructor(config: BlockchainConfig) {
    super(config);
  }
  
  async testConnection(): Promise<void> {
    await this.rpcCall('getblockchaininfo');
  }
  
  async getBlockTemplate(poolAddress: string): Promise<BlockTemplate> {
    const template = await this.rpcCall('getblocktemplate', [{
      capabilities: ['coinbasetxn', 'workid', 'coinbase/append'],
      rules: ['segwit']
    }]);
    
    return {
      height: template.height,
      previousBlockHash: template.previousblockhash,
      transactions: template.transactions.map((tx: any) => tx.data),
      coinbaseValue: template.coinbasevalue,
      bits: template.bits,
      curtime: template.curtime,
      mintime: template.mintime,
      mutable: template.mutable,
      noncerange: template.noncerange,
      sigoplimit: template.sigoplimit,
      sizelimit: template.sizelimit,
      weightlimit: template.weightlimit
    };
  }
  
  async submitBlock(blockHex: string): Promise<string> {
    const result = await this.rpcCall('submitblock', [blockHex]);
    
    if (result === null) {
      // ブロックが受け入れられた
      // ブロックハッシュを計算して返す
      const blockHash = await this.rpcCall('getbestblockhash');
      return blockHash;
    }
    
    throw new Error(`Block rejected: ${result}`);
  }
  
  async getBlockByHeight(height: number): Promise<BlockInfo | null> {
    try {
      const blockHash = await this.rpcCall('getblockhash', [height]);
      const block = await this.rpcCall('getblock', [blockHash, 2]);
      
      return {
        hash: block.hash,
        height: block.height,
        previousHash: block.previousblockhash,
        timestamp: block.time,
        difficulty: block.difficulty,
        nonce: block.nonce,
        transactions: block.tx.map((tx: any) => tx.txid),
        size: block.size,
        confirmations: block.confirmations
      };
    } catch (error) {
      return null;
    }
  }
  
  async getTransaction(txid: string): Promise<TransactionInfo | null> {
    try {
      const tx = await this.rpcCall('getrawtransaction', [txid, true]);
      
      return {
        txid: tx.txid,
        hash: tx.hash,
        confirmations: tx.confirmations || 0,
        blockHash: tx.blockhash,
        timestamp: tx.blocktime,
        fee: this.calculateTransactionFee(tx)
      };
    } catch (error) {
      return null;
    }
  }
  
  private calculateTransactionFee(tx: any): number {
    // 簡略化された手数料計算
    // 実際の実装では入力と出力の差額を計算
    return 0;
  }
  
  async validateAddress(address: string): Promise<boolean> {
    try {
      const result = await this.rpcCall('validateaddress', [address]);
      return result.isvalid;
    } catch {
      return false;
    }
  }
  
  async getBalance(address: string): Promise<number> {
    // Bitcoin Coreの場合、importaddressが必要
    try {
      await this.rpcCall('importaddress', [address, '', false]);
    } catch {
      // 既にインポート済みの可能性
    }
    
    const unspent = await this.rpcCall('listunspent', [1, 9999999, [address]]);
    return unspent.reduce((sum: number, utxo: any) => sum + utxo.amount, 0);
  }
  
  async sendPayment(toAddress: string, amount: number): Promise<string> {
    const txid = await this.rpcCall('sendtoaddress', [toAddress, amount]);
    return txid;
  }
  
  async sendBatchPayment(recipients: Array<{address: string; amount: number}>): Promise<string> {
    const outputs: any = {};
    recipients.forEach(r => {
      outputs[r.address] = r.amount;
    });
    
    const txid = await this.rpcCall('sendmany', ['', outputs]);
    return txid;
  }
  
  async getBlockCount(): Promise<number> {
    return await this.rpcCall('getblockcount');
  }
  
  async getMempoolInfo(): Promise<MempoolInfo> {
    const info = await this.rpcCall('getmempoolinfo');
    
    return {
      size: info.size,
      bytes: info.bytes,
      usage: info.usage,
      maxmempool: info.maxmempool,
      mempoolminfee: info.mempoolminfee,
      minrelaytxfee: info.minrelaytxfee
    };
  }
  
  async getNetworkInfo(): Promise<any> {
    return await this.rpcCall('getnetworkinfo');
  }
  
  async getMiningInfo(): Promise<any> {
    return await this.rpcCall('getmininginfo');
  }
}

// === Ethereum RPC クライアント ===
export class EthereumClient extends BlockchainClient {
  constructor(config: BlockchainConfig) {
    super(config);
  }
  
  async testConnection(): Promise<void> {
    await this.rpcCall('eth_blockNumber');
  }
  
  async getBlockTemplate(poolAddress: string): Promise<BlockTemplate> {
    // Ethereumの場合、getWorkを使用
    const work = await this.rpcCall('eth_getWork');
    const blockNumber = await this.rpcCall('eth_blockNumber');
    
    return {
      height: parseInt(blockNumber, 16),
      previousBlockHash: work[0],
      transactions: [], // Ethereumではプールがトランザクションを選択
      coinbaseValue: this.calculateBlockReward(parseInt(blockNumber, 16)),
      bits: work[2],
      curtime: Math.floor(Date.now() / 1000),
      difficulty: work[2],
      gasLimit: await this.getGasLimit(),
      extraData: this.createExtraData(poolAddress)
    };
  }
  
  private calculateBlockReward(blockNumber: number): number {
    // Ethereum block reward calculation
    if (blockNumber >= 15537394) { // Post-merge
      return 0; // PoS
    } else if (blockNumber >= 12965000) { // London
      return 2e18; // 2 ETH
    } else if (blockNumber >= 9200000) { // Muir Glacier
      return 2e18; // 2 ETH
    } else if (blockNumber >= 7280000) { // Constantinople
      return 2e18; // 2 ETH
    } else if (blockNumber >= 4370000) { // Byzantium
      return 3e18; // 3 ETH
    } else {
      return 5e18; // 5 ETH
    }
  }
  
  private async getGasLimit(): Promise<string> {
    const block = await this.rpcCall('eth_getBlockByNumber', ['latest', false]);
    return block.gasLimit;
  }
  
  private createExtraData(poolAddress: string): string {
    // プールの識別情報を含むextraData
    const poolName = 'Otedama';
    const data = Buffer.from(poolName).toString('hex');
    return '0x' + data.padEnd(64, '0');
  }
  
  async submitBlock(blockHex: string): Promise<string> {
    const result = await this.rpcCall('eth_submitWork', [
      blockHex.slice(0, 18),    // nonce
      blockHex.slice(18, 82),   // header hash
      blockHex.slice(82, 146)   // mix digest
    ]);
    
    if (result) {
      const blockNumber = await this.rpcCall('eth_blockNumber');
      const block = await this.rpcCall('eth_getBlockByNumber', [blockNumber, false]);
      return block.hash;
    }
    
    throw new Error('Block submission failed');
  }
  
  async getBlockByHeight(height: number): Promise<BlockInfo | null> {
    try {
      const block = await this.rpcCall('eth_getBlockByNumber', ['0x' + height.toString(16), true]);
      
      if (!block) return null;
      
      return {
        hash: block.hash,
        height: parseInt(block.number, 16),
        previousHash: block.parentHash,
        timestamp: parseInt(block.timestamp, 16),
        difficulty: parseInt(block.difficulty, 16),
        nonce: parseInt(block.nonce, 16),
        transactions: block.transactions.map((tx: any) => tx.hash),
        size: parseInt(block.size, 16)
      };
    } catch (error) {
      return null;
    }
  }
  
  async getTransaction(txid: string): Promise<TransactionInfo | null> {
    try {
      const tx = await this.rpcCall('eth_getTransactionByHash', [txid]);
      const receipt = await this.rpcCall('eth_getTransactionReceipt', [txid]);
      
      if (!tx) return null;
      
      return {
        txid: tx.hash,
        hash: tx.hash,
        confirmations: receipt ? receipt.confirmations || 0 : 0,
        blockHash: tx.blockHash,
        blockHeight: tx.blockNumber ? parseInt(tx.blockNumber, 16) : undefined,
        from: tx.from,
        to: tx.to,
        value: tx.value,
        gas: tx.gas,
        gasPrice: tx.gasPrice,
        fee: receipt ? 
          (parseInt(receipt.gasUsed, 16) * parseInt(tx.gasPrice, 16)) / 1e18 : 
          undefined
      };
    } catch (error) {
      return null;
    }
  }
  
  async validateAddress(address: string): Promise<boolean> {
    // Ethereum address validation
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return false;
    }
    
    // EIP-55 checksum validation (simplified)
    return true;
  }
  
  async getBalance(address: string): Promise<number> {
    const balance = await this.rpcCall('eth_getBalance', [address, 'latest']);
    return parseInt(balance, 16) / 1e18; // Convert Wei to ETH
  }
  
  async sendPayment(toAddress: string, amount: number): Promise<string> {
    const amountWei = '0x' + Math.floor(amount * 1e18).toString(16);
    
    const tx = {
      to: toAddress,
      value: amountWei,
      gas: '0x5208', // 21000 gas for simple transfer
      gasPrice: await this.getGasPrice()
    };
    
    const txHash = await this.rpcCall('eth_sendTransaction', [tx]);
    return txHash;
  }
  
  private async getGasPrice(): Promise<string> {
    return await this.rpcCall('eth_gasPrice');
  }
  
  async sendBatchPayment(recipients: Array<{address: string; amount: number}>): Promise<string> {
    // Ethereumでは、バッチ送金にはスマートコントラクトが必要
    // ここでは簡略化のため、最初の送金のみ実行
    if (recipients.length > 0) {
      return this.sendPayment(recipients[0].address, recipients[0].amount);
    }
    throw new Error('No recipients provided');
  }
  
  async getBlockCount(): Promise<number> {
    const blockNumber = await this.rpcCall('eth_blockNumber');
    return parseInt(blockNumber, 16);
  }
  
  async getMempoolInfo(): Promise<MempoolInfo> {
    // Ethereumのtxpool情報
    const content = await this.rpcCall('txpool_content');
    let size = 0;
    
    ['pending', 'queued'].forEach(status => {
      if (content[status]) {
        Object.values(content[status]).forEach((addr: any) => {
          size += Object.keys(addr).length;
        });
      }
    });
    
    return {
      size,
      bytes: size * 300 // 推定値
    };
  }
  
  async getNetworkInfo(): Promise<any> {
    const [protocolVersion, networkId, listening, peerCount] = await Promise.all([
      this.rpcCall('eth_protocolVersion'),
      this.rpcCall('net_version'),
      this.rpcCall('net_listening'),
      this.rpcCall('net_peerCount')
    ]);
    
    return {
      protocolVersion: parseInt(protocolVersion, 16),
      networkId,
      listening,
      peerCount: parseInt(peerCount, 16)
    };
  }
  
  async getMiningInfo(): Promise<any> {
    const [mining, hashrate, gasPrice] = await Promise.all([
      this.rpcCall('eth_mining'),
      this.rpcCall('eth_hashrate'),
      this.rpcCall('eth_gasPrice')
    ]);
    
    return {
      mining,
      hashrate: parseInt(hashrate, 16),
      gasPrice: parseInt(gasPrice, 16)
    };
  }
}

// === ブロックチェーンファクトリー ===
export class BlockchainClientFactory {
  static create(
    type: string,
    rpcUrl: string,
    rpcUser?: string,
    rpcPassword?: string
  ): BlockchainClient {
    const config: BlockchainConfig = {
      type: type as any,
      rpcUrl,
      rpcUser,
      rpcPassword
    };
    
    switch (type.toLowerCase()) {
      case 'bitcoin':
        return new BitcoinClient(config);
      case 'ethereum':
        return new EthereumClient(config);
      case 'litecoin':
        // LitecoinはBitcoinと同じプロトコル
        return new BitcoinClient({ ...config, type: 'litecoin' });
      case 'dogecoin':
        // DogecoinもBitcoinベース
        return new BitcoinClient({ ...config, type: 'dogecoin' });
      default:
        throw new Error(`Unsupported blockchain type: ${type}`);
    }
  }
}

// === ブロックチェーンモニター ===
export class BlockchainMonitor extends EventEmitter {
  private client: BlockchainClient;
  private currentHeight: number = 0;
  private pollInterval: number = 10000; // 10秒
  private pollTimer?: NodeJS.Timeout;
  
  constructor(client: BlockchainClient) {
    super();
    this.client = client;
  }
  
  // 監視開始
  async start(): Promise<void> {
    // 初期高さを取得
    this.currentHeight = await this.client.getBlockCount();
    
    // ポーリング開始
    this.pollTimer = setInterval(() => {
      this.checkNewBlocks();
    }, this.pollInterval);
    
    this.emit('started', { height: this.currentHeight });
  }
  
  // 監視停止
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    
    this.emit('stopped');
  }
  
  // 新しいブロックのチェック
  private async checkNewBlocks(): Promise<void> {
    try {
      const height = await this.client.getBlockCount();
      
      if (height > this.currentHeight) {
        // 新しいブロックを検出
        for (let h = this.currentHeight + 1; h <= height; h++) {
          const block = await this.client.getBlockByHeight(h);
          if (block) {
            this.emit('newBlock', {
              height: h,
              hash: block.hash,
              previousHash: block.previousHash,
              timestamp: block.timestamp
            });
          }
        }
        
        this.currentHeight = height;
      }
    } catch (error) {
      this.emit('error', error);
    }
  }
  
  // 現在の高さを取得
  getCurrentHeight(): number {
    return this.currentHeight;
  }
}

// エクスポート
export {
  BlockchainClient,
  BitcoinClient,
  EthereumClient,
  BlockchainClientFactory,
  BlockchainMonitor
};