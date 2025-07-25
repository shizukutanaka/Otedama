// テスト環境のセットアップ

// グローバルタイムアウト
jest.setTimeout(10000);

// モックの設定
jest.mock('ws');
jest.mock('ioredis');

// テスト用環境変数
process.env.NODE_ENV = 'test';
process.env.OTEDAMA_TEST = '1';

// グローバルテストヘルパー
global.testHelpers = {
    // ランダムなポート番号を生成
    getRandomPort() {
        return Math.floor(Math.random() * (65535 - 49152)) + 49152;
    },
    
    // テスト用のマイナーアドレスを生成
    generateMinerAddress() {
        const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        let address = '1'; // Bitcoin P2PKH prefix
        for (let i = 0; i < 33; i++) {
            address += chars[Math.floor(Math.random() * chars.length)];
        }
        return address;
    },
    
    // 遅延実行
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    },
    
    // モックレスポンス
    mockResponse() {
        return {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
            send: jest.fn().mockReturnThis(),
            setHeader: jest.fn().mockReturnThis()
        };
    },
    
    // モックリクエスト
    mockRequest(overrides = {}) {
        return {
            body: {},
            query: {},
            params: {},
            headers: {},
            ip: '127.0.0.1',
            method: 'GET',
            url: '/',
            ...overrides
        };
    }
};

// クリーンアップ
afterEach(() => {
    jest.clearAllMocks();
});

// すべてのテスト後のクリーンアップ
afterAll(async () => {
    // 開いているハンドルをクローズ
    await new Promise(resolve => setTimeout(() => resolve(), 500));
});