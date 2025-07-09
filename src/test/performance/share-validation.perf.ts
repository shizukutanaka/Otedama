// Share validation performance tests
// Testing the most critical operation in a mining pool

import { perfTest } from './performance-test-framework';
import * as crypto from 'crypto';

/**
 * Mock share data for testing
 */
interface TestShare {
  jobId: string;
  nonce: string;
  time: number;
  extraNonce2: string;
  difficulty: number;
  previousBlockHash: string;
  merkleRoot: string;
}

/**
 * Share validation performance tests
 */
export class ShareValidationPerformance {
  private testShares: TestShare[] = [];
  
  constructor() {
    // Generate test data
    this.generateTestData();
  }

  /**
   * Generate test share data
   */
  private generateTestData(): void {
    for (let i = 0; i < 10000; i++) {
      this.testShares.push({
        jobId: crypto.randomBytes(8).toString('hex'),
        nonce: crypto.randomBytes(4).toString('hex'),
        time: Date.now() / 1000,
        extraNonce2: crypto.randomBytes(4).toString('hex'),
        difficulty: Math.pow(2, 10 + Math.random() * 10),
        previousBlockHash: crypto.randomBytes(32).toString('hex'),
        merkleRoot: crypto.randomBytes(32).toString('hex')
      });
    }
  }

  /**
   * Test basic share validation
   */
  async testBasicValidation(): Promise<void> {
    let index = 0;
    
    await perfTest.run(() => {
      const share = this.testShares[index % this.testShares.length];
      index++;
      
      // Simulate basic validation
      const isValid = 
        share.jobId.length === 16 &&
        share.nonce.length === 8 &&
        share.time > 0 &&
        share.difficulty > 0;
      
      return isValid;
    }, {
      name: 'Basic Share Validation',
      iterations: 100000,
      warmupIterations: 1000
    });
  }

  /**
   * Test hash calculation
   */
  async testHashCalculation(): Promise<void> {
    let index = 0;
    
    await perfTest.run(() => {
      const share = this.testShares[index % this.testShares.length];
      index++;
      
      // Simulate block header construction and hashing
      const header = Buffer.concat([
        Buffer.from(share.previousBlockHash, 'hex'),
        Buffer.from(share.merkleRoot, 'hex'),
        Buffer.from(share.nonce, 'hex'),
        Buffer.from(share.time.toString(16).padStart(8, '0'), 'hex')
      ]);
      
      // Double SHA-256 (Bitcoin style)
      const hash1 = crypto.createHash('sha256').update(header).digest();
      const hash2 = crypto.createHash('sha256').update(hash1).digest();
      
      return hash2;
    }, {
      name: 'Share Hash Calculation',
      iterations: 10000,
      warmupIterations: 100
    });
  }

  /**
   * Test difficulty check
   */
  async testDifficultyCheck(): Promise<void> {
    const targetCache = new Map<number, Buffer>();
    
    // Pre-calculate some targets
    for (let i = 10; i <= 20; i++) {
      const difficulty = Math.pow(2, i);
      const target = this.difficultyToTarget(difficulty);
      targetCache.set(difficulty, target);
    }
    
    let index = 0;
    
    await perfTest.run(() => {
      const share = this.testShares[index % this.testShares.length];
      index++;
      
      // Simulate hash
      const hash = crypto.randomBytes(32);
      
      // Get target for difficulty
      let target = targetCache.get(share.difficulty);
      if (!target) {
        target = this.difficultyToTarget(share.difficulty);
      }
      
      // Check if hash meets target
      return hash.compare(target) <= 0;
    }, {
      name: 'Difficulty Check',
      iterations: 100000,
      warmupIterations: 1000
    });
  }

  /**
   * Compare different validation strategies
   */
  async compareValidationStrategies(): Promise<void> {
    // Strategy A: Sequential validation
    const sequentialValidation = () => {
      const share = this.testShares[0];
      
      // Step 1: Basic checks
      if (share.jobId.length !== 16) return false;
      if (share.nonce.length !== 8) return false;
      if (share.time <= 0) return false;
      if (share.difficulty <= 0) return false;
      
      // Step 2: Hash calculation
      const header = Buffer.concat([
        Buffer.from(share.previousBlockHash, 'hex'),
        Buffer.from(share.merkleRoot, 'hex'),
        Buffer.from(share.nonce, 'hex'),
        Buffer.from(share.time.toString(16).padStart(8, '0'), 'hex')
      ]);
      
      const hash1 = crypto.createHash('sha256').update(header).digest();
      const hash2 = crypto.createHash('sha256').update(hash1).digest();
      
      // Step 3: Difficulty check
      const target = this.difficultyToTarget(share.difficulty);
      return hash2.compare(target) <= 0;
    };
    
    // Strategy B: Early exit validation
    const earlyExitValidation = () => {
      const share = this.testShares[0];
      
      // Quick checks first
      if ((share.jobId.length | share.nonce.length) !== 24) return false; // 16 | 8 = 24
      if ((share.time | share.difficulty) <= 0) return false;
      
      // Only calculate hash if basic checks pass
      const header = Buffer.allocUnsafe(108); // Pre-allocate
      Buffer.from(share.previousBlockHash, 'hex').copy(header, 0);
      Buffer.from(share.merkleRoot, 'hex').copy(header, 32);
      Buffer.from(share.nonce, 'hex').copy(header, 64);
      Buffer.from(share.time.toString(16).padStart(8, '0'), 'hex').copy(header, 68);
      
      const hash = crypto.createHash('sha256')
        .update(crypto.createHash('sha256').update(header).digest())
        .digest();
      
      const target = this.difficultyToTarget(share.difficulty);
      return hash.compare(target) <= 0;
    };
    
    const result = await perfTest.compare(
      'Share Validation Strategies',
      sequentialValidation,
      earlyExitValidation,
      {
        iterations: 10000,
        warmupIterations: 100
      }
    );
    
    console.log(`\nStrategy comparison: ${result.comparison.winner} is ${result.comparison.speedup.toFixed(2)}x faster`);
  }

  /**
   * Convert difficulty to target
   */
  private difficultyToTarget(difficulty: number): Buffer {
    const maxTarget = BigInt('0xffff0000000000000000000000000000000000000000000000000000');
    const target = maxTarget / BigInt(Math.floor(difficulty));
    
    const buffer = Buffer.alloc(32);
    const hex = target.toString(16).padStart(64, '0');
    buffer.write(hex, 'hex');
    
    return buffer;
  }

  /**
   * Run all share validation performance tests
   */
  async runAll(): Promise<void> {
    await perfTest.suite('Share Validation Performance', [
      { name: 'Basic Validation', fn: () => this.testBasicValidation() },
      { name: 'Hash Calculation', fn: () => this.testHashCalculation() },
      { name: 'Difficulty Check', fn: () => this.testDifficultyCheck() },
      { name: 'Validation Strategy Comparison', fn: () => this.compareValidationStrategies() }
    ]);
  }
}

// Run tests if executed directly
if (require.main === module) {
  const test = new ShareValidationPerformance();
  test.runAll().catch(console.error);
}
