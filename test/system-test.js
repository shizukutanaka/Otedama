/**
 * Comprehensive System Test for Otedama
 * Tests the complete mining pool with ZKP integration
 * 
 * Following Pike's principle: test the real system
 */

import { createStructuredLogger } from '../lib/core/structured-logger.js';
import { EnhancedZKPSystem } from '../lib/zkp/enhanced-zkp-system.js';
import { WorkerPool } from '../lib/core/worker-pool.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createStructuredLogger('SystemTest');

// Test configuration
const TEST_CONFIG = {
  zkp: {
    dbFile: path.join(__dirname, '../data/test-zkp.db'),
    minAge: 18,
    proofExpiry: 300000 // 5 minutes for testing
  },
  workers: {
    mining: {
      workerPath: path.join(__dirname, '../lib/workers/mining-worker.js'),
      minWorkers: 2,
      maxWorkers: 4
    },
    validation: {
      workerPath: path.join(__dirname, '../lib/workers/validation-worker.js'),
      minWorkers: 1,
      maxWorkers: 2
    },
    zkp: {
      workerPath: path.join(__dirname, '../lib/workers/zkp-worker.js'),
      minWorkers: 1,
      maxWorkers: 2
    }
  }
};

/**
 * Test Results
 */
class TestResults {
  constructor() {
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
    this.startTime = Date.now();
  }
  
  addTest(name, passed, details = {}) {
    this.tests.push({
      name,
      passed,
      details,
      duration: Date.now() - this.startTime
    });
    
    if (passed) {
      this.passed++;
      logger.info(`✓ ${name}`, details);
    } else {
      this.failed++;
      logger.error(`✗ ${name}`, details);
    }
  }
  
  summary() {
    const total = this.passed + this.failed;
    const duration = Date.now() - this.startTime;
    
    console.log('\n' + '='.repeat(50));
    console.log('TEST SUMMARY');
    console.log('='.repeat(50));
    console.log(`Total Tests: ${total}`);
    console.log(`Passed: ${this.passed} (${((this.passed/total)*100).toFixed(1)}%)`);
    console.log(`Failed: ${this.failed}`);
    console.log(`Duration: ${(duration/1000).toFixed(2)}s`);
    console.log('='.repeat(50) + '\n');
    
    if (this.failed > 0) {
      console.log('Failed Tests:');
      this.tests.filter(t => !t.passed).forEach(t => {
        console.log(`  - ${t.name}: ${t.details.error || 'Unknown error'}`);
      });
    }
    
    return this.failed === 0;
  }
}

/**
 * Test ZKP System
 */
async function testZKPSystem(results) {
  logger.info('Testing ZKP System...');
  
  let zkpSystem = null;
  
  try {
    // Initialize ZKP system
    zkpSystem = new EnhancedZKPSystem(TEST_CONFIG.zkp);
    await zkpSystem.initialize();
    results.addTest('ZKP System Initialization', true);
    
    // Test 1: Create identity proof
    const identityProof = await zkpSystem.createIdentityProof({
      age: 25,
      location: { lat: 40.7128, lng: -74.0060 },
      balance: 5000,
      reputation: 85
    });
    
    results.addTest('Create Identity Proof', 
      identityProof && identityProof.id && identityProof.proofs,
      { proofId: identityProof.id }
    );
    
    // Test 2: Verify identity proof
    const verificationResult = await zkpSystem.verifyIdentityProof(identityProof, {
      age: { min: 18 },
      location: { allowed: true },
      balance: { min: 1000 },
      reputation: { min: 50 }
    });
    
    results.addTest('Verify Identity Proof', 
      verificationResult.verified === true,
      verificationResult
    );
    
    // Test 3: Invalid proof verification
    const invalidVerification = await zkpSystem.verifyIdentityProof(identityProof, {
      age: { min: 30 } // Should fail since proof is for age 25
    });
    
    results.addTest('Reject Invalid Requirements', 
      invalidVerification.verified === false,
      invalidVerification
    );
    
    // Test 4: Issue credential
    const credential = await zkpSystem.issueCredential('testuser123', {
      minerStatus: 'verified',
      poolMember: true,
      tier: 'gold'
    });
    
    results.addTest('Issue Anonymous Credential', 
      credential && credential.attributes,
      { attributes: credential.attributes.size }
    );
    
    // Test 5: Create confidential transaction
    const tx = await zkpSystem.createTransaction(
      1000, // amount
      'sender123',
      'recipient456'
    );
    
    results.addTest('Create Confidential Transaction', 
      tx && tx.commitment && tx.rangeProof,
      { txId: tx.id }
    );
    
    // Test 6: Verify transaction
    const txVerification = await zkpSystem.verifyTransaction(tx);
    
    results.addTest('Verify Confidential Transaction', 
      txVerification.valid === true,
      txVerification
    );
    
    // Test 7: Statistics
    const stats = await zkpSystem.getStatistics();
    
    results.addTest('ZKP Statistics', 
      stats && stats.database && stats.runtime,
      stats
    );
    
  } catch (error) {
    results.addTest('ZKP System Error', false, { error: error.message });
  } finally {
    if (zkpSystem) {
      await zkpSystem.shutdown();
    }
  }
}

/**
 * Test Worker Pools
 */
async function testWorkerPools(results) {
  logger.info('Testing Worker Pools...');
  
  const pools = {
    mining: null,
    validation: null,
    zkp: null
  };
  
  try {
    // Test Mining Worker Pool
    pools.mining = new WorkerPool(TEST_CONFIG.workers.mining);
    await pools.mining.initialize();
    results.addTest('Mining Worker Pool Initialization', true);
    
    // Test mining task
    const miningResult = await pools.mining.execute({
      type: 'mine',
      job: {
        blockHeader: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
        target: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        startNonce: 0,
        endNonce: 1000
      }
    });
    
    results.addTest('Mining Task Execution', 
      miningResult && typeof miningResult.hashCount === 'number',
      { hashCount: miningResult.hashCount }
    );
    
    // Test Validation Worker Pool
    pools.validation = new WorkerPool(TEST_CONFIG.workers.validation);
    await pools.validation.initialize();
    results.addTest('Validation Worker Pool Initialization', true);
    
    // Test validation task
    const validationResult = await pools.validation.execute({
      type: 'validate',
      params: {
        share: {
          jobId: 'test-job-1',
          nonce: 12345,
          minerId: 'miner-1',
          timestamp: Date.now()
        },
        job: {
          id: 'test-job-1',
          version: '00000020',
          previousHash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
          merkleRoot: '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b',
          timestamp: '495fab29',
          bits: '1d00ffff'
        },
        difficulty: 1,
        algorithm: 'sha256d'
      }
    });
    
    results.addTest('Validation Task Execution', 
      validationResult && typeof validationResult.valid === 'boolean',
      validationResult
    );
    
    // Test ZKP Worker Pool
    pools.zkp = new WorkerPool(TEST_CONFIG.workers.zkp);
    await pools.zkp.initialize();
    results.addTest('ZKP Worker Pool Initialization', true);
    
    // Test ZKP task
    const zkpResult = await pools.zkp.execute({
      type: 'range_proof',
      value: 100,
      min: 0,
      max: 1000,
      bits: 16
    });
    
    results.addTest('ZKP Range Proof Generation', 
      zkpResult && zkpResult.commitments && zkpResult.responses,
      { proofSize: zkpResult.size }
    );
    
    // Test pool statistics
    const miningStats = pools.mining.getStats();
    results.addTest('Worker Pool Statistics', 
      miningStats.workerCount >= TEST_CONFIG.workers.mining.minWorkers,
      miningStats
    );
    
    // Test auto-scaling
    const tasks = [];
    for (let i = 0; i < 10; i++) {
      tasks.push(pools.mining.execute({
        type: 'validate',
        share: {
          nonce: i,
          blockHeader: '00000020',
          difficulty: 1,
          algorithm: 'sha256'
        }
      }));
    }
    
    await Promise.all(tasks);
    
    const scaledStats = pools.mining.getStats();
    results.addTest('Worker Pool Auto-Scaling', 
      scaledStats.completedTasksCount >= 10,
      { completed: scaledStats.completedTasksCount }
    );
    
  } catch (error) {
    results.addTest('Worker Pool Error', false, { error: error.message });
  } finally {
    // Shutdown all pools
    for (const pool of Object.values(pools)) {
      if (pool) {
        await pool.shutdown();
      }
    }
  }
}

/**
 * Test Integration
 */
async function testIntegration(results) {
  logger.info('Testing System Integration...');
  
  let zkpSystem = null;
  let miningPool = null;
  
  try {
    // Initialize components
    zkpSystem = new EnhancedZKPSystem(TEST_CONFIG.zkp);
    await zkpSystem.initialize();
    
    miningPool = new WorkerPool(TEST_CONFIG.workers.mining);
    await miningPool.initialize();
    
    // Simulate miner with ZKP proof
    const minerProof = await zkpSystem.createIdentityProof({
      age: 21,
      location: { lat: 51.5074, lng: -0.1278 },
      balance: 10000
    });
    
    // Verify miner
    const minerVerification = await zkpSystem.verifyIdentityProof(minerProof, {
      age: { min: 18 },
      location: { allowed: true }
    });
    
    results.addTest('Miner ZKP Verification', 
      minerVerification.verified === true,
      { proofId: minerProof.id }
    );
    
    // Simulate mining
    const miningTask = await miningPool.execute({
      type: 'mine',
      job: {
        blockHeader: '00000020' + '0'.repeat(60),
        target: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        startNonce: 0,
        endNonce: 100
      }
    });
    
    results.addTest('Mining with ZKP Integration', 
      miningTask && miningTask.hashCount > 0,
      { hashCount: miningTask.hashCount }
    );
    
    // Test transaction compliance
    const txResult = await zkpSystem.verifyTransaction({
      id: 'test-tx-1',
      commitment: 'abc123',
      rangeProof: { /* mock proof */ },
      sender: 'miner1',
      recipient: 'pool',
      timestamp: Date.now()
    });
    
    results.addTest('Transaction Compliance Check', 
      typeof txResult.valid === 'boolean',
      txResult
    );
    
    // Generate compliance report
    const report = await zkpSystem.generateComplianceReport(1);
    
    results.addTest('Compliance Report Generation', 
      report && report.statistics,
      { period: report.period }
    );
    
  } catch (error) {
    results.addTest('Integration Error', false, { error: error.message });
  } finally {
    if (zkpSystem) await zkpSystem.shutdown();
    if (miningPool) await miningPool.shutdown();
  }
}

/**
 * Performance Tests
 */
async function testPerformance(results) {
  logger.info('Testing Performance...');
  
  let zkpSystem = null;
  
  try {
    zkpSystem = new EnhancedZKPSystem(TEST_CONFIG.zkp);
    await zkpSystem.initialize();
    
    // Test 1: ZKP proof generation speed
    const proofTimes = [];
    for (let i = 0; i < 10; i++) {
      const start = Date.now();
      await zkpSystem.createIdentityProof({
        age: 20 + i,
        location: { lat: 40 + i * 0.1, lng: -74 - i * 0.1 }
      });
      proofTimes.push(Date.now() - start);
    }
    
    const avgProofTime = proofTimes.reduce((a, b) => a + b) / proofTimes.length;
    
    results.addTest('ZKP Proof Generation Performance', 
      avgProofTime < 100, // Should be under 100ms
      { avgTime: avgProofTime.toFixed(2) + 'ms' }
    );
    
    // Test 2: Verification speed
    const proof = await zkpSystem.createIdentityProof({
      age: 25,
      balance: 5000
    });
    
    const verifyTimes = [];
    for (let i = 0; i < 10; i++) {
      const start = Date.now();
      await zkpSystem.verifyIdentityProof(proof, {
        age: { min: 18 },
        balance: { min: 1000 }
      });
      verifyTimes.push(Date.now() - start);
    }
    
    const avgVerifyTime = verifyTimes.reduce((a, b) => a + b) / verifyTimes.length;
    
    results.addTest('ZKP Verification Performance', 
      avgVerifyTime < 50, // Should be under 50ms
      { avgTime: avgVerifyTime.toFixed(2) + 'ms' }
    );
    
    // Test 3: Memory usage
    const memBefore = process.memoryUsage().heapUsed;
    
    // Create many proofs
    const proofs = [];
    for (let i = 0; i < 100; i++) {
      proofs.push(await zkpSystem.createIdentityProof({
        age: 18 + (i % 50),
        reputation: i
      }));
    }
    
    const memAfter = process.memoryUsage().heapUsed;
    const memUsed = (memAfter - memBefore) / 1024 / 1024; // MB
    
    results.addTest('Memory Usage for 100 Proofs', 
      memUsed < 100, // Should use less than 100MB
      { memoryMB: memUsed.toFixed(2) }
    );
    
  } catch (error) {
    results.addTest('Performance Test Error', false, { error: error.message });
  } finally {
    if (zkpSystem) await zkpSystem.shutdown();
  }
}

/**
 * Main test runner
 */
async function runTests() {
  console.log('\n' + '='.repeat(50));
  console.log('OTEDAMA SYSTEM TEST');
  console.log('='.repeat(50) + '\n');
  
  const results = new TestResults();
  
  try {
    // Run test suites
    await testZKPSystem(results);
    await testWorkerPools(results);
    await testIntegration(results);
    await testPerformance(results);
    
  } catch (error) {
    logger.error('Test runner error', error);
  }
  
  // Display summary
  const success = results.summary();
  
  // Exit with appropriate code
  process.exit(success ? 0 : 1);
}

// Run tests
runTests().catch(error => {
  console.error('Fatal test error:', error);
  process.exit(1);
});
