/**
 * Miner Address Validator - Otedama
 * Validates miner addresses while keeping pool operator address separate
 * 
 * IMPORTANT: This is for MINER addresses only
 * Pool operator address is handled separately and is immutable
 */

import { createStructuredLogger } from '../core/structured-logger.js';
import { getPoolOperatorAddress } from '../security/address-separation.js';

const logger = createStructuredLogger('MinerAddressValidator');

// Supported address formats for miners
const MINER_ADDRESS_PATTERNS = {
  // Bitcoin mainnet
  LEGACY: /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/,
  SEGWIT: /^bc1[a-z0-9]{39,59}$/,
  SEGWIT_P2SH: /^3[a-km-zA-HJ-NP-Z1-9]{25,34}$/,
  
  // Bitcoin testnet (for testing)
  TESTNET_LEGACY: /^[mn][a-km-zA-HJ-NP-Z1-9]{25,34}$/,
  TESTNET_SEGWIT: /^tb1[a-z0-9]{39,59}$/,
  
  // Other supported coins
  LITECOIN: /^[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}$/,
  LITECOIN_SEGWIT: /^ltc1[a-z0-9]{39,59}$/,
  ETHEREUM: /^0x[a-fA-F0-9]{40}$/,
  MONERO: /^4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/,
  RAVENCOIN: /^R[a-km-zA-HJ-NP-Z1-9]{33}$/
};

/**
 * Validate miner address format
 * @param {string} address - Miner's wallet address
 * @param {string} coin - Coin type (BTC, LTC, ETH, XMR, RVN)
 * @returns {boolean} True if valid
 */
export function isValidMinerAddress(address, coin = 'BTC') {
  if (!address || typeof address !== 'string') {
    return false;
  }
  
  // Miners cannot use the pool operator address
  if (address === getPoolOperatorAddress()) {
    logger.warn('Miner attempted to use pool operator address', { address });
    return false;
  }
  
  // Check format based on coin type
  switch (coin.toUpperCase()) {
    case 'BTC':
      return MINER_ADDRESS_PATTERNS.LEGACY.test(address) ||
             MINER_ADDRESS_PATTERNS.SEGWIT.test(address) ||
             MINER_ADDRESS_PATTERNS.SEGWIT_P2SH.test(address);
    
    case 'TESTNET':
      return MINER_ADDRESS_PATTERNS.TESTNET_LEGACY.test(address) ||
             MINER_ADDRESS_PATTERNS.TESTNET_SEGWIT.test(address);
    
    case 'LTC':
      return MINER_ADDRESS_PATTERNS.LITECOIN.test(address) ||
             MINER_ADDRESS_PATTERNS.LITECOIN_SEGWIT.test(address);
    
    case 'ETH':
    case 'ETC':
      return MINER_ADDRESS_PATTERNS.ETHEREUM.test(address);
    
    case 'XMR':
      return MINER_ADDRESS_PATTERNS.MONERO.test(address);
    
    case 'RVN':
      return MINER_ADDRESS_PATTERNS.RAVENCOIN.test(address);
    
    default:
      logger.warn('Unknown coin type for address validation', { coin });
      return false;
  }
}

/**
 * Get address type information
 * @param {string} address - Address to analyze
 * @returns {Object} Address type information
 */
export function getMinerAddressInfo(address) {
  if (!address) {
    return { valid: false, type: 'INVALID', coin: null };
  }
  
  // Check each pattern
  for (const [type, pattern] of Object.entries(MINER_ADDRESS_PATTERNS)) {
    if (pattern.test(address)) {
      let coin = 'BTC';
      
      if (type.includes('LITECOIN')) coin = 'LTC';
      else if (type.includes('ETHEREUM')) coin = 'ETH';
      else if (type.includes('MONERO')) coin = 'XMR';
      else if (type.includes('RAVENCOIN')) coin = 'RVN';
      else if (type.includes('TESTNET')) coin = 'TESTNET';
      
      return {
        valid: true,
        type: type,
        coin: coin,
        format: type.includes('SEGWIT') ? 'segwit' : 
                type.includes('LEGACY') ? 'legacy' : 'other',
        testnet: type.includes('TESTNET')
      };
    }
  }
  
  return { valid: false, type: 'UNKNOWN', coin: null };
}

/**
 * Sanitize miner address (remove whitespace, validate)
 * @param {string} address - Raw address input
 * @param {string} coin - Coin type
 * @returns {string|null} Sanitized address or null if invalid
 */
export function sanitizeMinerAddress(address, coin = 'BTC') {
  if (!address) return null;
  
  // Remove whitespace and control characters
  const cleaned = address.trim().replace(/[\s\n\r\t]/g, '');
  
  // Validate
  if (isValidMinerAddress(cleaned, coin)) {
    return cleaned;
  }
  
  return null;
}

/**
 * Validate miner connection
 * @param {Object} minerData - Miner connection data
 * @returns {Object} Validation result
 */
export function validateMinerConnection(minerData) {
  const result = {
    valid: true,
    errors: []
  };
  
  // Check address
  if (!minerData.address) {
    result.valid = false;
    result.errors.push('Address is required');
  } else if (!isValidMinerAddress(minerData.address, minerData.coin || 'BTC')) {
    result.valid = false;
    result.errors.push('Invalid wallet address format');
  }
  
  // Check worker name
  if (minerData.workerName) {
    // Sanitize worker name
    minerData.workerName = minerData.workerName
      .replace(/[^a-zA-Z0-9._-]/g, '')
      .substring(0, 50);
  }
  
  // Check if trying to use pool address
  if (minerData.address === getPoolOperatorAddress()) {
    result.valid = false;
    result.errors.push('Cannot use pool operator address for mining');
  }
  
  return result;
}

/**
 * Format address for display (show first and last characters)
 * @param {string} address - Full address
 * @param {number} showChars - Number of characters to show at start/end
 * @returns {string} Formatted address
 */
export function formatMinerAddress(address, showChars = 6) {
  if (!address || address.length < showChars * 2) {
    return address;
  }
  
  return `${address.substring(0, showChars)}...${address.substring(address.length - showChars)}`;
}

// Export all functions
export default {
  isValidMinerAddress,
  getMinerAddressInfo,
  sanitizeMinerAddress,
  validateMinerConnection,
  formatMinerAddress,
  MINER_ADDRESS_PATTERNS
};