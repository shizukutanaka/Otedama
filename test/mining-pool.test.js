/**
 * Mining Pool Tests
 * Comprehensive testing for mining pool functionality
 */

import { MiningPool, ALGORITHMS } from '../lib/mining-pool.js';
import { EventEmitter } from 'events';

describe('MiningPool', () => {
    let pool;
    
    beforeEach(() => {
        pool = new MiningPool({
            algorithm: ALGORITHMS.SHA256,
            coin: 'BTC',
            difficulty: 1000,
            blockReward: 6.25,
            poolFee: 0.01
        });
    });
    
    afterEach(() => {
        if (pool && pool.stop) {
            pool.stop();
        }
    });
    
    describe('Pool Configuration', () => {
        it('should initialize with correct configuration', () => {
            expect(pool.config.algorithm).toBe(ALGORITHMS.SHA256);
            expect(pool.config.coin).toBe('BTC');
            expect(pool.config.difficulty).toBe(1000);
            expect(pool.config.blockReward).toBe(6.25);
            expect(pool.config.poolFee).toBe(0.01);
        });
        
        it('should support all mining algorithms', () => {
            const algorithms = Object.values(ALGORITHMS);
            expect(algorithms).toContain('sha256');
            expect(algorithms).toContain('scrypt');
            expect(algorithms).toContain('ethash');
            expect(algorithms).toContain('randomx');
            expect(algorithms).toContain('kawpow');
        });
    });
    
    describe('Miner Management', () => {
        it('should add new miners', async () => {
            const minerAddress = 'bc1qtest123';
            const workerId = 'worker1';
            
            const miner = await pool.addMiner(minerAddress, workerId);
            
            expect(miner).toBeTruthy();
            expect(miner.address).toBe(minerAddress);
            expect(miner.workerId).toBe(workerId);
            expect(pool.miners.size).toBe(1);
        });
        
        it('should remove disconnected miners', async () => {
            const miner = await pool.addMiner('bc1qtest123', 'worker1');
            
            pool.removeMiner(miner.id);
            
            expect(pool.miners.size).toBe(0);
        });
        
        it('should track miner statistics', async () => {
            const miner = await pool.addMiner('bc1qtest123', 'worker1');
            
            // Submit shares
            await pool.submitShare(miner.id, {
                nonce: '12345678',
                hash: '00000000abcdef',
                difficulty: 500
            });
            
            const stats = pool.getMinerStats(miner.id);
            expect(stats.shares.valid).toBe(1);
            expect(stats.shares.invalid).toBe(0);
            expect(stats.hashrate).toBeGreaterThan(0);
        });
    });
    
    describe('Share Processing', () => {
        it('should validate and accept valid shares', async () => {
            const miner = await pool.addMiner('bc1qtest123', 'worker1');
            
            const result = await pool.submitShare(miner.id, {
                nonce: '12345678',
                hash: '00000000abcdef',
                difficulty: 500
            });
            
            expect(result.accepted).toBe(true);
            expect(result.difficulty).toBe(500);
        });
        
        it('should reject invalid shares', async () => {
            const miner = await pool.addMiner('bc1qtest123', 'worker1');
            
            const result = await pool.submitShare(miner.id, {
                nonce: 'invalid',
                hash: 'invalid',
                difficulty: 0
            });
            
            expect(result.accepted).toBe(false);
            expect(result.reason).toBeTruthy();
        });
        
        it('should detect duplicate shares', async () => {
            const miner = await pool.addMiner('bc1qtest123', 'worker1');
            const share = {
                nonce: '12345678',
                hash: '00000000abcdef',
                difficulty: 500
            };
            
            // First submission
            await pool.submitShare(miner.id, share);
            
            // Duplicate submission
            const result = await pool.submitShare(miner.id, share);
            
            expect(result.accepted).toBe(false);
            expect(result.reason).toContain('duplicate');
        });
    });
    
    describe('Difficulty Adjustment', () => {
        it('should adjust difficulty based on miner hashrate', async () => {
            const miner = await pool.addMiner('bc1qtest123', 'worker1');
            
            // Simulate high hashrate
            for (let i = 0; i < 100; i++) {
                await pool.submitShare(miner.id, {
                    nonce: `nonce${i}`,
                    hash: `hash${i}`,
                    difficulty: 500
                });
            }
            
            const newDifficulty = pool.calculateDifficulty(miner.id);
            expect(newDifficulty).toBeGreaterThan(500);
        });
        
        it('should implement vardiff correctly', () => {
            const testCases = [
                { hashrate: 1000, expected: 16 },
                { hashrate: 10000, expected: 128 },
                { hashrate: 100000, expected: 1024 },
                { hashrate: 1000000, expected: 8192 }
            ];
            
            testCases.forEach(({ hashrate, expected }) => {
                const difficulty = pool.vardiffCalculate(hashrate);
                expect(difficulty).toBe(expected);
            });
        });
    });
    
    describe('Block Finding', () => {
        it('should handle block finding correctly', async () => {
            const miner = await pool.addMiner('bc1qtest123', 'worker1');
            let blockFound = false;
            
            pool.on('blockFound', (block) => {
                blockFound = true;
                expect(block.finder).toBe(miner.id);
                expect(block.reward).toBe(6.25);
            });
            
            // Simulate finding a block
            await pool.processBlockCandidate(miner.id, {
                hash: '0000000000000000000123456789abcdef',
                height: 700000
            });
            
            expect(blockFound).toBe(true);
        });
    });
    
    describe('Payout System', () => {
        it('should calculate payouts correctly', async () => {
            // Add miners with different share contributions
            const miner1 = await pool.addMiner('bc1qtest1', 'worker1');
            const miner2 = await pool.addMiner('bc1qtest2', 'worker2');
            
            // Submit shares
            for (let i = 0; i < 70; i++) {
                await pool.submitShare(miner1.id, {
                    nonce: `nonce1_${i}`,
                    hash: `hash1_${i}`,
                    difficulty: 1000
                });
            }
            
            for (let i = 0; i < 30; i++) {
                await pool.submitShare(miner2.id, {
                    nonce: `nonce2_${i}`,
                    hash: `hash2_${i}`,
                    difficulty: 1000
                });
            }
            
            const payouts = pool.calculatePayouts(6.25);
            
            // Pool fee is 1%, so total to distribute is 6.1875
            expect(payouts[miner1.address]).toBeGreaterThan(4.3); // ~70% of 6.1875
            expect(payouts[miner2.address]).toBeLessThan(1.9); // ~30% of 6.1875
        });
        
        it('should respect minimum payout threshold', () => {
            pool.config.minimumPayout = 0.001;
            
            const payouts = pool.calculatePayouts(6.25, {
                'bc1qsmall': 0.0005 // Below threshold
            });
            
            expect(payouts['bc1qsmall']).toBeUndefined();
        });
    });
    
    describe('Statistics', () => {
        it('should calculate pool hashrate correctly', async () => {
            const miners = [];
            
            // Add multiple miners
            for (let i = 0; i < 5; i++) {
                const miner = await pool.addMiner(`bc1qtest${i}`, `worker${i}`);
                miners.push(miner);
            }
            
            // Submit shares from each miner
            for (const miner of miners) {
                for (let i = 0; i < 10; i++) {
                    await pool.submitShare(miner.id, {
                        nonce: `nonce_${miner.id}_${i}`,
                        hash: `hash_${miner.id}_${i}`,
                        difficulty: 1000
                    });
                }
            }
            
            const stats = pool.getPoolStats();
            
            expect(stats.miners).toBe(5);
            expect(stats.hashrate).toBeGreaterThan(0);
            expect(stats.shares.valid).toBe(50);
        });
        
        it('should track pool efficiency', async () => {
            const stats = pool.getPoolStats();
            
            expect(stats.efficiency).toBeGreaterThan(0);
            expect(stats.efficiency).toBeLessThan(100);
        });
    });
    
    describe('Multi-Algorithm Support', () => {
        it('should support switching algorithms', () => {
            const algorithms = [
                ALGORITHMS.SHA256,
                ALGORITHMS.SCRYPT,
                ALGORITHMS.ETHASH,
                ALGORITHMS.RANDOMX
            ];
            
            algorithms.forEach(algo => {
                const testPool = new MiningPool({
                    algorithm: algo,
                    coin: 'TEST'
                });
                
                expect(testPool.config.algorithm).toBe(algo);
                testPool.stop();
            });
        });
    });
    
    describe('Error Handling', () => {
        it('should handle invalid miner gracefully', async () => {
            const result = await pool.submitShare('invalid-miner-id', {
                nonce: '12345',
                hash: 'abcdef'
            });
            
            expect(result.accepted).toBe(false);
            expect(result.reason).toContain('Invalid miner');
        });
        
        it('should handle database errors', async () => {
            // Simulate database error
            pool.db = null;
            
            try {
                await pool.addMiner('bc1qtest', 'worker');
            } catch (error) {
                expect(error).toBeTruthy();
            }
        });
    });
});

describe('Mining Pool Integration', () => {
    it('should handle high load scenario', async () => {
        const pool = new MiningPool({
            algorithm: ALGORITHMS.SHA256,
            coin: 'BTC'
        });
        
        const minerCount = 100;
        const sharesPerMiner = 10;
        const miners = [];
        
        // Add many miners
        for (let i = 0; i < minerCount; i++) {
            const miner = await pool.addMiner(`bc1qtest${i}`, `worker${i}`);
            miners.push(miner);
        }
        
        // Submit many shares concurrently
        const sharePromises = [];
        
        for (const miner of miners) {
            for (let i = 0; i < sharesPerMiner; i++) {
                sharePromises.push(
                    pool.submitShare(miner.id, {
                        nonce: `${miner.id}_${i}`,
                        hash: `hash_${miner.id}_${i}`,
                        difficulty: 1000
                    })
                );
            }
        }
        
        const results = await Promise.all(sharePromises);
        
        const accepted = results.filter(r => r.accepted).length;
        expect(accepted).toBe(minerCount * sharesPerMiner);
        
        const stats = pool.getPoolStats();
        expect(stats.miners).toBe(minerCount);
        expect(stats.shares.valid).toBe(minerCount * sharesPerMiner);
        
        pool.stop();
    });
});