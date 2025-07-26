/**
 * Pool Fee Protection System - Otedama
 * Prevents unauthorized fee modifications
 * 
 * SECURITY: This module ensures pool fees cannot be tampered with
 */

import crypto from 'crypto';
import { POOL_FEES, POOL_OPERATOR } from '../core/constants.js';
import { validatePoolOperatorAddress } from '../core/btc-address-validator.js';

// Fee limits - hardcoded and immutable
const FEE_LIMITS = Object.freeze({
  MIN_MINING_FEE: 0.01, // 1%
  MAX_MINING_FEE: 0.01, // 1% - cannot be changed
  MIN_WITHDRAWAL_FEE: 0.0001, // 0.0001 BTC
  MAX_WITHDRAWAL_FEE: 0.0001, // 0.0001 BTC - cannot be changed
  MIN_CONVERSION_FEE: 0.002, // 0.2%
  MAX_CONVERSION_FEE: 0.002 // 0.2% - cannot be changed
});

/**
 * Validate pool fees
 */
export function validatePoolFees(fees) {
  // Validate mining fee
  if (fees.miningFee !== POOL_FEES.MINING_FEE) {
    throw new Error(`SECURITY VIOLATION: Mining fee must be ${POOL_FEES.MINING_FEE} (1%)`);
  }
  
  if (fees.miningFee < FEE_LIMITS.MIN_MINING_FEE || fees.miningFee > FEE_LIMITS.MAX_MINING_FEE) {
    throw new Error('SECURITY VIOLATION: Mining fee out of allowed range');
  }
  
  // Validate withdrawal fee
  if (fees.withdrawalFee !== POOL_FEES.WITHDRAWAL_FEE) {
    throw new Error(`SECURITY VIOLATION: Withdrawal fee must be ${POOL_FEES.WITHDRAWAL_FEE} BTC`);
  }
  
  if (fees.withdrawalFee < FEE_LIMITS.MIN_WITHDRAWAL_FEE || fees.withdrawalFee > FEE_LIMITS.MAX_WITHDRAWAL_FEE) {
    throw new Error('SECURITY VIOLATION: Withdrawal fee out of allowed range');
  }
  
  // Validate conversion fee
  if (fees.conversionFee !== POOL_FEES.CONVERSION_FEE) {
    throw new Error(`SECURITY VIOLATION: Conversion fee must be ${POOL_FEES.CONVERSION_FEE} (0.2%)`);
  }
  
  if (fees.conversionFee < FEE_LIMITS.MIN_CONVERSION_FEE || fees.conversionFee > FEE_LIMITS.MAX_CONVERSION_FEE) {
    throw new Error('SECURITY VIOLATION: Conversion fee out of allowed range');
  }
  
  return true;
}

/**
 * Calculate pool fee for a given amount
 */
export function calculatePoolFee(amount, feeType = 'mining') {
  // Validate amount
  if (typeof amount !== 'number' || amount < 0) {
    throw new Error('Invalid amount for fee calculation');
  }
  
  let fee;
  switch (feeType) {
    case 'mining':
      fee = amount * POOL_FEES.MINING_FEE;
      break;
    case 'withdrawal':
      fee = POOL_FEES.WITHDRAWAL_FEE;
      break;
    case 'conversion':
      fee = amount * POOL_FEES.CONVERSION_FEE;
      break;
    default:
      throw new Error('Invalid fee type');
  }
  
  return {
    amount: amount,
    fee: fee,
    netAmount: amount - fee,
    feePercentage: (fee / amount) * 100,
    recipient: POOL_OPERATOR.BTC_ADDRESS
  };
}

/**
 * Verify fee transaction integrity
 */
export function verifyFeeTransaction(transaction) {
  // Validate fee recipient
  if (transaction.feeRecipient !== POOL_OPERATOR.BTC_ADDRESS) {
    throw new Error('SECURITY VIOLATION: Invalid fee recipient address');
  }
  
  // Validate fee amount
  const expectedFee = calculatePoolFee(transaction.amount, transaction.feeType);
  if (Math.abs(transaction.fee - expectedFee.fee) > 0.00000001) { // Allow tiny rounding errors
    throw new Error('SECURITY VIOLATION: Fee amount does not match expected value');
  }
  
  // Validate operator address
  validatePoolOperatorAddress(transaction.feeRecipient);
  
  return true;
}

/**
 * Generate fee configuration hash for integrity checking
 */
export function generateFeeConfigHash() {
  const configString = JSON.stringify({
    miningFee: POOL_FEES.MINING_FEE,
    withdrawalFee: POOL_FEES.WITHDRAWAL_FEE,
    conversionFee: POOL_FEES.CONVERSION_FEE,
    operatorAddress: POOL_OPERATOR.BTC_ADDRESS
  });
  
  const hash = crypto.createHash('sha256');
  hash.update(configString);
  return hash.digest('hex');
}

/**
 * Monitor for fee tampering attempts
 */
export class FeeProtectionMonitor {
  constructor() {
    this.expectedHash = generateFeeConfigHash();
    this.monitoringInterval = null;
  }
  
  start() {
    // Check every 60 seconds
    this.monitoringInterval = setInterval(() => {
      this.verifyFeeIntegrity();
    }, 60000);
    
    // Initial check
    this.verifyFeeIntegrity();
  }
  
  stop() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
  }
  
  verifyFeeIntegrity() {
    const currentHash = generateFeeConfigHash();
    if (currentHash !== this.expectedHash) {
      console.error('FATAL: Fee configuration has been tampered with!');
      process.exit(1);
    }
  }
}

// Create and start fee protection monitor
const monitor = new FeeProtectionMonitor();
monitor.start();

// Freeze all exports
Object.freeze(exports);

export default {
  FEE_LIMITS,
  validatePoolFees,
  calculatePoolFee,
  verifyFeeTransaction,
  generateFeeConfigHash,
  FeeProtectionMonitor
};