/**
 * Multi-Chain Bridge System
 * Cross-chain asset transfer and liquidity sharing
 * 
 * Features:
 * - Multi-chain asset bridging
 * - Atomic cross-chain swaps
 * - Liquidity aggregation
 * - Wrapped token management
 * - Cross-chain messaging
 * - Validator network
 * - Fraud proofs
 * - Emergency pause mechanism
 */

const { EventEmitter } = require('events');
const { ethers } = require('ethers');
const Web3 = require('web3');
const crypto = require('crypto');
const { MerkleTree } = require('merkletreejs');
const { createLogger } = require('../core/logger');

const logger = createLogger('multi-chain-bridge');

// Supported chains
const SupportedChains = {
  ETHEREUM: {
    id: 1,
    name: 'Ethereum',
    symbol: 'ETH',
    rpc: 'https://mainnet.infura.io/v3/',
    confirmations: 12,
    blockTime: 15
  },
  BSC: {
    id: 56,
    name: 'BSC',
    symbol: 'BNB',
    rpc: 'https://bsc-dataseed.binance.org/',
    confirmations: 15,
    blockTime: 3
  },
  POLYGON: {
    id: 137,
    name: 'Polygon',
    symbol: 'MATIC',
    rpc: 'https://polygon-rpc.com/',
    confirmations: 128,
    blockTime: 2
  },
  AVALANCHE: {
    id: 43114,
    name: 'Avalanche',
    symbol: 'AVAX',
    rpc: 'https://api.avax.network/ext/bc/C/rpc',
    confirmations: 1,
    blockTime: 2
  },
  ARBITRUM: {
    id: 42161,
    name: 'Arbitrum',
    symbol: 'ETH',
    rpc: 'https://arb1.arbitrum.io/rpc',
    confirmations: 1,
    blockTime: 1
  },
  OPTIMISM: {
    id: 10,
    name: 'Optimism',
    symbol: 'ETH',
    rpc: 'https://mainnet.optimism.io',
    confirmations: 1,
    blockTime: 2
  }
};

// Bridge operation types
const BridgeOperation = {
  LOCK: 'lock',
  UNLOCK: 'unlock',
  MINT: 'mint',
  BURN: 'burn',
  TRANSFER: 'transfer'
};

// Transfer states
const TransferState = {
  INITIATED: 'initiated',
  LOCKED: 'locked',
  VALIDATING: 'validating',
  MINTING: 'minting',
  COMPLETED: 'completed',
  FAILED: 'failed',
  REFUNDED: 'refunded'
};

class ChainConnector {
  constructor(chain, config) {
    this.chain = chain;
    this.chainId = chain.id;
    this.web3 = new Web3(chain.rpc + (config.infuraKey || ''));
    this.provider = new ethers.providers.JsonRpcProvider(
      chain.rpc + (config.infuraKey || '')
    );
    this.contracts = new Map();
    this.listeners = new Map();
  }

  async loadContract(address, abi, name) {
    const contract = new ethers.Contract(address, abi, this.provider);
    this.contracts.set(name, contract);
    return contract;
  }

  async getBlockNumber() {
    return await this.provider.getBlockNumber();
  }

  async getBlock(blockNumber) {
    return await this.provider.getBlock(blockNumber);
  }

  async getTransaction(txHash) {
    return await this.provider.getTransaction(txHash);
  }

  async getTransactionReceipt(txHash) {
    return await this.provider.getTransactionReceipt(txHash);
  }

  async waitForTransaction(txHash, confirmations) {
    return await this.provider.waitForTransaction(
      txHash,
      confirmations || this.chain.confirmations
    );
  }

  subscribeToEvents(contractName, eventName, callback) {
    const contract = this.contracts.get(contractName);
    if (!contract) {
      throw new Error(`Contract ${contractName} not loaded`);
    }

    const filter = contract.filters[eventName]();
    contract.on(filter, callback);

    const key = `${contractName}-${eventName}`;
    this.listeners.set(key, { contract, filter });
  }

  unsubscribeFromEvents(contractName, eventName) {
    const key = `${contractName}-${eventName}`;
    const listener = this.listeners.get(key);
    
    if (listener) {
      listener.contract.removeAllListeners(listener.filter);
      this.listeners.delete(key);
    }
  }

  async estimateGas(transaction) {
    return await this.provider.estimateGas(transaction);
  }

  async getGasPrice() {
    return await this.provider.getGasPrice();
  }
}

class TokenRegistry {
  constructor() {
    this.tokens = new Map();
    this.wrappedTokens = new Map();
    this.tokenPairs = new Map();
  }

  registerToken(chainId, address, config) {
    const key = `${chainId}-${address.toLowerCase()}`;
    
    this.tokens.set(key, {
      chainId,
      address: address.toLowerCase(),
      name: config.name,
      symbol: config.symbol,
      decimals: config.decimals,
      isNative: config.isNative || false,
      maxSupply: config.maxSupply,
      mintable: config.mintable || false,
      burnable: config.burnable || false
    });
  }

  registerWrappedToken(originalChainId, originalAddress, wrappedChainId, wrappedAddress) {
    const originalKey = `${originalChainId}-${originalAddress.toLowerCase()}`;
    const wrappedKey = `${wrappedChainId}-${wrappedAddress.toLowerCase()}`;
    
    this.wrappedTokens.set(wrappedKey, originalKey);
    
    // Also store reverse mapping
    if (!this.tokenPairs.has(originalKey)) {
      this.tokenPairs.set(originalKey, new Map());
    }
    this.tokenPairs.get(originalKey).set(wrappedChainId, wrappedAddress);
  }

  getToken(chainId, address) {
    const key = `${chainId}-${address.toLowerCase()}`;
    return this.tokens.get(key);
  }

  getOriginalToken(wrappedChainId, wrappedAddress) {
    const wrappedKey = `${wrappedChainId}-${wrappedAddress.toLowerCase()}`;
    const originalKey = this.wrappedTokens.get(wrappedKey);
    
    if (!originalKey) return null;
    
    const [chainId, address] = originalKey.split('-');
    return this.tokens.get(originalKey);
  }

  getWrappedToken(originalChainId, originalAddress, targetChainId) {
    const originalKey = `${originalChainId}-${originalAddress.toLowerCase()}`;
    const pairs = this.tokenPairs.get(originalKey);
    
    if (!pairs) return null;
    
    const wrappedAddress = pairs.get(targetChainId);
    if (!wrappedAddress) return null;
    
    return this.getToken(targetChainId, wrappedAddress);
  }

  isWrappedToken(chainId, address) {
    const key = `${chainId}-${address.toLowerCase()}`;
    return this.wrappedTokens.has(key);
  }
}

class ValidatorNetwork {
  constructor(config) {
    this.validators = new Map();
    this.requiredSignatures = config.requiredSignatures || 3;
    this.validatorRewards = config.validatorRewards || '0.001'; // 0.1% fee
    this.slashingAmount = config.slashingAmount || '1000'; // 1000 tokens
  }

  registerValidator(address, config) {
    this.validators.set(address.toLowerCase(), {
      address: address.toLowerCase(),
      publicKey: config.publicKey,
      stake: config.stake || '0',
      active: config.active !== false,
      reputation: config.reputation || 100,
      totalValidations: 0,
      successfulValidations: 0,
      slashEvents: 0,
      joinedAt: Date.now()
    });
  }

  async validateTransfer(transfer, signatures) {
    const validSignatures = [];
    const messageHash = this.getTransferHash(transfer);
    
    for (const signature of signatures) {
      const recovered = ethers.utils.recoverAddress(messageHash, signature);
      const validator = this.validators.get(recovered.toLowerCase());
      
      if (validator && validator.active) {
        validSignatures.push({
          validator: recovered,
          signature
        });
      }
    }
    
    return {
      valid: validSignatures.length >= this.requiredSignatures,
      signatures: validSignatures,
      required: this.requiredSignatures
    };
  }

  getTransferHash(transfer) {
    const message = ethers.utils.solidityPack(
      ['uint256', 'address', 'address', 'uint256', 'uint256', 'uint256'],
      [
        transfer.sourceChain,
        transfer.sourceToken,
        transfer.recipient,
        transfer.amount,
        transfer.targetChain,
        transfer.nonce
      ]
    );
    
    return ethers.utils.keccak256(message);
  }

  selectValidators(count = null) {
    const activeValidators = Array.from(this.validators.values())
      .filter(v => v.active)
      .sort((a, b) => b.reputation - a.reputation);
    
    const selected = count
      ? activeValidators.slice(0, count)
      : activeValidators.slice(0, this.requiredSignatures * 2);
    
    return selected;
  }

  updateValidatorStats(address, success) {
    const validator = this.validators.get(address.toLowerCase());
    if (!validator) return;
    
    validator.totalValidations++;
    
    if (success) {
      validator.successfulValidations++;
      validator.reputation = Math.min(100, validator.reputation + 1);
    } else {
      validator.reputation = Math.max(0, validator.reputation - 5);
    }
  }

  slashValidator(address, reason) {
    const validator = this.validators.get(address.toLowerCase());
    if (!validator) return;
    
    validator.slashEvents++;
    validator.reputation = Math.max(0, validator.reputation - 20);
    validator.stake = Math.max(
      0,
      parseFloat(validator.stake) - parseFloat(this.slashingAmount)
    ).toString();
    
    if (validator.reputation < 20) {
      validator.active = false;
    }
    
    logger.warn(`Validator slashed: ${address}`, { reason });
  }
}

class LiquidityManager {
  constructor() {
    this.pools = new Map();
    this.reserves = new Map();
    this.fees = new Map();
  }

  createPool(chainId, tokenA, tokenB, config = {}) {
    const poolId = this.getPoolId(chainId, tokenA, tokenB);
    
    const pool = {
      id: poolId,
      chainId,
      tokenA: tokenA.toLowerCase(),
      tokenB: tokenB.toLowerCase(),
      reserveA: '0',
      reserveB: '0',
      totalSupply: '0',
      fee: config.fee || '0.003', // 0.3%
      created: Date.now()
    };
    
    this.pools.set(poolId, pool);
    return pool;
  }

  addLiquidity(poolId, amountA, amountB) {
    const pool = this.pools.get(poolId);
    if (!pool) throw new Error('Pool not found');
    
    const reserveA = ethers.BigNumber.from(pool.reserveA);
    const reserveB = ethers.BigNumber.from(pool.reserveB);
    const addA = ethers.BigNumber.from(amountA);
    const addB = ethers.BigNumber.from(amountB);
    
    let liquidity;
    const totalSupply = ethers.BigNumber.from(pool.totalSupply);
    
    if (totalSupply.eq(0)) {
      // Initial liquidity
      liquidity = addA.mul(addB).sqrt();
    } else {
      // Subsequent liquidity
      const liquidityA = addA.mul(totalSupply).div(reserveA);
      const liquidityB = addB.mul(totalSupply).div(reserveB);
      liquidity = liquidityA.lt(liquidityB) ? liquidityA : liquidityB;
    }
    
    pool.reserveA = reserveA.add(addA).toString();
    pool.reserveB = reserveB.add(addB).toString();
    pool.totalSupply = totalSupply.add(liquidity).toString();
    
    return {
      liquidity: liquidity.toString(),
      shareOfPool: liquidity.mul(10000).div(totalSupply.add(liquidity)).toString()
    };
  }

  removeLiquidity(poolId, liquidity) {
    const pool = this.pools.get(poolId);
    if (!pool) throw new Error('Pool not found');
    
    const totalSupply = ethers.BigNumber.from(pool.totalSupply);
    const liquidityBN = ethers.BigNumber.from(liquidity);
    const reserveA = ethers.BigNumber.from(pool.reserveA);
    const reserveB = ethers.BigNumber.from(pool.reserveB);
    
    const amountA = liquidityBN.mul(reserveA).div(totalSupply);
    const amountB = liquidityBN.mul(reserveB).div(totalSupply);
    
    pool.reserveA = reserveA.sub(amountA).toString();
    pool.reserveB = reserveB.sub(amountB).toString();
    pool.totalSupply = totalSupply.sub(liquidityBN).toString();
    
    return {
      amountA: amountA.toString(),
      amountB: amountB.toString()
    };
  }

  getQuote(poolId, tokenIn, amountIn) {
    const pool = this.pools.get(poolId);
    if (!pool) throw new Error('Pool not found');
    
    const isTokenA = tokenIn.toLowerCase() === pool.tokenA;
    const reserveIn = ethers.BigNumber.from(isTokenA ? pool.reserveA : pool.reserveB);
    const reserveOut = ethers.BigNumber.from(isTokenA ? pool.reserveB : pool.reserveA);
    const amountInBN = ethers.BigNumber.from(amountIn);
    
    // Apply fee
    const feeMultiplier = 10000 - parseFloat(pool.fee) * 10000;
    const amountInWithFee = amountInBN.mul(feeMultiplier);
    
    // Calculate output amount (x * y = k)
    const numerator = amountInWithFee.mul(reserveOut);
    const denominator = reserveIn.mul(10000).add(amountInWithFee);
    const amountOut = numerator.div(denominator);
    
    return {
      amountOut: amountOut.toString(),
      priceImpact: this.calculatePriceImpact(
        amountInBN,
        reserveIn,
        reserveOut
      ),
      fee: amountInBN.mul(parseFloat(pool.fee) * 10000).div(10000).toString()
    };
  }

  calculatePriceImpact(amountIn, reserveIn, reserveOut) {
    const priceBefor = reserveOut.mul(10000).div(reserveIn);
    const newReserveIn = reserveIn.add(amountIn);
    const newReserveOut = reserveIn.mul(reserveOut).div(newReserveIn);
    const priceAfter = newReserveOut.mul(10000).div(newReserveIn);
    
    const impact = priceBefor.sub(priceAfter).mul(10000).div(priceBefor);
    return impact.toNumber() / 100; // Return as percentage
  }

  getPoolId(chainId, tokenA, tokenB) {
    const [token0, token1] = tokenA.toLowerCase() < tokenB.toLowerCase()
      ? [tokenA.toLowerCase(), tokenB.toLowerCase()]
      : [tokenB.toLowerCase(), tokenA.toLowerCase()];
    
    return `${chainId}-${token0}-${token1}`;
  }

  getPoolInfo(poolId) {
    return this.pools.get(poolId);
  }
}

class TransferManager {
  constructor() {
    this.transfers = new Map();
    this.nonces = new Map();
    this.pendingTransfers = new Map();
  }

  createTransfer(params) {
    const transferId = this.generateTransferId();
    const nonce = this.getNextNonce(params.sourceChain, params.sender);
    
    const transfer = {
      id: transferId,
      sourceChain: params.sourceChain,
      targetChain: params.targetChain,
      sourceToken: params.sourceToken.toLowerCase(),
      targetToken: params.targetToken?.toLowerCase() || null,
      sender: params.sender.toLowerCase(),
      recipient: params.recipient.toLowerCase(),
      amount: params.amount,
      fee: params.fee || '0',
      nonce,
      state: TransferState.INITIATED,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      txHashes: {},
      signatures: [],
      metadata: params.metadata || {}
    };
    
    this.transfers.set(transferId, transfer);
    this.pendingTransfers.set(transferId, transfer);
    
    return transfer;
  }

  updateTransfer(transferId, updates) {
    const transfer = this.transfers.get(transferId);
    if (!transfer) throw new Error('Transfer not found');
    
    Object.assign(transfer, updates, {
      updatedAt: Date.now()
    });
    
    if (updates.state === TransferState.COMPLETED || 
        updates.state === TransferState.FAILED ||
        updates.state === TransferState.REFUNDED) {
      this.pendingTransfers.delete(transferId);
    }
    
    return transfer;
  }

  getTransfer(transferId) {
    return this.transfers.get(transferId);
  }

  getPendingTransfers(chainId = null) {
    const pending = Array.from(this.pendingTransfers.values());
    
    if (chainId) {
      return pending.filter(t => 
        t.sourceChain === chainId || t.targetChain === chainId
      );
    }
    
    return pending;
  }

  getTransfersByAddress(address) {
    const normalized = address.toLowerCase();
    return Array.from(this.transfers.values()).filter(t =>
      t.sender === normalized || t.recipient === normalized
    );
  }

  generateTransferId() {
    return 'tx_' + Date.now().toString(36) + '_' + 
           crypto.randomBytes(8).toString('hex');
  }

  getNextNonce(chainId, address) {
    const key = `${chainId}-${address.toLowerCase()}`;
    const current = this.nonces.get(key) || 0;
    const next = current + 1;
    this.nonces.set(key, next);
    return next;
  }
}

class FraudDetector {
  constructor() {
    this.suspiciousPatterns = new Map();
    this.blacklistedAddresses = new Set();
    this.transferLimits = {
      hourly: '10000',
      daily: '50000',
      perTransfer: '5000'
    };
  }

  async checkTransfer(transfer) {
    const issues = [];
    
    // Check blacklist
    if (this.blacklistedAddresses.has(transfer.sender) ||
        this.blacklistedAddresses.has(transfer.recipient)) {
      issues.push({
        type: 'BLACKLISTED_ADDRESS',
        severity: 'critical'
      });
    }
    
    // Check amount limits
    const amount = ethers.BigNumber.from(transfer.amount);
    const maxTransfer = ethers.BigNumber.from(
      ethers.utils.parseEther(this.transferLimits.perTransfer)
    );
    
    if (amount.gt(maxTransfer)) {
      issues.push({
        type: 'AMOUNT_TOO_LARGE',
        severity: 'high',
        limit: this.transferLimits.perTransfer
      });
    }
    
    // Check velocity
    const velocity = await this.checkVelocity(transfer.sender);
    if (velocity.exceedsLimits) {
      issues.push({
        type: 'VELOCITY_EXCEEDED',
        severity: 'medium',
        details: velocity
      });
    }
    
    // Check patterns
    const pattern = this.detectSuspiciousPattern(transfer);
    if (pattern) {
      issues.push({
        type: 'SUSPICIOUS_PATTERN',
        severity: 'medium',
        pattern
      });
    }
    
    return {
      safe: issues.length === 0,
      issues,
      riskScore: this.calculateRiskScore(issues)
    };
  }

  async checkVelocity(address) {
    // Check transfer velocity for the address
    // This would query historical data
    const hourlyVolume = '0'; // Would be calculated
    const dailyVolume = '0'; // Would be calculated
    
    return {
      exceedsLimits: false,
      hourlyVolume,
      dailyVolume,
      limits: this.transferLimits
    };
  }

  detectSuspiciousPattern(transfer) {
    // Detect common attack patterns
    // - Rapid small transfers (dusting)
    // - Round-trip transfers
    // - Unusual time patterns
    
    return null;
  }

  calculateRiskScore(issues) {
    const severityScores = {
      critical: 100,
      high: 50,
      medium: 25,
      low: 10
    };
    
    let score = 0;
    for (const issue of issues) {
      score += severityScores[issue.severity] || 0;
    }
    
    return Math.min(100, score);
  }

  reportIncident(transfer, reason) {
    logger.warn('Security incident detected', {
      transferId: transfer.id,
      reason,
      transfer
    });
    
    // Could trigger emergency pause or other actions
  }

  blacklistAddress(address, reason) {
    this.blacklistedAddresses.add(address.toLowerCase());
    logger.warn(`Address blacklisted: ${address}`, { reason });
  }

  whitelistAddress(address) {
    this.blacklistedAddresses.delete(address.toLowerCase());
  }
}

class MultiChainBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      chains: options.chains || Object.values(SupportedChains),
      validators: options.validators || [],
      requiredSignatures: options.requiredSignatures || 3,
      bridgeFee: options.bridgeFee || '0.001', // 0.1%
      emergencyPause: false,
      contracts: options.contracts || {},
      ...options
    };
    
    this.connectors = new Map();
    this.tokenRegistry = new TokenRegistry();
    this.validatorNetwork = new ValidatorNetwork({
      requiredSignatures: this.config.requiredSignatures
    });
    this.liquidityManager = new LiquidityManager();
    this.transferManager = new TransferManager();
    this.fraudDetector = new FraudDetector();
    
    this.stats = {
      totalTransfers: 0,
      completedTransfers: 0,
      failedTransfers: 0,
      totalVolume: '0',
      totalFees: '0',
      activeValidators: 0
    };
    
    this.initialize();
  }

  async initialize() {
    // Initialize chain connectors
    for (const chain of this.config.chains) {
      const connector = new ChainConnector(chain, this.config);
      this.connectors.set(chain.id, connector);
      
      // Load bridge contracts
      if (this.config.contracts[chain.id]) {
        await this.loadChainContracts(chain.id, this.config.contracts[chain.id]);
      }
    }
    
    // Register validators
    for (const validator of this.config.validators) {
      this.validatorNetwork.registerValidator(validator.address, validator);
    }
    
    this.stats.activeValidators = this.config.validators.filter(v => v.active).length;
    
    // Start monitoring
    this.startMonitoring();
    
    logger.info('Multi-chain bridge initialized', {
      chains: this.config.chains.map(c => c.name),
      validators: this.stats.activeValidators
    });
  }

  async loadChainContracts(chainId, contracts) {
    const connector = this.connectors.get(chainId);
    
    for (const [name, config] of Object.entries(contracts)) {
      await connector.loadContract(config.address, config.abi, name);
    }
  }

  startMonitoring() {
    // Monitor each chain for relevant events
    for (const [chainId, connector] of this.connectors) {
      this.monitorChain(chainId, connector);
    }
    
    // Process pending transfers periodically
    this.processingInterval = setInterval(() => {
      this.processPendingTransfers();
    }, 30000); // Every 30 seconds
    
    // Clean up old transfers
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldTransfers();
    }, 3600000); // Every hour
  }

  async monitorChain(chainId, connector) {
    try {
      // Subscribe to lock events
      connector.subscribeToEvents('Bridge', 'TokensLocked', async (event) => {
        await this.handleTokensLocked(chainId, event);
      });
      
      // Subscribe to unlock events
      connector.subscribeToEvents('Bridge', 'TokensUnlocked', async (event) => {
        await this.handleTokensUnlocked(chainId, event);
      });
      
      // Subscribe to mint events
      connector.subscribeToEvents('Bridge', 'TokensMinted', async (event) => {
        await this.handleTokensMinted(chainId, event);
      });
      
      // Subscribe to burn events
      connector.subscribeToEvents('Bridge', 'TokensBurned', async (event) => {
        await this.handleTokensBurned(chainId, event);
      });
    } catch (error) {
      logger.error(`Failed to monitor chain ${chainId}:`, error);
    }
  }

  async initiateTransfer(params) {
    if (this.config.emergencyPause) {
      throw new Error('Bridge is paused for emergency');
    }
    
    // Validate parameters
    this.validateTransferParams(params);
    
    // Check fraud detection
    const fraudCheck = await this.fraudDetector.checkTransfer({
      sender: params.sender,
      recipient: params.recipient,
      amount: params.amount,
      sourceChain: params.sourceChain,
      targetChain: params.targetChain
    });
    
    if (!fraudCheck.safe && fraudCheck.riskScore > 50) {
      throw new Error('Transfer flagged as high risk');
    }
    
    // Create transfer record
    const transfer = this.transferManager.createTransfer(params);
    
    // Calculate fees
    const amount = ethers.BigNumber.from(params.amount);
    const feeAmount = amount.mul(parseFloat(this.config.bridgeFee) * 10000).div(10000);
    const netAmount = amount.sub(feeAmount);
    
    transfer.fee = feeAmount.toString();
    transfer.netAmount = netAmount.toString();
    
    this.stats.totalTransfers++;
    
    this.emit('transfer:initiated', transfer);
    
    // Start the transfer process
    this.processTransfer(transfer);
    
    return transfer;
  }

  async processTransfer(transfer) {
    try {
      // Step 1: Lock tokens on source chain
      const lockTx = await this.lockTokens(transfer);
      this.transferManager.updateTransfer(transfer.id, {
        state: TransferState.LOCKED,
        txHashes: { ...transfer.txHashes, lock: lockTx.hash }
      });
      
      // Step 2: Wait for validators to sign
      const signatures = await this.collectValidatorSignatures(transfer);
      this.transferManager.updateTransfer(transfer.id, {
        state: TransferState.VALIDATING,
        signatures
      });
      
      // Step 3: Mint or unlock on target chain
      const releaseTx = await this.releaseTokens(transfer, signatures);
      this.transferManager.updateTransfer(transfer.id, {
        state: TransferState.COMPLETED,
        txHashes: { ...transfer.txHashes, release: releaseTx.hash }
      });
      
      // Update statistics
      this.stats.completedTransfers++;
      this.stats.totalVolume = ethers.BigNumber.from(this.stats.totalVolume)
        .add(transfer.amount)
        .toString();
      this.stats.totalFees = ethers.BigNumber.from(this.stats.totalFees)
        .add(transfer.fee)
        .toString();
      
      this.emit('transfer:completed', transfer);
      
    } catch (error) {
      logger.error('Transfer processing failed:', error);
      
      this.transferManager.updateTransfer(transfer.id, {
        state: TransferState.FAILED,
        error: error.message
      });
      
      this.stats.failedTransfers++;
      
      this.emit('transfer:failed', transfer);
      
      // Attempt refund if tokens were locked
      if (transfer.txHashes.lock) {
        await this.refundTransfer(transfer);
      }
    }
  }

  async lockTokens(transfer) {
    const sourceConnector = this.connectors.get(transfer.sourceChain);
    const bridgeContract = sourceConnector.contracts.get('Bridge');
    
    // Prepare transaction
    const tx = await bridgeContract.lockTokens(
      transfer.sourceToken,
      transfer.amount,
      transfer.targetChain,
      transfer.recipient,
      {
        value: transfer.sourceToken === ethers.constants.AddressZero
          ? transfer.amount
          : 0
      }
    );
    
    // Wait for confirmation
    const receipt = await sourceConnector.waitForTransaction(tx.hash);
    
    return receipt;
  }

  async collectValidatorSignatures(transfer) {
    return new Promise((resolve, reject) => {
      const signatures = [];
      const timeout = setTimeout(() => {
        reject(new Error('Validator signature timeout'));
      }, 300000); // 5 minutes
      
      // Request signatures from validators
      const validators = this.validatorNetwork.selectValidators();
      
      for (const validator of validators) {
        // In production, this would send requests to validator nodes
        // For now, simulate signature collection
        const signature = this.simulateValidatorSignature(transfer, validator);
        signatures.push(signature);
      }
      
      clearTimeout(timeout);
      
      // Verify we have enough signatures
      const validation = this.validatorNetwork.validateTransfer(transfer, signatures);
      
      if (validation.valid) {
        resolve(validation.signatures);
      } else {
        reject(new Error('Insufficient validator signatures'));
      }
    });
  }

  simulateValidatorSignature(transfer, validator) {
    // In production, validators would sign the transfer hash
    // This is a simulation
    const messageHash = this.validatorNetwork.getTransferHash(transfer);
    return {
      validator: validator.address,
      signature: '0x' + crypto.randomBytes(65).toString('hex')
    };
  }

  async releaseTokens(transfer, signatures) {
    const targetConnector = this.connectors.get(transfer.targetChain);
    const bridgeContract = targetConnector.contracts.get('Bridge');
    
    // Check if we need to mint or unlock
    const isWrapped = this.tokenRegistry.isWrappedToken(
      transfer.targetChain,
      transfer.targetToken || transfer.sourceToken
    );
    
    let tx;
    if (isWrapped) {
      // Mint wrapped tokens
      tx = await bridgeContract.mintTokens(
        transfer.targetToken,
        transfer.recipient,
        transfer.netAmount,
        transfer.nonce,
        signatures.map(s => s.signature)
      );
    } else {
      // Unlock native tokens
      tx = await bridgeContract.unlockTokens(
        transfer.sourceToken,
        transfer.recipient,
        transfer.netAmount,
        transfer.nonce,
        signatures.map(s => s.signature)
      );
    }
    
    // Wait for confirmation
    const receipt = await targetConnector.waitForTransaction(tx.hash);
    
    return receipt;
  }

  async refundTransfer(transfer) {
    try {
      const sourceConnector = this.connectors.get(transfer.sourceChain);
      const bridgeContract = sourceConnector.contracts.get('Bridge');
      
      const tx = await bridgeContract.refundTokens(
        transfer.id,
        transfer.sender,
        transfer.amount
      );
      
      const receipt = await sourceConnector.waitForTransaction(tx.hash);
      
      this.transferManager.updateTransfer(transfer.id, {
        state: TransferState.REFUNDED,
        txHashes: { ...transfer.txHashes, refund: receipt.hash }
      });
      
      this.emit('transfer:refunded', transfer);
      
    } catch (error) {
      logger.error('Refund failed:', error);
    }
  }

  async processPendingTransfers() {
    const pending = this.transferManager.getPendingTransfers();
    
    for (const transfer of pending) {
      // Check if transfer is stuck
      const age = Date.now() - transfer.createdAt;
      
      if (age > 600000 && transfer.state !== TransferState.COMPLETED) {
        // Transfer is older than 10 minutes and not completed
        logger.warn('Stuck transfer detected', { transferId: transfer.id });
        
        // Attempt to resume or refund
        if (transfer.state === TransferState.LOCKED) {
          await this.processTransfer(transfer);
        }
      }
    }
  }

  cleanupOldTransfers() {
    const cutoff = Date.now() - 86400000 * 7; // 7 days
    let cleaned = 0;
    
    for (const [id, transfer] of this.transferManager.transfers) {
      if (transfer.updatedAt < cutoff && 
          (transfer.state === TransferState.COMPLETED || 
           transfer.state === TransferState.REFUNDED)) {
        this.transferManager.transfers.delete(id);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} old transfers`);
    }
  }

  validateTransferParams(params) {
    const required = ['sourceChain', 'targetChain', 'sourceToken', 'sender', 'recipient', 'amount'];
    
    for (const field of required) {
      if (!params[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }
    
    // Validate chains
    if (!this.connectors.has(params.sourceChain)) {
      throw new Error('Invalid source chain');
    }
    
    if (!this.connectors.has(params.targetChain)) {
      throw new Error('Invalid target chain');
    }
    
    // Validate addresses
    if (!ethers.utils.isAddress(params.sender)) {
      throw new Error('Invalid sender address');
    }
    
    if (!ethers.utils.isAddress(params.recipient)) {
      throw new Error('Invalid recipient address');
    }
    
    // Validate amount
    try {
      const amount = ethers.BigNumber.from(params.amount);
      if (amount.lte(0)) {
        throw new Error('Amount must be positive');
      }
    } catch (error) {
      throw new Error('Invalid amount');
    }
  }

  // Event handlers
  async handleTokensLocked(chainId, event) {
    logger.debug('Tokens locked', { chainId, event });
    // Process if this is a new transfer we're not tracking
  }

  async handleTokensUnlocked(chainId, event) {
    logger.debug('Tokens unlocked', { chainId, event });
  }

  async handleTokensMinted(chainId, event) {
    logger.debug('Tokens minted', { chainId, event });
  }

  async handleTokensBurned(chainId, event) {
    logger.debug('Tokens burned', { chainId, event });
    // This would trigger a cross-chain unlock
  }

  // Admin functions
  async pauseBridge(reason) {
    this.config.emergencyPause = true;
    logger.warn('Bridge paused', { reason });
    this.emit('bridge:paused', { reason });
  }

  async unpauseBridge() {
    this.config.emergencyPause = false;
    logger.info('Bridge unpaused');
    this.emit('bridge:unpaused');
  }

  // Public API
  async getSupportedTokens(chainId = null) {
    const tokens = [];
    
    for (const [key, token] of this.tokenRegistry.tokens) {
      if (!chainId || token.chainId === chainId) {
        tokens.push(token);
      }
    }
    
    return tokens;
  }

  async estimateTransferFee(amount) {
    const amountBN = ethers.BigNumber.from(amount);
    const fee = amountBN.mul(parseFloat(this.config.bridgeFee) * 10000).div(10000);
    
    return {
      fee: fee.toString(),
      feePercentage: this.config.bridgeFee,
      netAmount: amountBN.sub(fee).toString()
    };
  }

  async getTransferStatus(transferId) {
    const transfer = this.transferManager.getTransfer(transferId);
    if (!transfer) {
      throw new Error('Transfer not found');
    }
    
    return {
      ...transfer,
      confirmations: await this.getTransferConfirmations(transfer)
    };
  }

  async getTransferConfirmations(transfer) {
    const confirmations = {};
    
    if (transfer.txHashes.lock) {
      const sourceConnector = this.connectors.get(transfer.sourceChain);
      const tx = await sourceConnector.getTransaction(transfer.txHashes.lock);
      if (tx && tx.blockNumber) {
        const currentBlock = await sourceConnector.getBlockNumber();
        confirmations.source = currentBlock - tx.blockNumber;
      }
    }
    
    if (transfer.txHashes.release) {
      const targetConnector = this.connectors.get(transfer.targetChain);
      const tx = await targetConnector.getTransaction(transfer.txHashes.release);
      if (tx && tx.blockNumber) {
        const currentBlock = await targetConnector.getBlockNumber();
        confirmations.target = currentBlock - tx.blockNumber;
      }
    }
    
    return confirmations;
  }

  getStatistics() {
    return {
      ...this.stats,
      chains: this.config.chains.map(c => ({
        id: c.id,
        name: c.name,
        connected: this.connectors.has(c.id)
      })),
      validators: {
        total: this.validatorNetwork.validators.size,
        active: this.stats.activeValidators,
        required: this.config.requiredSignatures
      },
      pendingTransfers: this.transferManager.pendingTransfers.size,
      emergencyPause: this.config.emergencyPause
    };
  }

  async cleanup() {
    // Unsubscribe from all events
    for (const connector of this.connectors.values()) {
      for (const [key] of connector.listeners) {
        const [contract, event] = key.split('-');
        connector.unsubscribeFromEvents(contract, event);
      }
    }
    
    // Clear intervals
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
    }
    
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    this.removeAllListeners();
    logger.info('Multi-chain bridge cleaned up');
  }
}

module.exports = {
  MultiChainBridge,
  SupportedChains,
  BridgeOperation,
  TransferState,
  ChainConnector,
  TokenRegistry,
  ValidatorNetwork,
  LiquidityManager,
  TransferManager,
  FraudDetector
};