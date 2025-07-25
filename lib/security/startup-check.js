/**
 * Startup Security Check
 * Verifies integrity on application startup
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Authorized configuration
const AUTHORIZED_CONFIG = {
  address: '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa',
  hash: 'a7d9c4f2b3e1m5h8k9j2n4p6q8r1s3t5v7w9x2y4z6'
};

class StartupCheck {
  /**
   * Run startup checks
   */
  static async runChecks() {
    console.log('\n╔════════════════════════════════════════════╗');
    console.log('║        Otedama Security Check v1.0         ║');
    console.log('╚════════════════════════════════════════════╝\n');
    
    // Check 1: Creator address validation
    console.log('✓ Validating creator address...');
    const addressValid = this.checkCreatorAddress();
    
    if (!addressValid) {
      this.showSecurityError();
      return false;
    }
    
    // Check 2: File integrity
    console.log('✓ Checking file integrity...');
    const filesValid = await this.checkFileIntegrity();
    
    if (!filesValid) {
      this.showSecurityError();
      return false;
    }
    
    // Check 3: Environment validation
    console.log('✓ Validating environment...');
    const envValid = this.checkEnvironment();
    
    if (!envValid) {
      this.showSecurityError();
      return false;
    }
    
    console.log('✓ All security checks passed!\n');
    console.log('╔════════════════════════════════════════════╗');
    console.log('║         Starting Otedama Mining Pool       ║');
    console.log('║                                            ║');
    console.log('║  Creator Fee: 0.3-0.9% (Industry Lowest)   ║');
    console.log('║  Languages: 100+ Supported                 ║');
    console.log('║  Address: ' + AUTHORIZED_CONFIG.address.substring(0, 8) + '...' + AUTHORIZED_CONFIG.address.substring(30) + '    ║');
    console.log('╚════════════════════════════════════════════╝\n');
    
    return true;
  }
  
  /**
   * Check creator address
   */
  static checkCreatorAddress() {
    const envAddress = process.env.CREATOR_WALLET_ADDRESS;
    
    // Check environment variable
    if (envAddress && envAddress !== AUTHORIZED_CONFIG.address) {
      console.error('\n✗ Invalid creator address in environment variable');
      return false;
    }
    
    // Check quick-start scripts
    const files = ['quick-start.bat', 'quick-start.sh'];
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        if (!content.includes(AUTHORIZED_CONFIG.address)) {
          console.error(`\n✗ Invalid creator address in ${file}`);
          return false;
        }
      } catch (e) {
        // File might not exist, that's ok
      }
    }
    
    return true;
  }
  
  /**
   * Check file integrity
   */
  static async checkFileIntegrity() {
    const criticalFiles = [
      'lib/security/address-validator.js',
      'lib/security/runtime-protection.js',
      'lib/fees/creator-fee-manager.js'
    ];
    
    for (const file of criticalFiles) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        if (!content.includes(AUTHORIZED_CONFIG.address)) {
          console.error(`\n✗ File integrity check failed: ${file}`);
          return false;
        }
      } catch (e) {
        console.error(`\n✗ Critical file missing: ${file}`);
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Check environment
   */
  static checkEnvironment() {
    // Set correct address if not set
    if (!process.env.CREATOR_WALLET_ADDRESS) {
      process.env.CREATOR_WALLET_ADDRESS = AUTHORIZED_CONFIG.address;
    }
    
    // Verify it matches
    if (process.env.CREATOR_WALLET_ADDRESS !== AUTHORIZED_CONFIG.address) {
      console.error('\n✗ Environment validation failed');
      return false;
    }
    
    return true;
  }
  
  /**
   * Show security error
   */
  static showSecurityError() {
    console.error('\n');
    console.error('╔═══════════════════════════════════════════════════════════════╗');
    console.error('║                    SECURITY CHECK FAILED                       ║');
    console.error('╠═══════════════════════════════════════════════════════════════╣');
    console.error('║                                                               ║');
    console.error('║  The application detected unauthorized modifications.         ║');
    console.error('║                                                               ║');
    console.error('║  This software is licensed with specific parameters that     ║');
    console.error('║  cannot be modified. The creator address is part of the      ║');
    console.error('║  licensing agreement and ensures sustainable development.     ║');
    console.error('║                                                               ║');
    console.error('║  To resolve this issue:                                       ║');
    console.error('║  1. Restore original files from GitHub                       ║');
    console.error('║  2. Do not modify creator address settings                   ║');
    console.error('║  3. Contact support if you need assistance                   ║');
    console.error('║                                                               ║');
    console.error('║  GitHub: https://github.com/otedama/otedama                  ║');
    console.error('║                                                               ║');
    console.error('╚═══════════════════════════════════════════════════════════════╝');
    console.error('\n');
  }
}

module.exports = StartupCheck;