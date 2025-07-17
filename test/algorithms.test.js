/**
 * Mining Algorithms Test Suite for Otedama
 * Tests the mining algorithm implementations
 */

import { 
  AlgorithmFactory,
  SHA256Algorithm,
  DifficultyCalculator,
  MiningManager
} from '../lib/mining/algorithms.js';

describe('Mining Algorithms', () => {
  describe('AlgorithmFactory', () => {
    it('should create SHA256 algorithm', () => {
      const algo = AlgorithmFactory.create('sha256');
      expect(algo).toBeInstanceOf(SHA256Algorithm);
      expect(algo.name).toBe('sha256');
    });

    it('should support all advertised algorithms', () => {
      const supported = AlgorithmFactory.getSupported();
      expect(supported).toContain('sha256');
      expect(supported).toContain('scrypt');
      expect(supported).toContain('ethash');
      expect(supported).toContain('randomx');
      expect(supported).toContain('kawpow');
      expect(supported).toContain('x11');
      expect(supported).toContain('equihash');
      expect(supported.length).toBeGreaterThan(10);
    });

    it('should throw error for unknown algorithm', () => {
      expect(() => AlgorithmFactory.create('unknown')).toThrow('Unknown algorithm');
    });
  });

  describe('SHA256Algorithm', () => {
    let algo;

    beforeEach(() => {
      algo = new SHA256Algorithm();
    });

    it('should calculate SHA256 hash', () => {
      const data = Buffer.from('test data');
      const hash = algo.hash(data);
      expect(hash).toHaveLength(64); // SHA256 is 32 bytes = 64 hex chars
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should calculate double SHA256 by default', () => {
      const algo1 = new SHA256Algorithm({ double: true });
      const algo2 = new SHA256Algorithm({ double: false });
      const data = Buffer.from('test data');
      
      const hash1 = algo1.hash(data);
      const hash2 = algo2.hash(data);
      
      expect(hash1).not.toBe(hash2);
    });

    it('should verify valid solution', () => {
      const header = Buffer.from('0000000000000000000000000000000000000000', 'hex');
      const nonce = 12345;
      const target = '0x00000000FFFF0000000000000000000000000000000000000000000000000000';
      
      const result = algo.verify(header, nonce, target);
      expect(result).toHaveProperty('valid');
      expect(result).toHaveProperty('hash');
      expect(result).toHaveProperty('hashBigInt');
    });

    it('should track hashrate', async () => {
      const header = Buffer.from('test header');
      const target = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
      
      // Mine for a short range
      const result = await algo.mine(header, target, 0, 1000);
      
      expect(result.hashrate).toBeGreaterThan(0);
      expect(result.attempts).toBeLessThan(1001);
    });
  });

  describe('DifficultyCalculator', () => {
    it('should convert target to difficulty', () => {
      const target = '0x00000000FFFF0000000000000000000000000000000000000000000000000000';
      const difficulty = DifficultyCalculator.targetToDifficulty(target);
      expect(difficulty).toBeGreaterThan(0);
      expect(difficulty).toBe(1); // This is difficulty 1 target
    });

    it('should convert difficulty to target', () => {
      const difficulty = 1000;
      const target = DifficultyCalculator.difficultyToTarget(difficulty);
      expect(target).toMatch(/^[a-f0-9]+$/);
      
      // Convert back to verify
      const difficultyBack = DifficultyCalculator.targetToDifficulty('0x' + target);
      expect(Math.abs(difficultyBack - difficulty)).toBeLessThan(1);
    });

    it('should adjust difficulty based on solve time', () => {
      const currentDifficulty = 1000;
      
      // Too fast - increase difficulty
      const faster = DifficultyCalculator.adjustDifficulty(currentDifficulty, 300, 600);
      expect(faster).toBeGreaterThan(currentDifficulty);
      
      // Too slow - decrease difficulty
      const slower = DifficultyCalculator.adjustDifficulty(currentDifficulty, 1200, 600);
      expect(slower).toBeLessThan(currentDifficulty);
      
      // Perfect timing - no change
      const perfect = DifficultyCalculator.adjustDifficulty(currentDifficulty, 600, 600);
      expect(perfect).toBe(currentDifficulty);
    });

    it('should limit difficulty adjustments', () => {
      const currentDifficulty = 1000;
      
      // Extreme fast - should cap at 4x
      const veryFast = DifficultyCalculator.adjustDifficulty(currentDifficulty, 10, 600);
      expect(veryFast).toBe(currentDifficulty * 4);
      
      // Extreme slow - should cap at 1/4x
      const verySlow = DifficultyCalculator.adjustDifficulty(currentDifficulty, 10000, 600);
      expect(verySlow).toBe(currentDifficulty / 4);
    });

    it('should calculate network hashrate', () => {
      const difficulty = 1000000;
      const blockTime = 600; // 10 minutes
      const hashrate = DifficultyCalculator.difficultyToHashrate(difficulty, blockTime);
      expect(hashrate).toBeGreaterThan(0);
    });
  });

  describe('MiningManager', () => {
    it('should initialize with options', () => {
      const manager = new MiningManager({
        threads: 4,
        algorithm: 'sha256'
      });
      
      expect(manager.options.threads).toBe(4);
      expect(manager.options.algorithm).toBe('sha256');
      expect(manager.isRunning).toBe(false);
    });

    it('should get hashrate', () => {
      const manager = new MiningManager();
      expect(manager.getHashrate()).toBe(0);
    });

    it('should stop mining', () => {
      const manager = new MiningManager();
      manager.stop();
      expect(manager.isRunning).toBe(false);
      expect(manager.workers).toHaveLength(0);
    });
  });

  describe('Algorithm Hash Verification', () => {
    it('should produce consistent hashes', () => {
      const algorithms = ['sha256', 'scrypt', 'ethash', 'randomx', 'kawpow'];
      const data = Buffer.from('consistent test data');
      
      for (const algoName of algorithms) {
        const algo1 = AlgorithmFactory.create(algoName);
        const algo2 = AlgorithmFactory.create(algoName);
        
        const hash1 = algo1.hash(data);
        const hash2 = algo2.hash(data);
        
        expect(hash1).toBe(hash2);
      }
    });

    it('should produce different hashes for different data', () => {
      const algo = AlgorithmFactory.create('sha256');
      const data1 = Buffer.from('data 1');
      const data2 = Buffer.from('data 2');
      
      const hash1 = algo.hash(data1);
      const hash2 = algo.hash(data2);
      
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('Performance', () => {
    it('should achieve reasonable hashrate', async () => {
      const algo = new SHA256Algorithm({ double: false });
      const start = Date.now();
      let count = 0;
      
      // Hash for 100ms
      while (Date.now() - start < 100) {
        algo.hash(Buffer.from(`nonce${count}`));
        count++;
      }
      
      const elapsed = (Date.now() - start) / 1000;
      const hashrate = count / elapsed;
      
      expect(hashrate).toBeGreaterThan(1000); // At least 1000 H/s
    });
  });
});