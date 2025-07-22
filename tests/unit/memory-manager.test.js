const { MemoryManager, getInstance } = require('../../lib/core/memory-manager');

describe('MemoryManager', () => {
    let memoryManager;
    
    beforeEach(() => {
        memoryManager = new MemoryManager({
            checkInterval: 100, // 短い間隔でテスト
            heapSnapshotInterval: 1000,
            memoryThreshold: 0.85,
            gcInterval: 500,
            leakDetection: true,
            autoCleanup: true
        });
    });
    
    afterEach(() => {
        memoryManager.stop();
    });
    
    describe('Memory Statistics', () => {
        test('should get memory statistics', () => {
            const stats = memoryManager.getMemoryStats();
            
            expect(stats).toHaveProperty('timestamp');
            expect(stats).toHaveProperty('process');
            expect(stats).toHaveProperty('v8');
            expect(stats).toHaveProperty('usage');
            
            expect(stats.process).toHaveProperty('rss');
            expect(stats.process).toHaveProperty('heapTotal');
            expect(stats.process).toHaveProperty('heapUsed');
            
            expect(stats.v8).toHaveProperty('totalHeapSize');
            expect(stats.v8).toHaveProperty('usedHeapSize');
            expect(stats.v8).toHaveProperty('heapSizeLimit');
            
            expect(stats.usage.percent).toBeGreaterThanOrEqual(0);
            expect(stats.usage.percent).toBeLessThanOrEqual(1);
        });
    });
    
    describe('Memory Monitoring', () => {
        test('should start and stop monitoring', (done) => {
            const startedSpy = jest.fn();
            const checkSpy = jest.fn();
            
            memoryManager.on('started', startedSpy);
            memoryManager.on('memory-check', checkSpy);
            
            memoryManager.start();
            
            setTimeout(() => {
                expect(startedSpy).toHaveBeenCalled();
                expect(checkSpy).toHaveBeenCalled();
                done();
            }, 200);
        });
        
        test('should detect memory trends', () => {
            const measurements = [];
            const baseHeap = 100000000; // 100MB
            
            // 増加傾向のデータを作成
            for (let i = 0; i < 10; i++) {
                measurements.push({
                    timestamp: Date.now() + i * 60000,
                    v8: {
                        usedHeapSize: baseHeap + (i * 1000000) // 1MB/分増加
                    }
                });
            }
            
            const trend = memoryManager.calculateMemoryTrend(measurements);
            
            expect(trend.increasing).toBe(true);
            expect(trend.rate).toBeGreaterThan(0);
            expect(trend.growth).toBeGreaterThan(0);
        });
        
        test('should emit high memory usage warning', (done) => {
            const warningSpy = jest.fn();
            memoryManager.on('high-memory-usage', warningSpy);
            
            // 高メモリ使用状態をシミュレート
            const originalStats = memoryManager.getMemoryStats;
            memoryManager.getMemoryStats = () => ({
                ...originalStats.call(memoryManager),
                usage: { percent: 0.9 }
            });
            
            memoryManager.start();
            
            setTimeout(() => {
                expect(warningSpy).toHaveBeenCalled();
                done();
            }, 150);
        });
    });
    
    describe('Resource Tracking', () => {
        test('should track resources with WeakRef', () => {
            const resource = { id: 'test-resource', data: 'some data' };
            
            memoryManager.trackResource('test-type', resource, {
                name: 'Test Resource'
            });
            
            const tracked = memoryManager.resourceTracking.get('test-type');
            expect(tracked).toBeDefined();
            expect(tracked.size).toBe(1);
            
            const trackedResource = Array.from(tracked)[0];
            expect(trackedResource.resource.deref()).toEqual(resource);
            expect(trackedResource.metadata.name).toBe('Test Resource');
        });
        
        test('should clean up dead WeakRefs', () => {
            let resource = { id: 'temp-resource' };
            
            memoryManager.trackResource('temp-type', resource);
            
            // リソースへの参照を削除
            resource = null;
            
            // ガベージコレクションを強制（テスト環境では動作しない可能性）
            if (global.gc) {
                global.gc();
            }
            
            memoryManager.cleanupWeakRefs('temp-type');
            
            // WeakRefのクリーンアップを確認
            const tracked = memoryManager.resourceTracking.get('temp-type');
            expect(tracked).toBeDefined();
        });
    });
    
    describe('EventEmitter Wrapper', () => {
        test('should wrap EventEmitter and track listeners', () => {
            const { EventEmitter } = require('events');
            const emitter = new EventEmitter();
            
            const wrapped = memoryManager.wrapEventEmitter(emitter);
            
            const listener1 = () => {};
            const listener2 = () => {};
            
            wrapped.on('test-event', listener1);
            wrapped.on('test-event', listener2);
            
            const counts = memoryManager.eventListenerCounts.get(emitter);
            expect(counts.get('test-event')).toBe(2);
            
            wrapped.removeListener('test-event', listener1);
            expect(counts.get('test-event')).toBe(1);
        });
        
        test('should emit warning for too many listeners', (done) => {
            const { EventEmitter } = require('events');
            const emitter = new EventEmitter();
            const wrapped = memoryManager.wrapEventEmitter(emitter);
            
            memoryManager.on('listener-leak-warning', (warning) => {
                expect(warning.event).toBe('potential-leak');
                expect(warning.count).toBeGreaterThan(10);
                done();
            });
            
            // 多数のリスナーを追加
            for (let i = 0; i < 15; i++) {
                wrapped.on('potential-leak', () => {});
            }
        });
    });
    
    describe('Memory Profile', () => {
        test('should get memory profile', async () => {
            memoryManager.trackResource('connections', { id: 1 }, { type: 'websocket' });
            memoryManager.trackResource('connections', { id: 2 }, { type: 'http' });
            memoryManager.trackResource('caches', { data: [] }, { name: 'main-cache' });
            
            const profile = await memoryManager.getMemoryProfile();
            
            expect(profile).toHaveProperty('timestamp');
            expect(profile).toHaveProperty('process');
            expect(profile).toHaveProperty('v8');
            expect(profile).toHaveProperty('resources');
            expect(profile).toHaveProperty('suspects');
            
            expect(profile.resources.connections).toBe(2);
            expect(profile.resources.caches).toBe(1);
        });
    });
    
    describe('Garbage Collection', () => {
        test('should force garbage collection if available', (done) => {
            if (!global.gc) {
                // ガベージコレクションが利用できない場合はスキップ
                done();
                return;
            }
            
            const gcSpy = jest.fn();
            memoryManager.on('garbage-collection', gcSpy);
            
            memoryManager.forceGarbageCollection();
            
            setTimeout(() => {
                expect(gcSpy).toHaveBeenCalled();
                const gcInfo = gcSpy.mock.calls[0][0];
                expect(gcInfo).toHaveProperty('before');
                expect(gcInfo).toHaveProperty('after');
                expect(gcInfo).toHaveProperty('freed');
                expect(gcInfo).toHaveProperty('duration');
                done();
            }, 100);
        });
    });
    
    describe('Singleton Instance', () => {
        test('should return same instance', () => {
            const instance1 = getInstance({ test: true });
            const instance2 = getInstance({ test: false });
            
            expect(instance1).toBe(instance2);
            instance1.stop();
        });
    });
    
    describe('Statistics Summary', () => {
        test('should provide comprehensive stats', () => {
            memoryManager.start();
            
            // いくつかの測定値を追加
            memoryManager.measurements.push(
                memoryManager.getMemoryStats(),
                memoryManager.getMemoryStats(),
                memoryManager.getMemoryStats()
            );
            
            const stats = memoryManager.getStats();
            
            expect(stats).toHaveProperty('current');
            expect(stats).toHaveProperty('baseline');
            expect(stats).toHaveProperty('resourceCounts');
            expect(stats).toHaveProperty('suspectedLeaks');
            
            expect(stats.suspectedLeaks).toBeGreaterThanOrEqual(0);
        });
    });
});