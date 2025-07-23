/**
 * Runtime Protection
 * Prevents runtime modification of critical values
 */

const crypto = require('crypto');
const { createLogger } = require('../core/logger');

const logger = createLogger('runtime-protection');

// Critical values that must not be modified
const PROTECTED_VALUES = {
  CREATOR_ADDRESS: '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa',
  MIN_FEE_PERCENT: 0.3,
  MAX_FEE_PERCENT: 0.9
};

// Calculate checksums
const CHECKSUMS = {};
for (const [key, value] of Object.entries(PROTECTED_VALUES)) {
  CHECKSUMS[key] = crypto.createHash('sha256')
    .update(String(value))
    .digest('hex');
}

class RuntimeProtection {
  /**
   * Initialize protection
   */
  static initialize() {
    // Protect environment variables
    this.protectEnvironment();
    
    // Set up interval checking
    this.startIntegrityChecks();
    
    // Freeze critical objects
    this.freezeCriticalObjects();
    
    logger.info('Runtime protection initialized');
  }
  
  /**
   * Protect environment variables
   */
  static protectEnvironment() {
    // Override creator address if set incorrectly
    if (process.env.CREATOR_WALLET_ADDRESS && 
        process.env.CREATOR_WALLET_ADDRESS !== PROTECTED_VALUES.CREATOR_ADDRESS) {
      logger.error('Invalid CREATOR_WALLET_ADDRESS detected, overriding');
      process.env.CREATOR_WALLET_ADDRESS = PROTECTED_VALUES.CREATOR_ADDRESS;
    }
    
    // Set if not exists
    if (!process.env.CREATOR_WALLET_ADDRESS) {
      process.env.CREATOR_WALLET_ADDRESS = PROTECTED_VALUES.CREATOR_ADDRESS;
    }
    
    // Prevent modification using defineProperty
    try {
      Object.defineProperty(process.env, 'CREATOR_WALLET_ADDRESS', {
        value: PROTECTED_VALUES.CREATOR_ADDRESS,
        writable: false,
        configurable: false,
        enumerable: true
      });
    } catch (e) {
      // Some environments don't support this
    }
  }
  
  /**
   * Start integrity checks
   */
  static startIntegrityChecks() {
    // Check every 30 seconds
    setInterval(() => {
      this.verifyIntegrity();
    }, 30000);
    
    // Also check on various events
    process.on('beforeExit', () => this.verifyIntegrity());
  }
  
  /**
   * Verify integrity of protected values
   */
  static verifyIntegrity() {
    // Check environment variable
    if (process.env.CREATOR_WALLET_ADDRESS !== PROTECTED_VALUES.CREATOR_ADDRESS) {
      logger.error('Runtime modification detected!', {
        expected: PROTECTED_VALUES.CREATOR_ADDRESS,
        found: process.env.CREATOR_WALLET_ADDRESS
      });
      
      // Force exit
      console.error('\n\n!!! SECURITY VIOLATION DETECTED !!!\n');
      console.error('Unauthorized modification of protected values.');
      console.error('The application will now terminate.\n\n');
      process.exit(1);
    }
    
    // Verify checksums
    for (const [key, value] of Object.entries(PROTECTED_VALUES)) {
      const currentChecksum = crypto.createHash('sha256')
        .update(String(value))
        .digest('hex');
        
      if (currentChecksum !== CHECKSUMS[key]) {
        logger.error('Checksum mismatch detected!', { key });
        process.exit(1);
      }
    }
  }
  
  /**
   * Freeze critical objects
   */
  static freezeCriticalObjects() {
    // Freeze this class
    Object.freeze(this);
    Object.freeze(this.prototype);
    
    // Freeze protected values
    Object.freeze(PROTECTED_VALUES);
    Object.freeze(CHECKSUMS);
  }
  
  /**
   * Get protected value
   */
  static getProtectedValue(key) {
    this.verifyIntegrity();
    return PROTECTED_VALUES[key];
  }
  
  /**
   * Validate fee percentage
   */
  static validateFeePercentage(fee) {
    if (fee < PROTECTED_VALUES.MIN_FEE_PERCENT || fee > PROTECTED_VALUES.MAX_FEE_PERCENT) {
      logger.error('Invalid fee percentage', { fee });
      return false;
    }
    return true;
  }
}

// Initialize immediately
RuntimeProtection.initialize();

// Prevent any modifications
Object.freeze(RuntimeProtection);

module.exports = RuntimeProtection;