/**
 * Address Separation System - Otedama
 * Separates pool operator address (fixed) from miner addresses (flexible)
 * 
 * SECURITY: Pool operator address is immutable, miner addresses are user-configurable
 */

import { POOL_OPERATOR } from '../core/constants.js';
import { validatePoolOperatorAddress } from '../core/btc-address-validator.js';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('AddressSeparation');

// Fixed pool operator address - CANNOT BE CHANGED
const POOL_OPERATOR_ADDRESS = '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa';

// Validate address formats
const ADDRESS_PATTERNS = {
  LEGACY: /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/,
  SEGWIT: /^bc1[a-z0-9]{39,59}$/,
  SEGWIT_P2SH: /^3[a-km-zA-HJ-NP-Z1-9]{25,34}$/,
  TESTNET_LEGACY: /^[mn][a-km-zA-HJ-NP-Z1-9]{25,34}$/,
  TESTNET_SEGWIT: /^tb1[a-z0-9]{39,59}$/
};

/**
 * Validate any BTC address format (for miners)
 */
export function isValidMinerAddress(address) {
  if (!address || typeof address !== 'string') {
    return false;
  }
  
  // Check all supported formats
  return Object.values(ADDRESS_PATTERNS).some(pattern => pattern.test(address));
}

/**
 * Validate miner wallet address
 * Miners can use any valid BTC address format
 */
export function validateMinerAddress(address) {
  if (!isValidMinerAddress(address)) {
    throw new Error(`Invalid miner BTC address format: ${address}`);
  }
  
  // Ensure miner is not trying to use pool operator address
  if (address === POOL_OPERATOR_ADDRESS) {
    throw new Error('Miner cannot use pool operator address');
  }
  
  return true;
}

/**
 * Get pool operator address (immutable)
 */
export function getPoolOperatorAddress() {
  // Always validate before returning
  validatePoolOperatorAddress(POOL_OPERATOR_ADDRESS);
  
  // Double-check against constants
  if (POOL_OPERATOR_ADDRESS !== POOL_OPERATOR.BTC_ADDRESS) {
    logger.error('FATAL: Pool operator address mismatch detected!');
    process.exit(1);
  }
  
  return POOL_OPERATOR_ADDRESS;
}

/**
 * Process payout transaction
 * Separates miner rewards from pool fees
 */
export function processPayoutTransaction(minerAddress, amount, feePercentage = 0.01) {
  // Validate miner address
  validateMinerAddress(minerAddress);
  
  // Calculate amounts
  const poolFee = amount * feePercentage;
  const minerPayout = amount - poolFee;
  
  // Create transaction structure
  const transaction = {
    // Miner gets their payout to their chosen address
    minerPayout: {
      address: minerAddress,
      amount: minerPayout,
      currency: 'BTC'
    },
    // Pool fee always goes to fixed operator address
    poolFee: {
      address: getPoolOperatorAddress(),
      amount: poolFee,
      currency: 'BTC'
    },
    // Transaction metadata
    metadata: {
      totalAmount: amount,
      feePercentage: feePercentage,
      timestamp: Date.now(),
      verified: true
    }
  };
  
  logger.info('Payout transaction created', {
    miner: minerAddress.substring(0, 10) + '...',
    amount: minerPayout,
    fee: poolFee
  });
  
  return transaction;
}

/**
 * Miner registration
 * Allows any valid BTC address for miners
 */
export function registerMiner(minerAddress, workerName = 'default') {
  // Validate miner address
  validateMinerAddress(minerAddress);
  
  const minerInfo = {
    address: minerAddress,
    workerName: workerName,
    registeredAt: Date.now(),
    isActive: true,
    // Miner settings are flexible
    settings: {
      minimumPayout: 0.001,
      payoutFrequency: 'daily',
      autoConvert: false
    }
  };
  
  logger.info('Miner registered', {
    address: minerAddress.substring(0, 10) + '...',
    worker: workerName
  });
  
  return minerInfo;
}

/**
 * Batch payout processor
 * Processes multiple miner payouts while ensuring pool fees go to operator
 */
export function processBatchPayouts(payouts) {
  const processedPayouts = [];
  let totalPoolFees = 0;
  
  for (const payout of payouts) {
    try {
      // Validate each miner address
      validateMinerAddress(payout.minerAddress);
      
      const transaction = processPayoutTransaction(
        payout.minerAddress,
        payout.amount,
        0.01 // 1% pool fee
      );
      
      processedPayouts.push(transaction);
      totalPoolFees += transaction.poolFee.amount;
      
    } catch (error) {
      logger.error('Failed to process payout', {
        miner: payout.minerAddress,
        error: error.message
      });
    }
  }
  
  // Summary transaction for pool operator
  const poolFeeSummary = {
    operatorAddress: getPoolOperatorAddress(),
    totalFees: totalPoolFees,
    payoutCount: processedPayouts.length,
    timestamp: Date.now()
  };
  
  return {
    minerPayouts: processedPayouts,
    poolFeeSummary: poolFeeSummary
  };
}

/**
 * Address type detector
 * Helps miners understand their address format
 */
export function detectAddressType(address) {
  if (!address) return null;
  
  for (const [type, pattern] of Object.entries(ADDRESS_PATTERNS)) {
    if (pattern.test(address)) {
      return {
        type: type,
        address: address,
        isValid: true,
        isTestnet: type.includes('TESTNET')
      };
    }
  }
  
  return {
    type: 'UNKNOWN',
    address: address,
    isValid: false,
    isTestnet: false
  };
}

// Auto-validate on module load
validatePoolOperatorAddress(POOL_OPERATOR_ADDRESS);

// Freeze exports
Object.freeze(exports);

export default {
  POOL_OPERATOR_ADDRESS,
  isValidMinerAddress,
  validateMinerAddress,
  getPoolOperatorAddress,
  processPayoutTransaction,
  registerMiner,
  processBatchPayouts,
  detectAddressType
};