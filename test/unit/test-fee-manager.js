/**
 * Fee Manager Unit Tests
 */

import { assert, assertEquals, assertThrows } from '../run-tests.js';

// Mock database
class MockDatabase {
  constructor() {
    this.tables = new Map();
  }
  
  prepare(query) {
    return {
      run: (...args) => ({ lastInsertRowid: 1, changes: 1 }),
      get: () => null,
      all: () => []
    };
  }
}

// Mock config
class MockConfig {
  get(key) {
    const config = {
      'pool.fee': 1.0
    };
    return config[key];
  }
}

export async function runTests() {
  // Test 1: Immutable operator address
  await testImmutableOperatorAddress();
  
  // Test 2: Immutable fee rate
  await testImmutableFeeRate();
  
  // Test 3: Fee collection
  await testFeeCollection();
  
  // Test 4: System integrity
  await testSystemIntegrity();
}

async function testImmutableOperatorAddress() {
  const { FeeManager } = await import('../../src/fee-manager.js');
  const config = new MockConfig();
  const db = new MockDatabase();
  const feeManager = new FeeManager(config, db);
  
  // Test that operator address cannot be changed
  const originalAddress = feeManager.getOperatorAddress();
  assertEquals(
    originalAddress,
    'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    'Operator address should be predefined'
  );
  
  // Try to change address
  assertThrows(
    () => feeManager.setOperatorAddress('bc1qDifferentAddress'),
    'cannot be changed',
    'Should not allow changing operator address'
  );
  
  // Verify address unchanged
  assertEquals(
    feeManager.getOperatorAddress(),
    originalAddress,
    'Operator address should remain unchanged'
  );
  
  feeManager.stop();
}

async function testImmutableFeeRate() {
  const { FeeManager } = await import('../../src/fee-manager.js');
  const config = new MockConfig();
  const db = new MockDatabase();
  const feeManager = new FeeManager(config, db);
  
  // Test that fee rate cannot be changed
  const originalRate = feeManager.getOperatorFeeRate();
  assertEquals(originalRate, 0.001, 'Fee rate should be 0.1%');
  
  // Try to change rate
  assertThrows(
    () => feeManager.setOperatorFeeRate(0.002),
    'cannot be changed',
    'Should not allow changing fee rate'
  );
  
  // Verify rate unchanged
  assertEquals(
    feeManager.getOperatorFeeRate(),
    originalRate,
    'Fee rate should remain unchanged'
  );
  
  feeManager.stop();
}

async function testFeeCollection() {
  const { FeeManager } = await import('../../src/fee-manager.js');
  const config = new MockConfig();
  const db = new MockDatabase();
  const feeManager = new FeeManager(config, db);
  
  // Test fee collection
  const rewardAmount = 1000000000; // 10 coins
  const currency = 'RVN';
  
  const feeCollected = await feeManager.collectOperatorFee(rewardAmount, currency);
  
  assertEquals(
    feeCollected,
    Math.floor(rewardAmount * 0.001),
    'Should collect 0.1% fee'
  );
  
  // Check fee balance
  const stats = feeManager.getStats();
  assert(stats.pendingFees[currency] > 0, 'Should have pending fees');
  
  feeManager.stop();
}

async function testSystemIntegrity() {
  const { FeeManager } = await import('../../src/fee-manager.js');
  const config = new MockConfig();
  const db = new MockDatabase();
  const feeManager = new FeeManager(config, db);
  
  // Test integrity check
  const integrity = feeManager.verifyIntegrity();
  assert(integrity === true, 'System integrity should pass');
  
  // Verify all critical components
  assertEquals(
    feeManager.OPERATOR_BTC_ADDRESS,
    'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    'Operator address constant should be correct'
  );
  
  assertEquals(
    feeManager.OPERATOR_FEE_RATE,
    0.001,
    'Fee rate constant should be correct'
  );
  
  feeManager.stop();
}

export default runTests;
