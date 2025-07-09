// Wallet integration for direct payments (Carmack direct approach)
import { EventEmitter } from 'events';
import { createComponentLogger } from '../logging/logger';
import * as bitcoin from 'bitcoinjs-lib';
import * as bip39 from 'bip39';
import * as bip32 from 'bip32';

const logger = createComponentLogger('wallet-integration');

// Wallet types
export enum WalletType {
  BITCOIN = 'bitcoin',
  LITECOIN = 'litecoin',
  ETHEREUM = 'ethereum',
  MONERO = 'monero'
}

// Transaction status
export enum TransactionStatus {
  PENDING = 'pending',
  BROADCASTING = 'broadcasting',
  CONFIRMED = 'confirmed',
  FAILED = 'failed'
}

// Wallet configuration
export interface WalletConfig {
  type: WalletType;
  network: 'mainnet' | 'testnet';
  rpcUrl: string;
  rpcUser?: string;
  rpcPassword?: string;
  apiKey?: string;
  confirmations: number;
  feeRate?: number; // satoshis per byte
}

// Address info
export interface AddressInfo {
  address: string;
  type: 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'bech32';
  balance?: number;
  transactions?: number;
}

// Transaction
export interface WalletTransaction {
  id: string;
  txid?: string;
  from: string;
  to: string;
  amount: number;
  fee: number;
  status: TransactionStatus;
  confirmations: number;
  timestamp: Date;
  metadata?: any;
}

// UTXO
export interface UTXO {
  txid: string;
  vout: number;
  value: number;
  scriptPubKey: string;
  confirmations: number;
}

// Base wallet interface
export abstract class BaseWallet extends EventEmitter {
  protected config: WalletConfig;
  
  constructor(config: WalletConfig) {
    super();
    this.config = config;
  }
  
  // Abstract methods
  abstract validateAddress(address: string): Promise<boolean>;
  abstract getBalance(address: string): Promise<number>;
  abstract createTransaction(
    from: string,
    to: string,
    amount: number,
    fee?: number
  ): Promise<string>;
  abstract broadcastTransaction(txHex: string): Promise<string>;
  abstract getTransaction(txid: string): Promise<WalletTransaction | null>;
  abstract estimateFee(numBlocks: number): Promise<number>;
}

// Bitcoin wallet implementation
export class BitcoinWallet extends BaseWallet {
  private network: bitcoin.Network;
  
  constructor(config: WalletConfig) {
    super(config);
    
    this.network = config.network === 'mainnet' 
      ? bitcoin.networks.bitcoin 
      : bitcoin.networks.testnet;
  }
  
  // Validate Bitcoin address
  async validateAddress(address: string): Promise<boolean> {
    try {
      bitcoin.address.toOutputScript(address, this.network);
      return true;
    } catch (error) {
      return false;
    }
  }
  
  // Get address balance
  async getBalance(address: string): Promise<number> {
    try {
      const response = await this.rpcCall('getaddressinfo', [address]);
      if (!response.ismine) {
        // Use external API or index
        return await this.getBalanceFromAPI(address);
      }
      
      // Get balance from wallet
      const balance = await this.rpcCall('getbalance', []);
      return balance;
      
    } catch (error) {
      logger.error('Failed to get balance', error as Error);
      throw error;
    }
  }
  
  // Create transaction
  async createTransaction(
    from: string,
    to: string,
    amount: number,
    fee?: number
  ): Promise<string> {
    try {
      // Get UTXOs
      const utxos = await this.getUTXOs(from);
      
      // Select UTXOs
      const { selectedUtxos, totalValue } = this.selectUTXOs(utxos, amount + (fee || 0));
      
      if (totalValue < amount + (fee || 0)) {
        throw new Error('Insufficient funds');
      }
      
      // Create transaction
      const psbt = new bitcoin.Psbt({ network: this.network });
      
      // Add inputs
      for (const utxo of selectedUtxos) {
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          nonWitnessUtxo: Buffer.from(utxo.scriptPubKey, 'hex')
        });
      }
      
      // Add outputs
      psbt.addOutput({
        address: to,
        value: Math.floor(amount * 100000000) // Convert to satoshis
      });
      
      // Add change output if needed
      const change = totalValue - amount - (fee || 0);
      if (change > 0.00001) { // Dust threshold
        psbt.addOutput({
          address: from,
          value: Math.floor(change * 100000000)
        });
      }
      
      return psbt.toHex();
      
    } catch (error) {
      logger.error('Failed to create transaction', error as Error);
      throw error;
    }
  }
  
  // Broadcast transaction
  async broadcastTransaction(txHex: string): Promise<string> {
    try {
      const txid = await this.rpcCall('sendrawtransaction', [txHex]);
      
      logger.info('Transaction broadcast', { txid });
      
      this.emit('transaction:broadcast', { txid });
      
      return txid;
      
    } catch (error) {
      logger.error('Failed to broadcast transaction', error as Error);
      throw error;
    }
  }
  
  // Get transaction details
  async getTransaction(txid: string): Promise<WalletTransaction | null> {
    try {
      const tx = await this.rpcCall('gettransaction', [txid]);
      
      if (!tx) return null;
      
      return {
        id: txid,
        txid: tx.txid,
        from: '', // Would need to parse inputs
        to: '', // Would need to parse outputs
        amount: Math.abs(tx.amount),
        fee: tx.fee || 0,
        status: tx.confirmations > 0 ? TransactionStatus.CONFIRMED : TransactionStatus.PENDING,
        confirmations: tx.confirmations,
        timestamp: new Date(tx.time * 1000),
        metadata: {
          blockhash: tx.blockhash,
          blockheight: tx.blockheight
        }
      };
      
    } catch (error) {
      logger.error('Failed to get transaction', error as Error);
      return null;
    }
  }
  
  // Estimate fee
  async estimateFee(numBlocks: number = 6): Promise<number> {
    try {
      const feeRate = await this.rpcCall('estimatesmartfee', [numBlocks]);
      
      if (feeRate.feerate) {
        // Convert from BTC/kB to satoshis/byte
        return Math.ceil(feeRate.feerate * 100000);
      }
      
      // Fallback fee rate
      return this.config.feeRate || 10;
      
    } catch (error) {
      logger.error('Failed to estimate fee', error as Error);
      return this.config.feeRate || 10;
    }
  }
  
  // Get UTXOs for address
  private async getUTXOs(address: string): Promise<UTXO[]> {
    try {
      const utxos = await this.rpcCall('listunspent', [1, 9999999, [address]]);
      
      return utxos.map((utxo: any) => ({
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.amount,
        scriptPubKey: utxo.scriptPubKey,
        confirmations: utxo.confirmations
      }));
      
    } catch (error) {
      logger.error('Failed to get UTXOs', error as Error);
      throw error;
    }
  }
  
  // Select UTXOs for transaction
  private selectUTXOs(
    utxos: UTXO[],
    targetAmount: number
  ): { selectedUtxos: UTXO[]; totalValue: number } {
    // Sort by value descending
    const sorted = [...utxos].sort((a, b) => b.value - a.value);
    
    const selected: UTXO[] = [];
    let total = 0;
    
    // Greedy selection
    for (const utxo of sorted) {
      selected.push(utxo);
      total += utxo.value;
      
      if (total >= targetAmount) {
        break;
      }
    }
    
    return {
      selectedUtxos: selected,
      totalValue: total
    };
  }
  
  // Get balance from external API
  private async getBalanceFromAPI(address: string): Promise<number> {
    // Mock - would use blockchain.info or similar
    return 0;
  }
  
  // Make RPC call
  private async rpcCall(method: string, params: any[] = []): Promise<any> {
    const { rpcUrl, rpcUser, rpcPassword } = this.config;
    
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(`${rpcUser}:${rpcPassword}`).toString('base64')
      },
      body: JSON.stringify({
        jsonrpc: '1.0',
        id: Date.now(),
        method,
        params
      })
    });
    
    const data = await response.json();
    
    if (data.error) {
      throw new Error(data.error.message);
    }
    
    return data.result;
  }
}

// Wallet manager for multiple wallets
export class WalletManager extends EventEmitter {
  private wallets = new Map<string, BaseWallet>();
  private transactions = new Map<string, WalletTransaction>();
  
  constructor() {
    super();
  }
  
  // Add wallet
  addWallet(id: string, wallet: BaseWallet): void {
    this.wallets.set(id, wallet);
    
    // Forward events
    wallet.on('transaction:broadcast', (data) => {
      this.emit('transaction:broadcast', { walletId: id, ...data });
    });
    
    logger.info('Wallet added', { id, type: wallet.constructor.name });
  }
  
  // Get wallet
  getWallet(id: string): BaseWallet | undefined {
    return this.wallets.get(id);
  }
  
  // Create batch payment
  async createBatchPayment(
    walletId: string,
    payments: Array<{ address: string; amount: number }>
  ): Promise<string[]> {
    const wallet = this.wallets.get(walletId);
    if (!wallet) {
      throw new Error('Wallet not found');
    }
    
    const txids: string[] = [];
    
    // Validate all addresses first
    for (const payment of payments) {
      const isValid = await wallet.validateAddress(payment.address);
      if (!isValid) {
        throw new Error(`Invalid address: ${payment.address}`);
      }
    }
    
    // Create transactions
    for (const payment of payments) {
      try {
        const txHex = await wallet.createTransaction(
          '', // From pool wallet
          payment.address,
          payment.amount
        );
        
        const txid = await wallet.broadcastTransaction(txHex);
        txids.push(txid);
        
        // Store transaction
        const tx: WalletTransaction = {
          id: `${walletId}-${txid}`,
          txid,
          from: walletId,
          to: payment.address,
          amount: payment.amount,
          fee: 0, // Will be updated
          status: TransactionStatus.BROADCASTING,
          confirmations: 0,
          timestamp: new Date()
        };
        
        this.transactions.set(tx.id, tx);
        
      } catch (error) {
        logger.error('Batch payment failed', error as Error, {
          address: payment.address,
          amount: payment.amount
        });
      }
    }
    
    return txids;
  }
  
  // Monitor transaction confirmations
  async monitorTransaction(walletId: string, txid: string): Promise<void> {
    const wallet = this.wallets.get(walletId);
    if (!wallet) return;
    
    const checkConfirmations = async () => {
      try {
        const tx = await wallet.getTransaction(txid);
        if (!tx) return;
        
        const stored = this.transactions.get(`${walletId}-${txid}`);
        if (stored) {
          stored.confirmations = tx.confirmations;
          stored.status = tx.status;
          
          if (tx.confirmations >= wallet['config'].confirmations) {
            this.emit('transaction:confirmed', {
              walletId,
              transaction: stored
            });
            return; // Stop monitoring
          }
        }
        
        // Check again in 1 minute
        setTimeout(checkConfirmations, 60000);
        
      } catch (error) {
        logger.error('Transaction monitoring failed', error as Error);
      }
    };
    
    checkConfirmations();
  }
  
  // Get transaction history
  getTransactionHistory(
    filter?: {
      walletId?: string;
      status?: TransactionStatus;
      minAmount?: number;
      startDate?: Date;
      endDate?: Date;
    }
  ): WalletTransaction[] {
    let transactions = Array.from(this.transactions.values());
    
    if (filter) {
      if (filter.walletId) {
        transactions = transactions.filter(tx => 
          tx.id.startsWith(filter.walletId!)
        );
      }
      
      if (filter.status) {
        transactions = transactions.filter(tx => 
          tx.status === filter.status
        );
      }
      
      if (filter.minAmount) {
        transactions = transactions.filter(tx => 
          tx.amount >= filter.minAmount!
        );
      }
      
      if (filter.startDate) {
        transactions = transactions.filter(tx => 
          tx.timestamp >= filter.startDate!
        );
      }
      
      if (filter.endDate) {
        transactions = transactions.filter(tx => 
          tx.timestamp <= filter.endDate!
        );
      }
    }
    
    return transactions.sort((a, b) => 
      b.timestamp.getTime() - a.timestamp.getTime()
    );
  }
  
  // Get wallet statistics
  getStats(): {
    wallets: number;
    transactions: {
      total: number;
      pending: number;
      confirmed: number;
      failed: number;
    };
    volume: {
      total: number;
      last24h: number;
    };
  } {
    const transactions = Array.from(this.transactions.values());
    const now = Date.now();
    const dayAgo = now - 86400000;
    
    return {
      wallets: this.wallets.size,
      transactions: {
        total: transactions.length,
        pending: transactions.filter(tx => tx.status === TransactionStatus.PENDING).length,
        confirmed: transactions.filter(tx => tx.status === TransactionStatus.CONFIRMED).length,
        failed: transactions.filter(tx => tx.status === TransactionStatus.FAILED).length
      },
      volume: {
        total: transactions.reduce((sum, tx) => sum + tx.amount, 0),
        last24h: transactions
          .filter(tx => tx.timestamp.getTime() > dayAgo)
          .reduce((sum, tx) => sum + tx.amount, 0)
      }
    };
  }
}

// HD wallet for deterministic addresses
export class HDWallet {
  private seed: Buffer;
  private root: bip32.BIP32Interface;
  private network: bitcoin.Network;
  
  constructor(
    mnemonic: string,
    network: bitcoin.Network = bitcoin.networks.bitcoin
  ) {
    this.seed = bip39.mnemonicToSeedSync(mnemonic);
    this.root = bip32.fromSeed(this.seed, network);
    this.network = network;
  }
  
  // Generate new address
  generateAddress(
    account: number = 0,
    index: number = 0,
    change: boolean = false
  ): AddressInfo {
    const path = `m/84'/0'/${account}'/${change ? 1 : 0}/${index}`;
    const child = this.root.derivePath(path);
    
    const { address } = bitcoin.payments.p2wpkh({
      pubkey: child.publicKey,
      network: this.network
    });
    
    return {
      address: address!,
      type: 'p2wpkh'
    };
  }
  
  // Get private key for address
  getPrivateKey(path: string): Buffer {
    const child = this.root.derivePath(path);
    return child.privateKey!;
  }
  
  // Generate multiple addresses
  generateAddresses(
    count: number,
    account: number = 0,
    startIndex: number = 0
  ): AddressInfo[] {
    const addresses: AddressInfo[] = [];
    
    for (let i = 0; i < count; i++) {
      addresses.push(this.generateAddress(account, startIndex + i));
    }
    
    return addresses;
  }
}

// Fee estimator
export class FeeEstimator {
  private cache = new Map<string, { fee: number; timestamp: number }>();
  private cacheTimeout = 300000; // 5 minutes
  
  constructor(
    private wallets: Map<string, BaseWallet>
  ) {}
  
  // Estimate fee for transaction
  async estimateFee(
    walletId: string,
    priority: 'low' | 'medium' | 'high' = 'medium'
  ): Promise<number> {
    const cacheKey = `${walletId}-${priority}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.fee;
    }
    
    const wallet = this.wallets.get(walletId);
    if (!wallet) {
      throw new Error('Wallet not found');
    }
    
    const blocks = priority === 'high' ? 2 : priority === 'medium' ? 6 : 12;
    const fee = await wallet.estimateFee(blocks);
    
    this.cache.set(cacheKey, {
      fee,
      timestamp: Date.now()
    });
    
    return fee;
  }
  
  // Clear cache
  clearCache(): void {
    this.cache.clear();
  }
}
