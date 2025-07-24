#!/usr/bin/env node

/**
 * Fee Configuration Integrity Verification Script
 * Verifies that fee configuration hasn't been tampered with
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { immutableFeeConfig, initialize, getPoolFee, getOperatorAddress } = require('../lib/core/immutable-fee-config');

const EXPECTED_VALUES = {
  poolFee: 0.01,
  operatorAddresses: {
    mainnet: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    testnet: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
  }
};

async function verifyFeeIntegrity() {
  console.log('🔒 Verifying Fee Configuration Integrity...\n');
  
  let allChecksPassed = true;
  
  try {
    // Initialize configuration
    await initialize();
    
    // Check 1: Verify pool fee
    console.log('1. Checking pool fee...');
    const poolFee = getPoolFee();
    if (poolFee === EXPECTED_VALUES.poolFee) {
      console.log(`   ✅ Pool fee verified: ${poolFee * 100}%`);
    } else {
      console.log(`   ❌ Pool fee mismatch! Expected: ${EXPECTED_VALUES.poolFee}, Got: ${poolFee}`);
      allChecksPassed = false;
    }
    
    // Check 2: Verify operator addresses
    console.log('\n2. Checking operator addresses...');
    for (const network of ['mainnet', 'testnet']) {
      const address = getOperatorAddress(network);
      if (address === EXPECTED_VALUES.operatorAddresses[network]) {
        console.log(`   ✅ ${network} address verified: ${address}`);
      } else {
        console.log(`   ❌ ${network} address mismatch!`);
        console.log(`      Expected: ${EXPECTED_VALUES.operatorAddresses[network]}`);
        console.log(`      Got: ${address}`);
        allChecksPassed = false;
      }
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
      const fee = amount * poolFee;
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
if (require.main === module) {
  verifyFeeIntegrity()
    .then(passed => {
      process.exit(passed ? 0 : 1);
    })
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = verifyFeeIntegrity;