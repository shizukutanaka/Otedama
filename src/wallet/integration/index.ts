/**
 * Wallet Integration System
 * Direct payment integration with various wallet types
 * Following Martin's clean architecture with security-first approach
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { Logger } from '../../logging/logger';
import { getCacheManager } from '../../cache/redis-cache';
import { getMemoryAlignmentManager } from '../../performance/memory-alignment';

const logger = new Logger('WalletIntegration');

// Supported wallet types
export enum WalletType {
  BITCOIN_CORE = 'bitcoin-core',
  ELECTRUM = 'electrum',
  HARDWARE = 'hardware',
  MOBILE = 'mobile',
  EXCHANGE = 'exchange',
  CUSTODIAL = 'custodial',
  MULTISIG = 'multisig',
  LIGHTNING = 'lightning'
}

// Transaction status
export enum TransactionStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  REPLACED = 'replaced'
}

// Wallet configuration
export interface WalletConfig {
  id: string;
  name: string;
  type: WalletType;
  enabled: boolean;
  priority: number;
  connection: {
    rpcUrl?: string;
    rpcUser?: string;
    rpcPassword?: string;
    apiKey?: string;
    endpoint?: string;
    ssl: boolean;
    timeout: number;
  };
  security: {
    encryptedPrivateKey?: string;
    publicKey: string;
    requiresConfirmation: boolean;
    maxDailyAmount: number;
    allowedAddresses?: string[];
    requiresManualApproval: boolean;
  };
  fees: {
    type: 'fixed' | 'dynamic' | 'priority';
    fixedRate?: number; // satoshis per byte
    priorityMultiplier?: number;
    maxFeeRate: number;
    rbfEnabled: boolean; // Replace-by-fee
  };
  limits: {
    minAmount: number;
    maxAmount: number;
    maxTransactionsPerHour: number;
    maxTransactionsPerDay: number;
  };
  features: {
    batchPayments: boolean;
    instantPayments: boolean;
    multipleOutputs: boolean;
    customScripts: boolean;
    segregatedWitness: boolean;
    lightningNetwork: boolean;
  };
}

// Transaction input/output
export interface TransactionInput {
  txid: string;
  vout: number;
  scriptSig: string;
  sequence: number;
  amount: number;
}

export interface TransactionOutput {
  address: string;
  amount: number;
  scriptPubKey: string;
}

// Payment request
export interface PaymentRequest {
  id: string;
  recipientAddress: string;
  amount: number; // in satoshis
  description?: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  scheduledAt?: Date;
  expiresAt?: Date;
  metadata?: { [key: string]: any };
  requesterUserId?: string;
  approvedBy?: string;
  createdAt: Date;
}

// Transaction details
export interface Transaction {
  id: string;
  txid?: string;
  paymentRequestId: string;
  walletId: string;
  status: TransactionStatus;
  inputs: TransactionInput[];
  outputs: TransactionOutput[];
  fee: number;
  feeRate: number; // satoshis per byte
  size: number;
  virtualSize: number;
  confirmations: number;
  blockHeight?: number;
  blockHash?: string;
  broadcastAt?: Date;
  confirmedAt?: Date;
  replacedBy?: string;
  createdAt: Date;
}

// Fee estimation
export interface FeeEstimation {
  slow: number;    // satoshis per byte
  medium: number;
  fast: number;
  urgent: number;
  mempool: {
    size: number;
    usage: number;
  };
  recommendedConfirmationTargets: {
    slow: number;    // blocks
    medium: number;
    fast: number;
    urgent: number;
  };
}

/**
 * Abstract base wallet connector
 */
export abstract class BaseWalletConnector {
  protected memoryManager = getMemoryAlignmentManager();
  protected cacheManager = getCacheManager();

  constructor(
    public readonly config: WalletConfig,
    protected logger: Logger
  ) {}

  // Abstract methods that must be implemented
  abstract connect(): Promise<boolean>;
  abstract disconnect(): Promise<void>;
  abstract getBalance(): Promise<{ confirmed: number; unconfirmed: number }>;
  abstract createTransaction(request: PaymentRequest): Promise<Transaction>;
  abstract broadcastTransaction(transaction: Transaction): Promise<string>;
  abstract getTransactionStatus(txid: string): Promise<TransactionStatus>;
  abstract estimateFees(): Promise<FeeEstimation>;
  abstract validateAddress(address: string): Promise<boolean>;

  // Common implementations
  async isConnected(): Promise<boolean> {
    try {
      await this.getBalance();
      return true;
    } catch (error) {
      return false;
    }
  }

  protected generateTransactionId(): string {
    return `tx-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  }

  protected calculateFee(
    virtualSize: number,
    feeRate: number
  ): number {
    return Math.ceil(virtualSize * feeRate);
  }

  protected validatePaymentRequest(request: PaymentRequest): void {
    if (request.amount < this.config.limits.minAmount) {
      throw new Error(`Amount below minimum: ${this.config.limits.minAmount}`);
    }
    if (request.amount > this.config.limits.maxAmount) {
      throw new Error(`Amount above maximum: ${this.config.limits.maxAmount}`);
    }
    if (request.expiresAt && request.expiresAt < new Date()) {
      throw new Error('Payment request has expired');
    }
  }
}

/**
 * Bitcoin Core wallet connector
 */
export class BitcoinCoreConnector extends BaseWalletConnector {
  private rpcClient: any = null;

  async connect(): Promise<boolean> {
    try {
      // Initialize RPC client
      this.rpcClient = {
        call: async (method: string, params: any[] = []) => {
          // Mock RPC implementation
          return this.mockRpcCall(method, params);
        }
      };

      // Test connection
      await this.rpcClient.call('getblockchaininfo');
      
      this.logger.info('Bitcoin Core wallet connected', {
        walletId: this.config.id,
        endpoint: this.config.connection.rpcUrl
      });

      return true;
    } catch (error) {
      this.logger.error('Failed to connect to Bitcoin Core', error as Error);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.rpcClient = null;
    this.logger.info('Bitcoin Core wallet disconnected', {
      walletId: this.config.id
    });
  }

  async getBalance(): Promise<{ confirmed: number; unconfirmed: number }> {
    if (!this.rpcClient) {
      throw new Error('Wallet not connected');
    }

    const confirmed = await this.rpcClient.call('getbalance');
    const unconfirmed = await this.rpcClient.call('getunconfirmedbalance');

    return {
      confirmed: Math.floor(confirmed * 1e8), // Convert to satoshis
      unconfirmed: Math.floor(unconfirmed * 1e8)
    };
  }

  async createTransaction(request: PaymentRequest): Promise<Transaction> {
    this.validatePaymentRequest(request);

    if (!this.rpcClient) {
      throw new Error('Wallet not connected');
    }

    try {
      // Create raw transaction
      const outputs = [{ [request.recipientAddress]: request.amount / 1e8 }];
      const rawTx = await this.rpcClient.call('createrawtransaction', [[], outputs]);

      // Fund the transaction
      const fundedTx = await this.rpcClient.call('fundrawtransaction', [rawTx, {
        feeRate: this.config.fees.fixedRate ? this.config.fees.fixedRate / 1e8 : undefined,
        includeWatching: false,
        lockUnspents: true,
        reserveChangeKey: true
      }]);

      // Sign the transaction
      const signedTx = await this.rpcClient.call('signrawtransactionwithwallet', [fundedTx.hex]);

      if (!signedTx.complete) {
        throw new Error('Failed to sign transaction: ' + JSON.stringify(signedTx.errors));
      }

      // Decode transaction for details
      const decodedTx = await this.rpcClient.call('decoderawtransaction', [signedTx.hex]);

      const transaction: Transaction = {
        id: this.generateTransactionId(),
        paymentRequestId: request.id,
        walletId: this.config.id,
        status: TransactionStatus.PENDING,
        inputs: decodedTx.vin.map((input: any) => ({
          txid: input.txid,
          vout: input.vout,
          scriptSig: input.scriptSig?.hex || '',
          sequence: input.sequence,
          amount: 0 // Would need to fetch from previous transaction
        })),
        outputs: decodedTx.vout.map((output: any) => ({
          address: this.extractAddressFromScript(output.scriptPubKey),
          amount: Math.floor(output.value * 1e8),
          scriptPubKey: output.scriptPubKey.hex
        })),
        fee: Math.floor(fundedTx.fee * 1e8),
        feeRate: Math.floor(fundedTx.fee * 1e8) / decodedTx.vsize,
        size: decodedTx.size,
        virtualSize: decodedTx.vsize,
        confirmations: 0,
        createdAt: new Date()
      };

      // Store raw transaction hex for broadcasting
      (transaction as any).rawHex = signedTx.hex;

      this.logger.info('Transaction created', {
        transactionId: transaction.id,
        amount: request.amount,
        fee: transaction.fee,
        recipient: request.recipientAddress
      });

      return transaction;
    } catch (error) {
      this.logger.error('Failed to create transaction', error as Error);
      throw error;
    }
  }

  async broadcastTransaction(transaction: Transaction): Promise<string> {
    if (!this.rpcClient) {
      throw new Error('Wallet not connected');
    }

    try {
      const rawHex = (transaction as any).rawHex;
      if (!rawHex) {
        throw new Error('Raw transaction hex not found');
      }

      const txid = await this.rpcClient.call('sendrawtransaction', [rawHex]);
      
      this.logger.info('Transaction broadcasted', {
        transactionId: transaction.id,
        txid,
        amount: transaction.outputs.reduce((sum, output) => sum + output.amount, 0)
      });

      return txid;
    } catch (error) {
      this.logger.error('Failed to broadcast transaction', error as Error);
      throw error;
    }
  }

  async getTransactionStatus(txid: string): Promise<TransactionStatus> {
    if (!this.rpcClient) {
      throw new Error('Wallet not connected');
    }

    try {
      const tx = await this.rpcClient.call('gettransaction', [txid]);
      
      if (tx.confirmations === 0) {
        return TransactionStatus.PENDING;
      } else if (tx.confirmations > 0) {
        return TransactionStatus.CONFIRMED;
      } else {
        return TransactionStatus.FAILED;
      }
    } catch (error) {
      // Transaction not found in wallet
      return TransactionStatus.FAILED;
    }
  }

  async estimateFees(): Promise<FeeEstimation> {
    if (!this.rpcClient) {
      throw new Error('Wallet not connected');
    }

    try {
      const [slow, medium, fast, urgent, mempoolInfo] = await Promise.all([
        this.rpcClient.call('estimatesmartfee', [144]), // ~24 hours
        this.rpcClient.call('estimatesmartfee', [6]),   // ~1 hour
        this.rpcClient.call('estimatesmartfee', [3]),   // ~30 minutes
        this.rpcClient.call('estimatesmartfee', [1]),   // ~10 minutes
        this.rpcClient.call('getmempoolinfo')
      ]);

      return {
        slow: Math.floor((slow.feerate || 0.00001) * 1e8 / 1000),    // Convert to sat/byte
        medium: Math.floor((medium.feerate || 0.00005) * 1e8 / 1000),
        fast: Math.floor((fast.feerate || 0.0001) * 1e8 / 1000),
        urgent: Math.floor((urgent.feerate || 0.0002) * 1e8 / 1000),
        mempool: {
          size: mempoolInfo.size,
          usage: mempoolInfo.usage
        },
        recommendedConfirmationTargets: {
          slow: 144,
          medium: 6,
          fast: 3,
          urgent: 1
        }
      };
    } catch (error) {
      this.logger.error('Failed to estimate fees', error as Error);
      
      // Return fallback values
      return {
        slow: 1,
        medium: 5,
        fast: 10,
        urgent: 20,
        mempool: { size: 0, usage: 0 },
        recommendedConfirmationTargets: { slow: 144, medium: 6, fast: 3, urgent: 1 }
      };
    }
  }

  async validateAddress(address: string): Promise<boolean> {
    if (!this.rpcClient) {
      throw new Error('Wallet not connected');
    }

    try {
      const result = await this.rpcClient.call('validateaddress', [address]);
      return result.isvalid;
    } catch (error) {
      return false;
    }
  }

  private extractAddressFromScript(scriptPubKey: any): string {
    // Extract address from script public key
    if (scriptPubKey.addresses && scriptPubKey.addresses.length > 0) {
      return scriptPubKey.addresses[0];
    }
    if (scriptPubKey.address) {
      return scriptPubKey.address;
    }
    return 'unknown';
  }

  private async mockRpcCall(method: string, params: any[]): Promise<any> {
    // Mock RPC responses for testing
    switch (method) {
      case 'getblockchaininfo':
        return { chain: 'main', blocks: 750000 };
      case 'getbalance':
        return 1.5; // 1.5 BTC
      case 'getunconfirmedbalance':
        return 0.1; // 0.1 BTC
      case 'createrawtransaction':
        return '020000000000000000';
      case 'fundrawtransaction':
        return {
          hex: '0200000001abcd....',
          fee: 0.0001,
          changepos: 1
        };
      case 'signrawtransactionwithwallet':
        return {
          hex: '0200000001abcd....',
          complete: true
        };
      case 'decoderawtransaction':
        return {
          txid: crypto.randomBytes(32).toString('hex'),
          size: 250,
          vsize: 150,
          vin: [{
            txid: crypto.randomBytes(32).toString('hex'),
            vout: 0,
            scriptSig: { hex: '' },
            sequence: 0xffffffff
          }],
          vout: [{
            value: params[1]?.[0] ? Object.values(params[1][0])[0] : 0.001,
            scriptPubKey: {
              hex: 'abcd1234',
              addresses: [Object.keys(params[1]?.[0] || {})[0] || 'bc1qtest']
            }
          }]
        };
      case 'sendrawtransaction':
        return crypto.randomBytes(32).toString('hex');
      case 'gettransaction':
        return { confirmations: 1 };
      case 'estimatesmartfee':
        const targetBlocks = params[0];
        const baseFee = 0.00001;
        return { feerate: baseFee * (144 / targetBlocks) };
      case 'getmempoolinfo':
        return { size: 50000, usage: 300000000 };
      case 'validateaddress':
        return { isvalid: true };
      default:
        throw new Error(`Unknown RPC method: ${method}`);
    }
  }
}

/**
 * Lightning Network wallet connector
 */
export class LightningConnector extends BaseWalletConnector {
  private lndClient: any = null;

  async connect(): Promise<boolean> {
    try {
      // Mock LND connection
      this.lndClient = {
        getInfo: async () => ({ version: '0.15.0', synced_to_chain: true }),
        walletBalance: async () => ({ confirmed_balance: '100000000' }),
        channelBalance: async () => ({ balance: '50000000' }),
        addInvoice: async (params: any) => ({
          payment_request: 'lnbc1...' + crypto.randomBytes(16).toString('hex')
        }),
        sendPayment: async (params: any) => ({
          payment_hash: crypto.randomBytes(32).toString('hex'),
          payment_preimage: crypto.randomBytes(32).toString('hex')
        })
      };

      const info = await this.lndClient.getInfo();
      
      this.logger.info('Lightning Network wallet connected', {
        walletId: this.config.id,
        version: info.version,
        synced: info.synced_to_chain
      });

      return true;
    } catch (error) {
      this.logger.error('Failed to connect to Lightning Network', error as Error);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.lndClient = null;
    this.logger.info('Lightning Network wallet disconnected');
  }

  async getBalance(): Promise<{ confirmed: number; unconfirmed: number }> {
    if (!this.lndClient) {
      throw new Error('Lightning wallet not connected');
    }

    const [walletBalance, channelBalance] = await Promise.all([
      this.lndClient.walletBalance(),
      this.lndClient.channelBalance()
    ]);

    return {
      confirmed: parseInt(walletBalance.confirmed_balance),
      unconfirmed: parseInt(channelBalance.balance) // Channel balance as unconfirmed
    };
  }

  async createTransaction(request: PaymentRequest): Promise<Transaction> {
    this.validatePaymentRequest(request);

    if (!this.lndClient) {
      throw new Error('Lightning wallet not connected');
    }

    // For Lightning, we create an invoice instead of a transaction
    const invoice = await this.lndClient.addInvoice({
      value: Math.floor(request.amount / 1000), // Convert satoshis to milli-satoshis
      memo: request.description || 'Mining pool payout',
      expiry: 3600 // 1 hour
    });

    const transaction: Transaction = {
      id: this.generateTransactionId(),
      paymentRequestId: request.id,
      walletId: this.config.id,
      status: TransactionStatus.PENDING,
      inputs: [],
      outputs: [{
        address: request.recipientAddress,
        amount: request.amount,
        scriptPubKey: invoice.payment_request
      }],
      fee: 0, // Lightning fees are typically very low
      feeRate: 0,
      size: 0,
      virtualSize: 0,
      confirmations: 0,
      createdAt: new Date()
    };

    (transaction as any).paymentRequest = invoice.payment_request;

    this.logger.info('Lightning invoice created', {
      transactionId: transaction.id,
      amount: request.amount,
      paymentRequest: invoice.payment_request.substring(0, 20) + '...'
    });

    return transaction;
  }

  async broadcastTransaction(transaction: Transaction): Promise<string> {
    if (!this.lndClient) {
      throw new Error('Lightning wallet not connected');
    }

    const paymentRequest = (transaction as any).paymentRequest;
    if (!paymentRequest) {
      throw new Error('Payment request not found');
    }

    const payment = await this.lndClient.sendPayment({
      payment_request: paymentRequest
    });

    this.logger.info('Lightning payment sent', {
      transactionId: transaction.id,
      paymentHash: payment.payment_hash
    });

    return payment.payment_hash;
  }

  async getTransactionStatus(txid: string): Promise<TransactionStatus> {
    // Lightning payments are typically instant
    return TransactionStatus.CONFIRMED;
  }

  async estimateFees(): Promise<FeeEstimation> {
    // Lightning fees are typically very low and fixed
    return {
      slow: 0,
      medium: 1,
      fast: 1,
      urgent: 2,
      mempool: { size: 0, usage: 0 },
      recommendedConfirmationTargets: { slow: 1, medium: 1, fast: 1, urgent: 1 }
    };
  }

  async validateAddress(address: string): Promise<boolean> {
    // Lightning addresses are payment requests or node pubkeys
    return address.startsWith('lnbc') || address.length === 66;
  }
}

/**
 * Multi-signature wallet connector
 */
export class MultisigConnector extends BaseWalletConnector {
  private requiredSignatures: number;
  private totalSigners: number;
  private pendingTransactions = new Map<string, { transaction: Transaction; signatures: string[] }>();

  constructor(
    config: WalletConfig,
    logger: Logger,
    requiredSignatures: number = 2,
    totalSigners: number = 3
  ) {
    super(config, logger);
    this.requiredSignatures = requiredSignatures;
    this.totalSigners = totalSigners;
  }

  async connect(): Promise<boolean> {
    this.logger.info('Multisig wallet connected', {
      walletId: this.config.id,
      requiredSignatures: this.requiredSignatures,
      totalSigners: this.totalSigners
    });
    return true;
  }

  async disconnect(): Promise<void> {
    this.logger.info('Multisig wallet disconnected');
  }

  async getBalance(): Promise<{ confirmed: number; unconfirmed: number }> {
    // Mock multisig balance
    return {
      confirmed: 500000000, // 5 BTC
      unconfirmed: 0
    };
  }

  async createTransaction(request: PaymentRequest): Promise<Transaction> {
    this.validatePaymentRequest(request);

    const transaction: Transaction = {
      id: this.generateTransactionId(),
      paymentRequestId: request.id,
      walletId: this.config.id,
      status: TransactionStatus.PENDING,
      inputs: [],
      outputs: [{
        address: request.recipientAddress,
        amount: request.amount,
        scriptPubKey: ''
      }],
      fee: 10000, // 0.0001 BTC
      feeRate: 10,
      size: 250,
      virtualSize: 150,
      confirmations: 0,
      createdAt: new Date()
    };

    // Add to pending transactions for signature collection
    this.pendingTransactions.set(transaction.id, {
      transaction,
      signatures: []
    });

    this.logger.info('Multisig transaction created (pending signatures)', {
      transactionId: transaction.id,
      requiredSignatures: this.requiredSignatures
    });

    return transaction;
  }

  async addSignature(transactionId: string, signature: string, signerId: string): Promise<boolean> {
    const pending = this.pendingTransactions.get(transactionId);
    if (!pending) {
      throw new Error('Transaction not found');
    }

    if (!pending.signatures.includes(signature)) {
      pending.signatures.push(signature);
      
      this.logger.info('Signature added to multisig transaction', {
        transactionId,
        signerId,
        signaturesCollected: pending.signatures.length,
        signaturesRequired: this.requiredSignatures
      });
    }

    return pending.signatures.length >= this.requiredSignatures;
  }

  async broadcastTransaction(transaction: Transaction): Promise<string> {
    const pending = this.pendingTransactions.get(transaction.id);
    if (!pending) {
      throw new Error('Transaction not found');
    }

    if (pending.signatures.length < this.requiredSignatures) {
      throw new Error(`Insufficient signatures: ${pending.signatures.length}/${this.requiredSignatures}`);
    }

    // Mock broadcast
    const txid = crypto.randomBytes(32).toString('hex');
    
    this.pendingTransactions.delete(transaction.id);
    
    this.logger.info('Multisig transaction broadcasted', {
      transactionId: transaction.id,
      txid,
      signatures: pending.signatures.length
    });

    return txid;
  }

  async getTransactionStatus(txid: string): Promise<TransactionStatus> {
    // Mock status check
    return TransactionStatus.CONFIRMED;
  }

  async estimateFees(): Promise<FeeEstimation> {
    // Multisig transactions are larger, so higher fees
    return {
      slow: 5,
      medium: 15,
      fast: 25,
      urgent: 40,
      mempool: { size: 50000, usage: 300000000 },
      recommendedConfirmationTargets: { slow: 144, medium: 6, fast: 3, urgent: 1 }
    };
  }

  async validateAddress(address: string): Promise<boolean> {
    // Mock address validation
    return address.length >= 26 && address.length <= 62;
  }

  getPendingTransactions(): Array<{ transactionId: string; signaturesRequired: number; signaturesCollected: number }> {
    return Array.from(this.pendingTransactions.entries()).map(([id, pending]) => ({
      transactionId: id,
      signaturesRequired: this.requiredSignatures,
      signaturesCollected: pending.signatures.length
    }));
  }
}

/**
 * Main wallet integration manager
 */
export class WalletIntegrationManager extends EventEmitter {
  private wallets = new Map<string, BaseWalletConnector>();
  private paymentRequests = new Map<string, PaymentRequest>();
  private transactions = new Map<string, Transaction>();
  private memoryManager = getMemoryAlignmentManager();
  private processingQueue: PaymentRequest[] = [];
  private processingInterval: NodeJS.Timeout | null = null;

  constructor(
    private config: {
      defaultWallet: string;
      processingIntervalMs: number;
      maxRetries: number;
      retryDelayMs: number;
      enableAutomaticPayments: boolean;
      dailyLimits: { [walletId: string]: number };
    } = {
      defaultWallet: 'main',
      processingIntervalMs: 30000, // 30 seconds
      maxRetries: 3,
      retryDelayMs: 60000, // 1 minute
      enableAutomaticPayments: true,
      dailyLimits: {}
    }
  ) {
    super();
    this.startProcessingQueue();
  }

  /**
   * Register a wallet
   */
  async registerWallet(config: WalletConfig): Promise<void> {
    let connector: BaseWalletConnector;

    switch (config.type) {
      case WalletType.BITCOIN_CORE:
        connector = new BitcoinCoreConnector(config, logger);
        break;
      case WalletType.LIGHTNING:
        connector = new LightningConnector(config, logger);
        break;
      case WalletType.MULTISIG:
        connector = new MultisigConnector(config, logger);
        break;
      default:
        throw new Error(`Unsupported wallet type: ${config.type}`);
    }

    // Connect to wallet
    const connected = await connector.connect();
    if (!connected) {
      throw new Error(`Failed to connect to wallet: ${config.id}`);
    }

    this.wallets.set(config.id, connector);
    
    this.emit('walletRegistered', config.id, config.type);
    
    logger.info('Wallet registered', {
      walletId: config.id,
      type: config.type,
      enabled: config.enabled
    });
  }

  /**
   * Create payment request
   */
  async createPaymentRequest(
    recipientAddress: string,
    amount: number,
    options: Partial<PaymentRequest> = {}
  ): Promise<PaymentRequest> {
    const request: PaymentRequest = {
      id: crypto.randomUUID(),
      recipientAddress,
      amount,
      priority: options.priority || 'medium',
      description: options.description,
      scheduledAt: options.scheduledAt,
      expiresAt: options.expiresAt,
      metadata: options.metadata,
      requesterUserId: options.requesterUserId,
      createdAt: new Date()
    };

    this.paymentRequests.set(request.id, request);
    
    // Add to processing queue if automatic payments are enabled
    if (this.config.enableAutomaticPayments) {
      this.processingQueue.push(request);
    }

    this.emit('paymentRequestCreated', request);
    
    logger.info('Payment request created', {
      requestId: request.id,
      amount: request.amount,
      recipient: request.recipientAddress,
      priority: request.priority
    });

    return request;
  }

  /**
   * Process payment request
   */
  async processPayment(requestId: string, walletId?: string): Promise<Transaction> {
    const request = this.paymentRequests.get(requestId);
    if (!request) {
      throw new Error('Payment request not found');
    }

    const selectedWalletId = walletId || this.selectOptimalWallet(request);
    const wallet = this.wallets.get(selectedWalletId);
    if (!wallet) {
      throw new Error('Wallet not found');
    }

    try {
      // Check daily limits
      await this.checkDailyLimits(selectedWalletId, request.amount);

      // Validate recipient address
      const validAddress = await wallet.validateAddress(request.recipientAddress);
      if (!validAddress) {
        throw new Error('Invalid recipient address');
      }

      // Create transaction
      const transaction = await wallet.createTransaction(request);
      this.transactions.set(transaction.id, transaction);

      // Broadcast if wallet supports automatic broadcasting
      if (wallet.config.security.requiresManualApproval) {
        logger.info('Transaction requires manual approval', {
          transactionId: transaction.id,
          walletId: selectedWalletId
        });
      } else {
        const txid = await wallet.broadcastTransaction(transaction);
        transaction.txid = txid;
        transaction.broadcastAt = new Date();
        
        this.emit('transactionBroadcast', transaction);
      }

      this.emit('paymentProcessed', request, transaction);
      
      logger.info('Payment processed', {
        requestId: request.id,
        transactionId: transaction.id,
        walletId: selectedWalletId,
        amount: request.amount
      });

      return transaction;
    } catch (error) {
      logger.error('Failed to process payment', error as Error, {
        requestId: request.id,
        walletId: selectedWalletId
      });
      
      this.emit('paymentFailed', request, error);
      throw error;
    }
  }

  /**
   * Get wallet balance
   */
  async getWalletBalance(walletId: string): Promise<{ confirmed: number; unconfirmed: number }> {
    const wallet = this.wallets.get(walletId);
    if (!wallet) {
      throw new Error('Wallet not found');
    }

    return await wallet.getBalance();
  }

  /**
   * Get all wallet balances
   */
  async getAllBalances(): Promise<{ [walletId: string]: { confirmed: number; unconfirmed: number } }> {
    const balances: { [walletId: string]: { confirmed: number; unconfirmed: number } } = {};
    
    for (const [walletId, wallet] of this.wallets) {
      try {
        balances[walletId] = await wallet.getBalance();
      } catch (error) {
        logger.warn('Failed to get wallet balance', { walletId, error: (error as Error).message });
        balances[walletId] = { confirmed: 0, unconfirmed: 0 };
      }
    }
    
    return balances;
  }

  /**
   * Estimate fees for payment
   */
  async estimatePaymentFee(
    amount: number,
    recipientAddress: string,
    priority: 'low' | 'medium' | 'high' | 'urgent' = 'medium',
    walletId?: string
  ): Promise<{ fee: number; walletId: string; estimatedConfirmationTime: number }> {
    const selectedWalletId = walletId || this.config.defaultWallet;
    const wallet = this.wallets.get(selectedWalletId);
    if (!wallet) {
      throw new Error('Wallet not found');
    }

    const feeEstimation = await wallet.estimateFees();
    let feeRate: number;
    let confirmationTarget: number;

    switch (priority) {
      case 'low':
        feeRate = feeEstimation.slow;
        confirmationTarget = feeEstimation.recommendedConfirmationTargets.slow;
        break;
      case 'medium':
        feeRate = feeEstimation.medium;
        confirmationTarget = feeEstimation.recommendedConfirmationTargets.medium;
        break;
      case 'high':
        feeRate = feeEstimation.fast;
        confirmationTarget = feeEstimation.recommendedConfirmationTargets.fast;
        break;
      case 'urgent':
        feeRate = feeEstimation.urgent;
        confirmationTarget = feeEstimation.recommendedConfirmationTargets.urgent;
        break;
    }

    // Estimate transaction size (simplified)
    const estimatedSize = 250; // bytes
    const fee = Math.ceil(estimatedSize * feeRate);

    return {
      fee,
      walletId: selectedWalletId,
      estimatedConfirmationTime: confirmationTarget * 10 // Assume 10 minutes per block
    };
  }

  /**
   * Get transaction status
   */
  async getTransactionStatus(transactionId: string): Promise<Transaction | null> {
    const transaction = this.transactions.get(transactionId);
    if (!transaction || !transaction.txid) {
      return transaction || null;
    }

    const wallet = this.wallets.get(transaction.walletId);
    if (!wallet) {
      return transaction;
    }

    try {
      const status = await wallet.getTransactionStatus(transaction.txid);
      transaction.status = status;
      
      if (status === TransactionStatus.CONFIRMED && !transaction.confirmedAt) {
        transaction.confirmedAt = new Date();
        this.emit('transactionConfirmed', transaction);
      }
    } catch (error) {
      logger.warn('Failed to get transaction status', {
        transactionId,
        txid: transaction.txid,
        error: (error as Error).message
      });
    }

    return transaction;
  }

  /**
   * Select optimal wallet for payment
   */
  private selectOptimalWallet(request: PaymentRequest): string {
    // Simple selection logic - in production would consider:
    // - Wallet balance
    // - Fee rates
    // - Transaction limits
    // - Wallet capabilities
    
    for (const [walletId, wallet] of this.wallets) {
      if (wallet.config.enabled && request.amount >= wallet.config.limits.minAmount && request.amount <= wallet.config.limits.maxAmount) {
        return walletId;
      }
    }
    
    return this.config.defaultWallet;
  }

  /**
   * Check daily limits
   */
  private async checkDailyLimits(walletId: string, amount: number): Promise<void> {
    const limit = this.config.dailyLimits[walletId];
    if (!limit) return;

    // Get today's transactions for this wallet
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayTransactions = Array.from(this.transactions.values())
      .filter(tx => 
        tx.walletId === walletId && 
        tx.createdAt >= today &&
        tx.status !== TransactionStatus.FAILED
      );
    
    const totalToday = todayTransactions.reduce((sum, tx) => 
      sum + tx.outputs.reduce((outSum, output) => outSum + output.amount, 0), 0
    );
    
    if (totalToday + amount > limit) {
      throw new Error(`Daily limit exceeded for wallet ${walletId}: ${(totalToday + amount) / 1e8} BTC > ${limit / 1e8} BTC`);
    }
  }

  /**
   * Start processing queue
   */
  private startProcessingQueue(): void {
    this.processingInterval = setInterval(async () => {
      if (this.processingQueue.length === 0) return;

      const request = this.processingQueue.shift();
      if (!request) return;

      try {
        await this.processPayment(request.id);
      } catch (error) {
        logger.error('Failed to process queued payment', error as Error, {
          requestId: request.id
        });
        
        // Retry logic would go here
      }
    }, this.config.processingIntervalMs);
  }

  /**
   * Get comprehensive statistics
   */
  getStatistics(): {
    wallets: { [walletId: string]: any };
    payments: {
      total: number;
      pending: number;
      completed: number;
      failed: number;
    };
    transactions: {
      total: number;
      pending: number;
      confirmed: number;
      failed: number;
    };
  } {
    const paymentStats = { total: 0, pending: 0, completed: 0, failed: 0 };
    const transactionStats = { total: 0, pending: 0, confirmed: 0, failed: 0 };
    
    // Count payment requests
    for (const request of this.paymentRequests.values()) {
      paymentStats.total++;
      // Payment status logic would go here
    }
    
    // Count transactions
    for (const transaction of this.transactions.values()) {
      transactionStats.total++;
      switch (transaction.status) {
        case TransactionStatus.PENDING:
          transactionStats.pending++;
          break;
        case TransactionStatus.CONFIRMED:
          transactionStats.confirmed++;
          break;
        case TransactionStatus.FAILED:
          transactionStats.failed++;
          break;
      }
    }

    const walletStats: { [walletId: string]: any } = {};
    for (const [walletId, wallet] of this.wallets) {
      walletStats[walletId] = {
        type: wallet.config.type,
        enabled: wallet.config.enabled,
        connected: true // Would check actual connection status
      };
    }

    return {
      wallets: walletStats,
      payments: paymentStats,
      transactions: transactionStats
    };
  }

  /**
   * Stop the wallet manager
   */
  async stop(): Promise<void> {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
    }

    // Disconnect all wallets
    for (const [walletId, wallet] of this.wallets) {
      try {
        await wallet.disconnect();
        logger.info('Wallet disconnected', { walletId });
      } catch (error) {
        logger.warn('Error disconnecting wallet', { walletId, error: (error as Error).message });
      }
    }

    this.wallets.clear();
    logger.info('Wallet integration manager stopped');
  }
}

export {
  WalletType,
  TransactionStatus,
  WalletConfig,
  PaymentRequest,
  Transaction,
  FeeEstimation,
  BaseWalletConnector,
  BitcoinCoreConnector,
  LightningConnector,
  MultisigConnector
};
