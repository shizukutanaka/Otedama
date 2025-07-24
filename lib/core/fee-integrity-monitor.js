/**
 * Fee Integrity Monitor
 * Monitors and enforces fee configuration integrity at runtime
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { createLogger } = require('./logger');

const logger = createLogger('fee-integrity-monitor');

class FeeIntegrityMonitor extends EventEmitter {
  constructor() {
    super();
    
    this.monitoringActive = false;
    this.checkInterval = null;
    this.violations = [];
    this.expectedConfig = null;
    this.checksum = null;
  }
  
  /**
   * Start monitoring fee configuration
   */
  async startMonitoring(feeConfig, interval = 60000) {
    if (this.monitoringActive) {
      logger.warn('Fee integrity monitoring already active');
      return;
    }
    
    try {
      // Store expected configuration
      this.expectedConfig = {
        poolFee: feeConfig.getPoolFee(),
        withdrawalFee: feeConfig.getWithdrawalFee(),
        operatorAddress: feeConfig.getOperatorAddress(),
        signature: feeConfig.getConfigSignature()
      };
      
      // Calculate initial checksum
      this.checksum = this.calculateChecksum(this.expectedConfig);
      
      // Start periodic checks
      this.checkInterval = setInterval(() => {
        this.performIntegrityCheck(feeConfig);
      }, interval);
      
      this.monitoringActive = true;
      
      logger.info('Fee integrity monitoring started');
      this.emit('monitoring-started', {
        checksum: this.checksum,
        interval
      });
      
    } catch (error) {
      logger.error('Failed to start fee integrity monitoring:', error);
      throw error;
    }
  }
  
  /**
   * Stop monitoring
   */
  stopMonitoring() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    
    this.monitoringActive = false;
    logger.info('Fee integrity monitoring stopped');
    this.emit('monitoring-stopped');
  }
  
  /**
   * Perform integrity check
   */
  performIntegrityCheck(feeConfig) {
    try {
      // Get current configuration
      const currentConfig = {
        poolFee: feeConfig.getPoolFee(),
        withdrawalFee: feeConfig.getWithdrawalFee(),
        operatorAddress: feeConfig.getOperatorAddress(),
        signature: feeConfig.getConfigSignature()
      };
      
      // Calculate current checksum
      const currentChecksum = this.calculateChecksum(currentConfig);
      
      // Compare with expected
      if (currentChecksum !== this.checksum) {
        this.handleIntegrityViolation({
          type: 'checksum_mismatch',
          expected: this.checksum,
          actual: currentChecksum,
          details: this.findDifferences(this.expectedConfig, currentConfig)
        });
        return false;
      }
      
      // Verify individual components
      if (currentConfig.poolFee !== this.expectedConfig.poolFee) {
        this.handleIntegrityViolation({
          type: 'pool_fee_tampered',
          expected: this.expectedConfig.poolFee,
          actual: currentConfig.poolFee
        });
        return false;
      }
      
      if (currentConfig.operatorAddress !== this.expectedConfig.operatorAddress) {
        this.handleIntegrityViolation({
          type: 'operator_address_tampered',
          expected: this.expectedConfig.operatorAddress,
          actual: currentConfig.operatorAddress
        });
        return false;
      }
      
      return true;
      
    } catch (error) {
      logger.error('Integrity check failed:', error);
      this.handleIntegrityViolation({
        type: 'check_error',
        error: error.message
      });
      return false;
    }
  }
  
  /**
   * Handle integrity violation
   */
  handleIntegrityViolation(violation) {
    violation.timestamp = Date.now();
    this.violations.push(violation);
    
    logger.error('FEE INTEGRITY VIOLATION DETECTED!', violation);
    
    // Emit critical alert
    this.emit('integrity-violation', violation);
    
    // Take protective action based on violation type
    switch (violation.type) {
      case 'pool_fee_tampered':
      case 'operator_address_tampered':
        // Critical violation - shut down pool
        this.emit('critical-violation', {
          action: 'shutdown',
          reason: 'Fee configuration has been tampered with',
          violation
        });
        break;
        
      case 'checksum_mismatch':
        // Potential tampering - alert and monitor
        this.emit('security-alert', {
          level: 'high',
          message: 'Fee configuration checksum mismatch detected',
          violation
        });
        break;
        
      default:
        // Unknown violation - log and alert
        this.emit('security-alert', {
          level: 'medium',
          message: 'Unknown fee configuration issue detected',
          violation
        });
    }
  }
  
  /**
   * Calculate checksum of configuration
   */
  calculateChecksum(config) {
    const data = JSON.stringify(config, Object.keys(config).sort());
    return crypto.createHash('sha256').update(data).digest('hex');
  }
  
  /**
   * Find differences between configurations
   */
  findDifferences(expected, actual) {
    const differences = {};
    
    for (const key in expected) {
      if (expected[key] !== actual[key]) {
        differences[key] = {
          expected: expected[key],
          actual: actual[key]
        };
      }
    }
    
    return differences;
  }
  
  /**
   * Get violation history
   */
  getViolations() {
    return [...this.violations];
  }
  
  /**
   * Clear violation history
   */
  clearViolations() {
    this.violations = [];
  }
  
  /**
   * Get monitoring status
   */
  getStatus() {
    return {
      active: this.monitoringActive,
      checksum: this.checksum,
      violationCount: this.violations.length,
      lastViolation: this.violations[this.violations.length - 1] || null
    };
  }
}

// Export singleton instance
module.exports = new FeeIntegrityMonitor();