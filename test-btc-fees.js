#!/usr/bin/env node

/**
 * Test BTC Fee System
 */

import { secureFeeConfig, feeCalculator } from './lib/security/fee-protection.js';

console.log('=== BTC Fee System Test ===');

// Test small transaction (0.0005 BTC = 50,000 satoshis)
console.log('\n--- Small Transaction (0.0005 BTC) ---');
const smallTx = secureFeeConfig.calculateBTCFee(50000);
console.log(JSON.stringify(smallTx, null, 2));

// Test medium transaction (0.01 BTC = 1,000,000 satoshis)
console.log('\n--- Medium Transaction (0.01 BTC) ---');
const mediumTx = secureFeeConfig.calculateBTCFee(1000000);
console.log(JSON.stringify(mediumTx, null, 2));

// Test large transaction (0.1 BTC = 10,000,000 satoshis)
console.log('\n--- Large Transaction (0.1 BTC) ---');
const largeTx = secureFeeConfig.calculateBTCFee(10000000);
console.log(JSON.stringify(largeTx, null, 2));

// Test BTC fee transparency report
console.log('\n--- BTC Fee Transparency Report ---');
const report = secureFeeConfig.getFeeTransparencyReport();
console.log('Current Fee Structure:');
console.log(JSON.stringify(report.currentFee, null, 2));
console.log('\nBTC Fee Structure:');
console.log(JSON.stringify(report.btcFeeStructure, null, 2));

// Test fee calculator
console.log('\n--- Fee Calculator Tests ---');
const poolFee = feeCalculator.calculatePoolFees(1000000); // 0.01 BTC
console.log('Pool Fee for 0.01 BTC:');
console.log(JSON.stringify(poolFee, null, 2));

const txFee = feeCalculator.calculateBTCTransactionFees(5000000); // 0.05 BTC
console.log('\nTransaction Fee for 0.05 BTC:');
console.log(JSON.stringify(txFee, null, 2));

console.log('\n=== BTC Fee System Successfully Updated ===');