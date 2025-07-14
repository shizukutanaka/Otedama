/**
 * Unified DEX Unit Tests
 */

import { UnifiedDEX } from '../../src/unified-dex.js';
import { assert, assertEquals, assertThrows } from '../run-tests.js';

// Mock fee manager
class MockFeeManager {
  getOperatorFeeRate() {
    return 0.001;
  }
  
  collectOperatorFee(amount, currency) {
    // Mock implementation
  }
}

export async function runTests() {
  const feeManager = new MockFeeManager();
  const dex = new UnifiedDEX(feeManager);
  
  // Test 1: Create V2 Pool
  testCreateV2Pool(dex);
  
  // Test 2: Create V3 Pool
  testCreateV3Pool(dex);
  
  // Test 3: Add V2 Liquidity
  testAddV2Liquidity(dex);
  
  // Test 4: Unified Swap
  testUnifiedSwap(dex);
  
  // Test 5: Pool Info
  testPoolInfo(dex);
  
  // Cleanup
  dex.stop();
}

function testCreateV2Pool(dex) {
  const result = dex.createV2Pool('BTC', 'USDT', 0.003);
  
  assert(!result.exists, 'Pool should not exist initially');
  assertEquals(result.version, 'v2', 'Should be V2 pool');
  assert(result.poolId, 'Should return pool ID');
  
  // Try creating same pool again
  const duplicate = dex.createV2Pool('BTC', 'USDT');
  assert(duplicate.exists, 'Duplicate pool should be detected');
}

function testCreateV3Pool(dex) {
  const sqrtPriceX96 = BigInt(Math.floor(Math.sqrt(43000) * 2 ** 96));
  const result = dex.createV3Pool('BTC', 'USDT', 500, sqrtPriceX96);
  
  assert(!result.exists, 'Pool should not exist initially');
  assertEquals(result.version, 'v3', 'Should be V3 pool');
  assert(result.poolKey, 'Should return pool key');
}

async function testAddV2Liquidity(dex) {
  // Create pool first
  dex.createV2Pool('ETH', 'USDT', 0.003);
  
  // Add liquidity
  const result = await dex.addLiquidity(
    'ETH',
    'USDT',
    '1000000000', // 10 ETH
    '25000000000', // 25000 USDT
    { version: 'v2', provider: 'test' }
  );
  
  assert(result.liquidity, 'Should return liquidity amount');
  assert(BigInt(result.liquidity) > BigInt(0), 'Liquidity should be positive');
}

async function testUnifiedSwap(dex) {
  // Setup pools with liquidity
  dex.createV2Pool('RVN', 'USDT', 0.003);
  await dex.addLiquidity(
    'RVN',
    'USDT',
    '100000000000', // 1000 RVN
    '30000000', // 30 USDT
    { version: 'v2', provider: 'test' }
  );
  
  // Test swap
  const result = await dex.swap(
    'RVN',
    'USDT',
    '1000000000', // 10 RVN
    0,
    'trader1'
  );
  
  assertEquals(result.tokenIn, 'RVN', 'Token in should be RVN');
  assertEquals(result.tokenOut, 'USDT', 'Token out should be USDT');
  assert(result.amountOut > BigInt(0), 'Should receive tokens');
  assert(result.fee > BigInt(0), 'Should charge fee');
}

function testPoolInfo(dex) {
  const info = dex.getPoolInfo('BTC', 'USDT');
  
  assert(info.v2, 'Should have V2 pool info');
  assert(info.v3.length > 0, 'Should have V3 pools');
  assert(info.totalLiquidity >= BigInt(0), 'Should have total liquidity');
}

export default runTests;
