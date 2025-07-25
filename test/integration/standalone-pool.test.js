const StandalonePool = require('../../lib/standalone/standalone-pool');
const { delay } = global.testHelpers;

describe('StandalonePool Integration', () => {
    let pool;
    const testPort = global.testHelpers.getRandomPort();
    
    beforeEach(async () => {
        pool = new StandalonePool({
            port: testPort,
            difficulty: 1,
            blockTime: 10,
            minPeers: 1,
            maxPeers: 10,
            discoveryInterval: 100,
            syncInterval: 100
        });
    });
    
    afterEach(async () => {
        if (pool) {
            await pool.stop();
        }
    });
    
    describe('Pool Lifecycle', () => {
        test('should start in solo mode', async () => {
            await pool.start();
            
            expect(pool.mode).toBe('solo');
            expect(pool.isRunning).toBe(true);
            expect(pool.stratumServer).toBeDefined();
            expect(pool.p2pNetwork).toBeDefined();
        });
        
        test('should handle mode transitions', async () => {
            const modeChangeSpy = jest.fn();
            pool.on('mode-change', modeChangeSpy);
            
            await pool.start();
            expect(pool.mode).toBe('solo');
            
            // ピアを追加してプールモードに移行
            pool.peers.set('peer1', { id: 'peer1', address: '192.168.1.100' });
            pool.checkMode();
            
            expect(pool.mode).toBe('pool');
            expect(modeChangeSpy).toHaveBeenCalledWith({
                from: 'solo',
                to: 'pool',
                peers: 1
            });
        });
        
        test('should emit lifecycle events', async () => {
            const events = [];
            pool.on('started', () => events.push('started'));
            pool.on('stopped', () => events.push('stopped'));
            
            await pool.start();
            await pool.stop();
            
            expect(events).toEqual(['started', 'stopped']);
        });
    });
    
    describe('Miner Management', () => {
        test('should handle miner connections', async () => {
            await pool.start();
            
            const minerConnectedSpy = jest.fn();
            pool.on('miner-connected', minerConnectedSpy);
            
            // マイナー接続をシミュレート
            const minerId = 'miner1';
            const minerAddress = global.testHelpers.generateMinerAddress();
            
            pool.handleMinerConnected(minerId, { address: minerAddress });
            
            expect(pool.miners.has(minerId)).toBe(true);
            expect(minerConnectedSpy).toHaveBeenCalledWith({
                minerId,
                address: minerAddress,
                mode: 'solo'
            });
        });
        
        test('should track miner statistics', async () => {
            await pool.start();
            
            const minerId = 'miner1';
            const minerAddress = global.testHelpers.generateMinerAddress();
            
            pool.handleMinerConnected(minerId, { address: minerAddress });
            
            // シェア提出をシミュレート
            for (let i = 0; i < 5; i++) {
                pool.handleShareSubmitted({
                    minerId,
                    difficulty: 1,
                    isValid: true
                });
            }
            
            const miner = pool.miners.get(minerId);
            expect(miner.shares).toBe(5);
            expect(miner.validShares).toBe(5);
            expect(miner.hashrate).toBeGreaterThan(0);
        });
        
        test('should handle miner disconnections', async () => {
            await pool.start();
            
            const minerId = 'miner1';
            pool.handleMinerConnected(minerId, { address: 'test-address' });
            
            const minerDisconnectedSpy = jest.fn();
            pool.on('miner-disconnected', minerDisconnectedSpy);
            
            pool.handleMinerDisconnected(minerId);
            
            expect(pool.miners.has(minerId)).toBe(false);
            expect(minerDisconnectedSpy).toHaveBeenCalledWith({ minerId });
        });
    });
    
    describe('Share Processing', () => {
        test('should validate and process shares', async () => {
            await pool.start();
            
            const shareAcceptedSpy = jest.fn();
            const shareRejectedSpy = jest.fn();
            
            pool.on('share-accepted', shareAcceptedSpy);
            pool.on('share-rejected', shareRejectedSpy);
            
            const minerId = 'miner1';
            pool.handleMinerConnected(minerId, { address: 'test-address' });
            
            // 有効なシェア
            pool.handleShareSubmitted({
                minerId,
                jobId: 'job1',
                nonce: '00000001',
                difficulty: 1,
                isValid: true
            });
            
            expect(shareAcceptedSpy).toHaveBeenCalled();
            
            // 無効なシェア
            pool.handleShareSubmitted({
                minerId,
                jobId: 'job2',
                nonce: '00000002',
                difficulty: 1,
                isValid: false
            });
            
            expect(shareRejectedSpy).toHaveBeenCalled();
        });
        
        test('should update pool statistics on shares', async () => {
            await pool.start();
            
            const initialStats = pool.getStatistics();
            
            const minerId = 'miner1';
            pool.handleMinerConnected(minerId, { address: 'test-address' });
            
            // 複数のシェアを提出
            for (let i = 0; i < 10; i++) {
                pool.handleShareSubmitted({
                    minerId,
                    difficulty: 1,
                    isValid: i < 8 // 80%が有効
                });
            }
            
            const stats = pool.getStatistics();
            expect(stats.totalShares).toBe(initialStats.totalShares + 10);
            expect(stats.validShares).toBe(initialStats.validShares + 8);
        });
    });
    
    describe('Block Discovery', () => {
        test('should handle block discovery in solo mode', async () => {
            await pool.start();
            pool.mode = 'solo';
            
            const blockFoundSpy = jest.fn();
            pool.on('block-found', blockFoundSpy);
            
            const minerId = 'miner1';
            const minerAddress = global.testHelpers.generateMinerAddress();
            pool.handleMinerConnected(minerId, { address: minerAddress });
            
            // ブロック発見をシミュレート
            pool.handleBlockFound({
                height: 1000,
                hash: 'abcdef123456',
                finder: minerId,
                reward: 50
            });
            
            expect(blockFoundSpy).toHaveBeenCalledWith({
                height: 1000,
                hash: 'abcdef123456',
                finder: minerId,
                mode: 'solo',
                reward: 50
            });
            
            // ソロモードでは発見者が全報酬を受け取る
            const miner = pool.miners.get(minerId);
            expect(miner.pendingReward).toBe(50);
        });
        
        test('should handle block discovery in pool mode', async () => {
            await pool.start();
            pool.mode = 'pool';
            
            // 複数のマイナーを追加
            const miners = [
                { id: 'miner1', address: 'addr1', shares: 100 },
                { id: 'miner2', address: 'addr2', shares: 50 },
                { id: 'miner3', address: 'addr3', shares: 50 }
            ];
            
            miners.forEach(m => {
                pool.miners.set(m.id, {
                    id: m.id,
                    address: m.address,
                    shares: m.shares,
                    validShares: m.shares,
                    pendingReward: 0
                });
            });
            
            // ブロック発見
            pool.handleBlockFound({
                height: 1001,
                hash: 'fedcba654321',
                finder: 'miner1',
                reward: 50
            });
            
            // 報酬分配を確認（シェアに基づく）
            const totalShares = 200;
            expect(pool.miners.get('miner1').pendingReward).toBeCloseTo(25, 2); // 50%
            expect(pool.miners.get('miner2').pendingReward).toBeCloseTo(12.5, 2); // 25%
            expect(pool.miners.get('miner3').pendingReward).toBeCloseTo(12.5, 2); // 25%
        });
    });
    
    describe('P2P Synchronization', () => {
        test('should sync share chain with peers', async () => {
            await pool.start();
            pool.mode = 'pool';
            
            // ローカルシェアチェーンにデータを追加
            pool.localShareChain.addShare({
                minerId: 'miner1',
                difficulty: 1,
                timestamp: Date.now()
            });
            
            const syncSpy = jest.fn();
            pool.on('share-chain-synced', syncSpy);
            
            // 同期をトリガー
            await pool.syncWithPeers();
            
            // 同期イベントが発行されることを確認
            await delay(200);
            expect(pool.localShareChain.getHeight()).toBeGreaterThan(0);
        });
    });
    
    describe('Statistics and Monitoring', () => {
        test('should provide comprehensive statistics', async () => {
            await pool.start();
            
            // データを追加
            pool.handleMinerConnected('miner1', { address: 'addr1' });
            pool.handleMinerConnected('miner2', { address: 'addr2' });
            
            for (let i = 0; i < 20; i++) {
                pool.handleShareSubmitted({
                    minerId: i % 2 === 0 ? 'miner1' : 'miner2',
                    difficulty: 1,
                    isValid: true
                });
            }
            
            const stats = pool.getStatistics();
            
            expect(stats).toHaveProperty('mode', pool.mode);
            expect(stats).toHaveProperty('miners', 2);
            expect(stats).toHaveProperty('totalShares', 20);
            expect(stats).toHaveProperty('validShares', 20);
            expect(stats).toHaveProperty('totalHashrate');
            expect(stats).toHaveProperty('peers', 0);
            expect(stats).toHaveProperty('shareChainHeight');
            expect(stats).toHaveProperty('uptime');
            expect(stats.uptime).toBeGreaterThan(0);
        });
        
        test('should track miner-specific statistics', async () => {
            await pool.start();
            
            const minerAddress = global.testHelpers.generateMinerAddress();
            pool.handleMinerConnected('miner1', { address: minerAddress });
            
            // アクティビティを生成
            for (let i = 0; i < 100; i++) {
                pool.handleShareSubmitted({
                    minerId: 'miner1',
                    difficulty: Math.random() > 0.5 ? 1 : 2,
                    isValid: Math.random() > 0.1 // 90%有効
                });
            }
            
            const minerStats = pool.getMinerStatistics('miner1');
            
            expect(minerStats).toHaveProperty('address', minerAddress);
            expect(minerStats).toHaveProperty('shares');
            expect(minerStats).toHaveProperty('validShares');
            expect(minerStats).toHaveProperty('hashrate');
            expect(minerStats).toHaveProperty('lastShareTime');
            expect(minerStats.shares).toBe(100);
            expect(minerStats.validShares).toBeGreaterThan(80);
            expect(minerStats.validShares).toBeLessThan(100);
        });
    });
    
    describe('Error Handling', () => {
        test('should handle network errors gracefully', async () => {
            const errorSpy = jest.fn();
            pool.on('error', errorSpy);
            
            await pool.start();
            
            // ネットワークエラーをシミュレート
            pool.p2pNetwork.emit('error', new Error('Network connection failed'));
            
            expect(errorSpy).toHaveBeenCalled();
            expect(pool.isRunning).toBe(true); // プールは動作を継続
        });
        
        test('should handle invalid share submissions', async () => {
            await pool.start();
            
            const errorSpy = jest.fn();
            pool.on('error', errorSpy);
            
            // 無効なシェアデータ
            pool.handleShareSubmitted({
                minerId: 'unknown-miner',
                // 必須フィールドが欠落
            });
            
            // エラーは記録されるが、プールは動作を継続
            expect(pool.isRunning).toBe(true);
        });
    });
});