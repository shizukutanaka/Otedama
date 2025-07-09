import axios, { AxiosInstance } from 'axios';
import { EventEmitter } from 'events';

/**
 * Blockchain RPC client implementation
 * Simple and direct approach following John Carmack's principles
 */

export interface BlockchainInfo {
  height: number;
  difficulty: number;
  networkHashrate: number;
  lastBlockTime: number;
  chain: string;
}

export interface BlockTemplate {
  previousBlockHash: string;
  height: number;
  transactions: string[];
  coinbaseValue: number;
  target: string;
  minTime: number;
  curTime: number;
  bits: string;
  weightLimit?: number;
}

export interface Block {
  hash: string;
  height: number;
  previousHash: string;
  timestamp: number;
  transactions: string[];
  difficulty: number;
}

export abstract class BlockchainClient extends EventEmitter {
  protected rpcClient: AxiosInstance;
  protected rpcId = 0;

  constructor(
    protected rpcUrl: string,
    protected rpcUser?: string,
    protected rpcPassword?: string
  ) {
    super();

    const auth = rpcUser && rpcPassword ? {
      username: rpcUser,
      password: rpcPassword
    } : undefined;

    this.rpcClient = axios.create({
      baseURL: rpcUrl,
      auth,
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
  }

  protected async rpcCall(method: string, params: any[] = []): Promise<any> {
    const payload = {
      jsonrpc: '2.0',
      id: ++this.rpcId,
      method,
      params
    };

    try {
      const response = await this.rpcClient.post('', payload);
      
      if (response.data.error) {
        throw new Error(`RPC Error: ${response.data.error.message}`);
      }

      return response.data.result;
    } catch (error: any) {
      this.emit('error', error);
      throw error;
    }
  }

  abstract getInfo(): Promise<BlockchainInfo>;
  abstract getBlockTemplate(address: string): Promise<BlockTemplate>;
  abstract submitBlock(blockHex: string): Promise<string>;
  abstract validateAddress(address: string): Promise<boolean>;
}

export class BitcoinClient extends BlockchainClient {
  async getInfo(): Promise<BlockchainInfo> {
    const [blockchainInfo, networkInfo, miningInfo] = await Promise.all([
      this.rpcCall('getblockchaininfo'),
      this.rpcCall('getnetworkinfo'),
      this.rpcCall('getmininginfo')
    ]);

    return {
      height: blockchainInfo.blocks,
      difficulty: blockchainInfo.difficulty,
      networkHashrate: miningInfo.networkhashps || 0,
      lastBlockTime: blockchainInfo.mediantime,
      chain: blockchainInfo.chain
    };
  }

  async getBlockTemplate(address: string): Promise<BlockTemplate> {
    // First check if address is valid
    const isValid = await this.validateAddress(address);
    if (!isValid) {
      throw new Error(`Invalid address: ${address}`);
    }

    const template = await this.rpcCall('getblocktemplate', [{
      capabilities: ['coinbasetxn', 'workid', 'coinbase/append'],
      rules: ['segwit']
    }]);

    return {
      previousBlockHash: template.previousblockhash,
      height: template.height,
      transactions: template.transactions.map((tx: any) => tx.data),
      coinbaseValue: template.coinbasevalue,
      target: template.target,
      minTime: template.mintime,
      curTime: template.curtime,
      bits: template.bits,
      weightLimit: template.weightlimit
    };
  }

  async submitBlock(blockHex: string): Promise<string> {
    const result = await this.rpcCall('submitblock', [blockHex]);
    
    if (result === null) {
      // Success - get the block hash
      const block = await this.rpcCall('getblock', [blockHex]);
      return block.hash;
    }
    
    throw new Error(`Block submission failed: ${result}`);
  }

  async validateAddress(address: string): Promise<boolean> {
    try {
      const result = await this.rpcCall('validateaddress', [address]);
      return result.isvalid;
    } catch {
      // Fallback to newer method if available
      try {
        const result = await this.rpcCall('getaddressinfo', [address]);
        return result.isvalid;
      } catch {
        return false;
      }
    }
  }

  async getBalance(address: string): Promise<number> {
    const result = await this.rpcCall('getreceivedbyaddress', [address, 1]);
    return result;
  }
}

export class EthereumClient extends BlockchainClient {
  async getInfo(): Promise<BlockchainInfo> {
    const [blockNumber, block, syncing, hashrate] = await Promise.all([
      this.rpcCall('eth_blockNumber'),
      this.rpcCall('eth_getBlockByNumber', ['latest', false]),
      this.rpcCall('eth_syncing'),
      this.rpcCall('eth_hashrate')
    ]);

    const height = parseInt(blockNumber, 16);
    const difficulty = parseInt(block.difficulty, 16);

    return {
      height,
      difficulty,
      networkHashrate: parseInt(hashrate, 16),
      lastBlockTime: parseInt(block.timestamp, 16),
      chain: syncing ? 'syncing' : 'mainnet'
    };
  }

  async getBlockTemplate(address: string): Promise<BlockTemplate> {
    const [block, gasPrice] = await Promise.all([
      this.rpcCall('eth_getBlockByNumber', ['latest', false]),
      this.rpcCall('eth_gasPrice')
    ]);

    return {
      previousBlockHash: block.hash,
      height: parseInt(block.number, 16) + 1,
      transactions: [], // Will be filled by the pool
      coinbaseValue: 2 * 1e18, // 2 ETH base reward
      target: this.difficultyToTarget(parseInt(block.difficulty, 16)),
      minTime: parseInt(block.timestamp, 16) + 1,
      curTime: Math.floor(Date.now() / 1000),
      bits: block.difficulty
    };
  }

  async submitBlock(blockHex: string): Promise<string> {
    const result = await this.rpcCall('eth_submitWork', [blockHex]);
    if (!result) {
      throw new Error('Block submission failed');
    }
    return blockHex; // Return the block hash
  }

  async validateAddress(address: string): Promise<boolean> {
    // Basic Ethereum address validation
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return false;
    }

    // Check if it's a contract
    try {
      const code = await this.rpcCall('eth_getCode', [address, 'latest']);
      return code === '0x'; // Empty code means it's an EOA
    } catch {
      return true; // Assume valid if we can't check
    }
  }

  async getBalance(address: string): Promise<number> {
    const result = await this.rpcCall('eth_getBalance', [address, 'latest']);
    return parseInt(result, 16) / 1e18; // Convert from Wei to ETH
  }

  private difficultyToTarget(difficulty: number): string {
    const maxTarget = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
    const target = maxTarget / BigInt(difficulty);
    return '0x' + target.toString(16).padStart(64, '0');
  }
}

// Factory for creating blockchain clients
export class BlockchainClientFactory {
  static create(
    type: 'bitcoin' | 'ethereum' | 'litecoin' | 'dogecoin',
    rpcUrl: string,
    rpcUser?: string,
    rpcPassword?: string
  ): BlockchainClient {
    switch (type) {
      case 'bitcoin':
      case 'litecoin':
      case 'dogecoin':
        return new BitcoinClient(rpcUrl, rpcUser, rpcPassword);
      case 'ethereum':
        return new EthereumClient(rpcUrl, rpcUser, rpcPassword);
      default:
        throw new Error(`Unsupported blockchain type: ${type}`);
    }
  }
}

// Blockchain monitor for real-time updates
export class BlockchainMonitor extends EventEmitter {
  private client: BlockchainClient;
  private pollInterval: number;
  private pollTimer?: NodeJS.Timeout;
  private lastBlockHeight = 0;

  constructor(client: BlockchainClient, pollInterval = 5000) {
    super();
    this.client = client;
    this.pollInterval = pollInterval;
  }

  async start(): Promise<void> {
    // Get initial state
    const info = await this.client.getInfo();
    this.lastBlockHeight = info.height;
    this.emit('initialized', info);

    // Start polling
    this.pollTimer = setInterval(async () => {
      try {
        const info = await this.client.getInfo();
        
        if (info.height > this.lastBlockHeight) {
          this.emit('newBlock', {
            height: info.height,
            previousHeight: this.lastBlockHeight
          });
          this.lastBlockHeight = info.height;
        }

        this.emit('update', info);
      } catch (error) {
        this.emit('error', error);
      }
    }, this.pollInterval);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }
}
