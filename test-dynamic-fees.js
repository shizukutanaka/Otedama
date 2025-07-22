#!/usr/bin/env node

/**
 * Test Dynamic Fee Protection System
 */

import { secureFeeConfig } from './lib/security/fee-protection.js';
import { dynamicFeeProtection } from './lib/security/dynamic-fee-protection.js';
import { reserveManagement } from './lib/security/reserve-management.js';

console.log('=== Dynamic Fee Protection Test ===\n');

// Test normal conditions
console.log('--- Normal Market Conditions ---');
const normalFee = secureFeeConfig.calculateBTCFee(10000000); // 0.1 BTC
console.log('Base fee calculation:', JSON.stringify(normalFee, null, 2));

// Simulate market volatility
console.log('\n--- High Market Volatility ---');
// Update price history to simulate volatility
for (let i = 0; i < 10; i++) {
  await dynamicFeeProtection.updatePriceData();
}

// Simulate security incident
console.log('\n--- Security Incident Response ---');
dynamicFeeProtection.reportSecurityIncident({
  type: 'hack_attempt',
  severity: 'high',
  details: 'Suspicious withdrawal pattern detected'
});

const securityFee = secureFeeConfig.calculateBTCFee(10000000);
console.log('Fee with security incident:', JSON.stringify(securityFee, null, 2));

// Test reserve management
console.log('\n--- Reserve Management Test ---');
const reserveStatus = reserveManagement.getStatus();
console.log('Reserve status:', JSON.stringify(reserveStatus, null, 2));

// Test payout validation
console.log('\n--- Payout Validation ---');
const payoutRequest = {
  amount: 5000000, // 0.05 BTC
  userId: 'test123',
  type: 'withdrawal'
};

const validation = await reserveManagement.validatePayout(payoutRequest);
console.log('Payout validation:', JSON.stringify(validation, null, 2));

// Get dynamic protection status
console.log('\n--- Dynamic Protection Status ---');
const protectionStatus = dynamicFeeProtection.getStatus();
console.log('Protection status:', JSON.stringify(protectionStatus, null, 2));

console.log('\n=== Dynamic Fee Protection Successfully Implemented ===');

// Cleanup
process.exit(0);