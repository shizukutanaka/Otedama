/**
 * Address Validator
 * Ensures only authorized creator addresses can be used
 */

const crypto = require('crypto');
const { createLogger } = require('../core/logger');

const logger = createLogger('address-validator');

// Authorized creator address (DO NOT MODIFY)
const AUTHORIZED_ADDRESS = '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa';

// Address hash for additional validation
const AUTHORIZED_HASH = crypto.createHash('sha256')
  .update(AUTHORIZED_ADDRESS)
  .digest('hex');

class AddressValidator {
  /**
   * Validate creator address
   */
  static validateCreatorAddress(address) {
    if (!address) {
      logger.error('Creator address not provided');
      return false;
    }
    
    // Remove whitespace
    const cleanAddress = address.trim();
    
    // Check exact match
    if (cleanAddress !== AUTHORIZED_ADDRESS) {
      logger.error('Unauthorized creator address detected', {
        provided: cleanAddress,
        expected: '[REDACTED]'
      });
      return false;
    }
    
    // Double check with hash
    const addressHash = crypto.createHash('sha256')
      .update(cleanAddress)
      .digest('hex');
      
    if (addressHash !== AUTHORIZED_HASH) {
      logger.error('Address hash validation failed');
      return false;
    }
    
    logger.info('Creator address validated successfully');
    return true;
  }
  
  /**
   * Get error message for invalid address
   */
  static getErrorMessage() {
    return `
╔═══════════════════════════════════════════════════════════════╗
║                    AUTHORIZATION ERROR                         ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║  This software is licensed with a specific creator address.  ║
║  Modifying the creator address is not permitted.             ║
║                                                               ║
║  If you need to use a different address, please contact:     ║
║  - GitHub: https://github.com/shizukutanaka/Otedama          ║
║  - Email: support@otedama.io                                  ║
║                                                               ║
║  Error Code: INVALID_CREATOR_ADDRESS                          ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
    `;
  }
  
  /**
   * Enforce address validation
   */
  static enforce(address) {
    if (!this.validateCreatorAddress(address)) {
      console.error(this.getErrorMessage());
      
      // Log attempt
      logger.error('Unauthorized modification attempt', {
        timestamp: new Date().toISOString(),
        address: address ? '[PROVIDED]' : '[EMPTY]',
        processId: process.pid
      });
      
      // Exit with error code
      process.exit(1);
    }
  }
  
  /**
   * Get authorized address (obfuscated)
   */
  static getAuthorizedAddress() {
    // Only return if already validated
    if (process.env._ADDRESS_VALIDATED === 'true') {
      return AUTHORIZED_ADDRESS;
    }
    return null;
  }
  
  /**
   * Initialize validation
   */
  static initialize() {
    // Prevent tampering with validation
    Object.freeze(this);
    Object.freeze(this.prototype);
    
    // Set validation flag
    process.env._ADDRESS_VALIDATED = 'false';
    
    logger.info('Address validator initialized');
  }
}

// Initialize on load
AddressValidator.initialize();

// Prevent modifications
Object.freeze(AddressValidator);

module.exports = AddressValidator;