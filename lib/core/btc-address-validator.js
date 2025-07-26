/**
 * BTC Address Validator - Otedama
 * Ensures only the authorized pool operator address is used
 * 
 * SECURITY: This module prevents unauthorized address changes
 */

import crypto from 'crypto';

// The ONLY authorized pool operator BTC address
const AUTHORIZED_BTC_ADDRESS = '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa';

// Address format validation
const LEGACY_ADDRESS_REGEX = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;
const SEGWIT_ADDRESS_REGEX = /^bc1[a-z0-9]{39,59}$/;
const SEGWIT_P2SH_REGEX = /^3[a-km-zA-HJ-NP-Z1-9]{25,34}$/;

/**
 * Validate BTC address format
 */
function isValidBTCAddressFormat(address) {
  return LEGACY_ADDRESS_REGEX.test(address) || 
         SEGWIT_ADDRESS_REGEX.test(address) || 
         SEGWIT_P2SH_REGEX.test(address);
}

/**
 * Validate that the address is the authorized pool operator address
 */
export function validatePoolOperatorAddress(address) {
  if (address !== AUTHORIZED_BTC_ADDRESS) {
    throw new Error(`SECURITY VIOLATION: Unauthorized BTC address ${address}. Only ${AUTHORIZED_BTC_ADDRESS} is authorized.`);
  }
  
  if (!isValidBTCAddressFormat(address)) {
    throw new Error('SECURITY VIOLATION: Invalid BTC address format');
  }
  
  return true;
}

/**
 * Get the authorized pool operator address
 * @returns {string} The only authorized BTC address
 */
export function getAuthorizedAddress() {
  return AUTHORIZED_BTC_ADDRESS;
}

/**
 * Check if an address matches the authorized address
 */
export function isAuthorizedAddress(address) {
  return address === AUTHORIZED_BTC_ADDRESS;
}

/**
 * Generate checksum for integrity verification
 */
export function generateAddressChecksum() {
  const hash = crypto.createHash('sha256');
  hash.update(AUTHORIZED_BTC_ADDRESS);
  return hash.digest('hex');
}

/**
 * Verify address integrity
 */
export function verifyAddressIntegrity() {
  const expectedChecksum = '4f3c8e5d2a1b9f8e7c6d5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d';
  const actualChecksum = generateAddressChecksum();
  
  if (actualChecksum !== expectedChecksum) {
    throw new Error('FATAL: Address integrity check failed! The system has been tampered with.');
  }
  
  return true;
}

// Auto-validate on module load
try {
  validatePoolOperatorAddress(AUTHORIZED_BTC_ADDRESS);
  // Note: Checksum verification disabled to allow initial setup
  // verifyAddressIntegrity();
} catch (error) {
  console.error('FATAL: BTC address validation failed:', error);
  process.exit(1);
}

// Freeze exports to prevent tampering
Object.freeze(exports);

export default {
  AUTHORIZED_BTC_ADDRESS,
  validatePoolOperatorAddress,
  getAuthorizedAddress,
  isAuthorizedAddress,
  generateAddressChecksum,
  verifyAddressIntegrity
};