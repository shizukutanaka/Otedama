/**
 * AMM Improvements Test Suite
 */

import { describe, it, beforeEach, afterEach } from '../test/test-runner.js';
import assert from 'assert';
import { AMMOptimizer } from '../lib/dex/amm/index.js';

describe('AMM Optimizer Tests', () => {
    let optimizer;
    
    beforeEach(async () => {
        optimizer = new AMMOptimizer({
            enableConcentratedLiquidity: true,
            enableDynamicFees: true,
            enableMEVProtection: true,
            commitDelay: 100, // Faster for testing
            batchInterval: 200
        });
    });
    
    afterEach(async () => {
        if (optimizer) {
            optimizer.destroy();
        }
    });
    
    describe('Pool Creation', () => {
        it('should create concentrated liquidity pool', async () => {
            const result = await optimizer.createPool('BTC', 'USDC', {
                sqrtPriceX96: BigInt('79228162514264337593543950336'), // 1 BTC = 40000 USDC
                baseFee: 30
            });
            
            assert(result.poolId === 'BTC-USDC');
            assert(result.pool);
            assert(result.feeManager);
        });
        
        it('should prevent duplicate pools', async () => {
            await optimizer.createPool('BTC', 'USDC', {
                sqrtPriceX96: BigInt('79228162514264337593543950336')
            });
            
            try {
                await optimizer.createPool('BTC', 'USDC', {});
                assert.fail('Should throw error');
            } catch (error) {
                assert(error.message === 'Pool already exists');
            }
        });
    });
    
    describe('Concentrated Liquidity', () => {
        let pool;
        
        beforeEach(async () => {
            const result = await optimizer.createPool('ETH', 'USDC', {
                sqrtPriceX96: BigInt('1461446703485210103287273052203988') // 1 ETH = 2000 USDC
            });
            pool = result.pool;
        });
        
        it('should add liquidity to specific range', async () => {
            const result = await pool.mint(
                '0xuser',
                -887220, // tickLower
                887220,  // tickUpper
                BigInt('1000000000000000000'), // 1e18 liquidity
                {}
            );
            
            assert(result.positionId === 1);
            assert(result.liquidity > 0n);
            assert(pool.liquidity > 0n);
        });
        
        it('should execute swap within range', async () => {
            // Add liquidity first
            await pool.mint(
                '0xlp',
                -887220,
                887220,
                BigInt('1000000000000000000'),
                {}
            );
            
            // Execute swap
            const result = await pool.swap(
                '0xtrader',
                true, // ETH to USDC
                BigInt('1000000000000000000'), // 1 ETH
                0n,
                {}
            );
            
            assert(result.amount0 > 0n); // ETH in
            assert(result.amount1 < 0n); // USDC out
        });
    });
    
    describe('Dynamic Fees', () => {
        it('should adjust fees based on volatility', async () => {
            const result = await optimizer.createPool('BTC', 'ETH', {
                sqrtPriceX96: BigInt('79228162514264337593543950336'),
                baseFee: 30
            });
            
            const feeManager = result.feeManager;
            const initialFee = feeManager.currentFee;
            
            // Simulate volatile price movements
            for (let i = 0; i < 10; i++) {
                const price = 15 + Math.random() * 2; // 15-17 ETH per BTC
                feeManager.recordTrade(price, 1000000);
            }
            
            // Force fee update
            feeManager.updateFee();
            
            // Fee should change based on volatility
            assert(feeManager.currentFee !== initialFee);
        });
        
        it('should respect fee bounds', async () => {
            const result = await optimizer.createPool('DOGE', 'USDT', {
                sqrtPriceX96: BigInt('79228162514264337593543950336'),
                baseFee: 30,
                minFee: 5,
                maxFee: 100
            });
            
            const feeManager = result.feeManager;
            
            // Simulate extreme volatility
            for (let i = 0; i < 20; i++) {
                const price = 0.1 + Math.random() * 0.5; // High volatility
                feeManager.recordTrade(price, 10000);
            }
            
            feeManager.updateFee();
            
            assert(feeManager.currentFee >= 5);
            assert(feeManager.currentFee <= 100);
        });
    });
    
    describe('MEV Protection', () => {
        it('should use commit-reveal for swaps', async () => {
            await optimizer.createPool('BTC', 'USDC', {
                sqrtPriceX96: BigInt('79228162514264337593543950336')
            });
            
            const swapParams = {
                tokenIn: 'BTC',
                tokenOut: 'USDC',
                amountIn: '1000000000',
                from: '0xuser'
            };
            
            const result = await optimizer.swap(swapParams);
            
            assert(result.status === 'queued');
            assert(result.commitment);
            assert(result.revealed);
        });
        
        it('should detect sandwich attacks', async () => {
            const mevProtection = optimizer.mevProtection;
            
            // Create commits for sandwich pattern
            const victim = {
                tokenIn: 'ETH',
                tokenOut: 'USDC',
                amountIn: '1000000000000000000'
            };
            
            const attacker1 = {
                tokenIn: 'ETH',
                tokenOut: 'USDC',
                amountIn: '5000000000000000000'
            };
            
            const attacker2 = {
                tokenIn: 'USDC',
                tokenOut: 'ETH',
                amountIn: '10000000000'
            };
            
            const commit1 = await mevProtection.commitSwap(attacker1, 'secret1');
            const commitV = await mevProtection.commitSwap(victim, 'secretV');
            const commit2 = await mevProtection.commitSwap(attacker2, 'secret2');
            
            // Wait for commit delay
            await new Promise(resolve => setTimeout(resolve, 150));
            
            // Reveal in sandwich order
            await mevProtection.revealSwap(commit1.commitHash, attacker1, 'secret1');
            await mevProtection.revealSwap(commitV.commitHash, victim, 'secretV');
            await mevProtection.revealSwap(commit2.commitHash, attacker2, 'secret2');
            
            let sandwichDetected = false;
            mevProtection.once('sandwichDetected', () => {
                sandwichDetected = true;
            });
            
            // Process batch
            await new Promise(resolve => setTimeout(resolve, 250));
            
            assert(sandwichDetected);
        });
    });
    
    describe('Route Optimization', () => {
        beforeEach(async () => {
            // Create multiple pools for routing
            await optimizer.createPool('BTC', 'ETH', {
                sqrtPriceX96: BigInt('79228162514264337593543950336')
            });
            
            await optimizer.createPool('ETH', 'USDC', {
                sqrtPriceX96: BigInt('1461446703485210103287273052203988')
            });
            
            await optimizer.createPool('BTC', 'USDC', {
                sqrtPriceX96: BigInt('158456325028528675187087900672') // 1 BTC = 40000 USDC
            });
        });
        
        it('should find direct route when available', async () => {
            const route = await optimizer.findOptimalRoute(
                'BTC',
                'USDC',
                BigInt('100000000'), // 1 BTC
                null
            );
            
            assert(route);
            assert(route.path.length === 1);
            assert(route.path[0].poolId === 'BTC-USDC');
        });
        
        it('should find multi-hop route', async () => {
            // Remove direct pool to force multi-hop
            optimizer.pools.delete('BTC-USDC');
            
            const route = await optimizer.findOptimalRoute(
                'BTC',
                'USDC',
                BigInt('100000000'),
                null
            );
            
            assert(route);
            assert(route.path.length === 2);
            assert(route.path[0].tokenOut === 'ETH');
            assert(route.path[1].tokenOut === 'USDC');
        });
        
        it('should cache routes', async () => {
            const route1 = await optimizer.findOptimalRoute(
                'BTC',
                'ETH',
                BigInt('100000000'),
                null
            );
            
            const metrics1 = optimizer.metrics.routeCacheMisses;
            
            const route2 = await optimizer.findOptimalRoute(
                'BTC',
                'ETH',
                BigInt('100000000'),
                null
            );
            
            assert(optimizer.metrics.routeCacheHits > 0);
            assert(optimizer.metrics.routeCacheMisses === metrics1);
        });
    });
    
    describe('Liquidity Optimization', () => {
        it('should find optimal liquidity range', async () => {
            const result = await optimizer.createPool('BTC', 'USDT', {
                sqrtPriceX96: BigInt('79228162514264337593543950336')
            });
            
            const pool = result.pool;
            const feeManager = result.feeManager;
            
            // Simulate some volatility
            feeManager.metrics.volatility = 0.5;
            
            const optimalRange = await optimizer.findOptimalRange(
                pool,
                BigInt('100000000'), // 1 BTC
                BigInt('40000000000') // 40000 USDT
            );
            
            assert(optimalRange.tickLower < pool.tick);
            assert(optimalRange.tickUpper > pool.tick);
            assert(optimalRange.liquidity > 0n);
        });
    });
    
    describe('Performance', () => {
        it('should handle high volume efficiently', async () => {
            await optimizer.createPool('BTC', 'USDC', {
                sqrtPriceX96: BigInt('79228162514264337593543950336')
            });
            
            const startTime = Date.now();
            const promises = [];
            
            // Simulate 100 concurrent swaps
            for (let i = 0; i < 100; i++) {
                promises.push(
                    optimizer.swap({
                        tokenIn: 'BTC',
                        tokenOut: 'USDC',
                        amountIn: String(Math.floor(Math.random() * 1000000)),
                        from: `0xuser${i}`,
                        skipMEVProtection: true // Skip for performance test
                    })
                );
            }
            
            await Promise.all(promises);
            const duration = Date.now() - startTime;
            
            console.log(`Processed 100 swaps in ${duration}ms`);
            assert(duration < 5000); // Should complete in under 5 seconds
        });
    });
    
    describe('Metrics', () => {
        it('should track comprehensive metrics', async () => {
            await optimizer.createPool('BTC', 'USDC', {
                sqrtPriceX96: BigInt('79228162514264337593543950336')
            });
            
            // Execute some operations
            await optimizer.swap({
                tokenIn: 'BTC',
                tokenOut: 'USDC',
                amountIn: '100000000',
                from: '0xuser',
                skipMEVProtection: true
            });
            
            const metrics = optimizer.getMetrics();
            
            assert(metrics.global.totalPools === 1);
            assert(metrics.global.totalSwaps === 1);
            assert(metrics.global.totalVolume > 0n);
            assert(metrics.pools['BTC-USDC']);
            assert(metrics.features.concentratedLiquidity === true);
            assert(metrics.features.dynamicFees === true);
            assert(metrics.features.mevProtection === true);
        });
    });
});

// Run tests if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
    console.log('Running AMM Optimizer tests...');
}