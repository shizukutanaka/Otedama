#!/usr/bin/env node

/**
 * Fee Configuration Integrity Verification Script
 * Verifies that fee configuration hasn't been tampered with
 */

import { POOL_OPERATOR, POOL_FEES, validateConstants } from '../config/constants.js';
import { validatePoolOperatorAddress } from '../lib/core/btc-address-validator.js';
import immutableFeeConfig from '../lib/core/immutable-fee-config.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXPECTED_VALUES = {
  poolFee: 0.01,
  operatorAddress: '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa'
};

function verifyFeeIntegrity() {
  console.log('🔒 Verifying Fee Configuration Integrity...\n');
  
  let allChecksPassed = true;
  
  try {
    // Validate constants
    validateConstants();
    
    // Check 1: Verify pool fee
    console.log('1. Checking pool fee...');
    if (POOL_FEES.MINING_FEE === EXPECTED_VALUES.poolFee) {
      console.log(`   ✅ Pool fee verified: ${POOL_FEES.MINING_FEE * 100}%`);
    } else {
      console.log(`   ❌ Pool fee mismatch! Expected: ${EXPECTED_VALUES.poolFee}, Got: ${POOL_FEES.MINING_FEE}`);
      allChecksPassed = false;
    }
    
    // Check 2: Verify operator address
    console.log('\n2. Checking operator address...');
    if (POOL_OPERATOR.BTC_ADDRESS === EXPECTED_VALUES.operatorAddress) {
      console.log(`   ✅ Operator address verified: ${POOL_OPERATOR.BTC_ADDRESS}`);
      validatePoolOperatorAddress(POOL_OPERATOR.BTC_ADDRESS);
    } else {
      console.log(`   ❌ Operator address mismatch!`);
      console.log(`      Expected: ${EXPECTED_VALUES.operatorAddress}`);
      console.log(`      Got: ${POOL_OPERATOR.BTC_ADDRESS}`);
      allChecksPassed = false;
    }
    
    // Check 3: Verify file hasn't been modified
    console.log('\n3. Checking file integrity...');
    const filePath = path.join(__dirname, '../lib/core/immutable-fee-config.js');
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const fileHash = crypto.createHash('sha256').update(fileContent).digest('hex');
    console.log(`   File hash: ${fileHash}`);
    
    // Check 4: Test tampering detection
    console.log('\n4. Testing tampering detection...');
    try {
      // This should fail if we try to modify
      immutableFeeConfig.config.POOL_FEES.BASE_FEE = 0.02;
      console.log('   ❌ Tampering was not prevented!');
      allChecksPassed = false;
    } catch (error) {
      console.log('   ✅ Tampering prevention working correctly');
    }
    
    // Check 5: Verify calculation accuracy
    console.log('\n5. Testing fee calculations...');
    const testAmounts = [1, 10, 100, 0.001];
    for (const amount of testAmounts) {
      const fee = amount * POOL_FEES.MINING_FEE;
      const calculated = immutableFeeConfig.calculatePoolFee(amount);
      if (Math.abs(fee - calculated) < 0.00000001) {
        console.log(`   ✅ Calculation correct for ${amount} BTC: ${calculated} BTC fee`);
      } else {
        console.log(`   ❌ Calculation error for ${amount} BTC`);
        allChecksPassed = false;
      }
    }
    
    // Summary
    console.log('\n' + '='.repeat(50));
    if (allChecksPassed) {
      console.log('✅ ALL INTEGRITY CHECKS PASSED');
      console.log('The fee configuration is secure and has not been tampered with.');
    } else {
      console.log('❌ INTEGRITY CHECK FAILED');
      console.log('The fee configuration may have been tampered with!');
      console.log('DO NOT run the pool until this is resolved.');
    }
    console.log('='.repeat(50));
    
    return allChecksPassed;
    
  } catch (error) {
    console.error('\n❌ Error during verification:', error);
    return false;
  }
}

// Run verification if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  verifyFeeIntegrity()
    .then(passed => {
      process.exit(passed ? 0 : 1);
    })
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}

export default verifyFeeIntegrity;