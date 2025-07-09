// src/test/new-features.test.ts - 新機能テストスイート
import { Logger } from '../logging/logger';
import { RedisCache } from '../cache/redis-cache';
import { OAuth2JWTProvider, JWTConfig } from '../auth/oauth2-jwt-provider';
import { CQRSFactory } from '../cqrs/cqrs-implementation';
import { CostAnalysisOptimizer } from '../cost/cost-analysis-optimizer';

describe('新機能テストスイート', () => {
  let logger: Logger;
  let cache: RedisCache;

  beforeAll(() => {
    logger = new Logger();
    // モックRedisを使用（テスト環境）
    cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      keys: jest.fn().mockResolvedValue([])
    } as any;
  });

  describe('OAuth2/JWT認証プロバイダー', () => {
    let authProvider: OAuth2JWTProvider;

    beforeEach(() => {
      const jwtConfig: JWTConfig = {
        secret: 'test-secret',
        issuer: 'test-issuer',
        audience: 'test-audience',
        expiresIn: '1h',
        refreshExpiresIn: '7d',
        algorithm: 'HS256'
      };

      authProvider = new OAuth2JWTProvider(jwtConfig, logger, cache);
    });

    test('OAuth2プロバイダーの登録', () => {
      authProvider.addOAuth2Provider('test-provider', {
        clientId: 'test-client',
        clientSecret: 'test-secret',
        redirectUri: 'http://localhost/callback',
        authorizationUrl: 'https://example.com/auth',
        tokenUrl: 'https://example.com/token',
        userInfoUrl: 'https://example.com/user',
        scope: ['read']
      });

      const authUrl = authProvider.getAuthorizationUrl('test-provider', 'test-state');
      expect(authUrl).toContain('https://example.com/auth');
      expect(authUrl).toContain('client_id=test-client');
      expect(authUrl).toContain('state=test-state');
    });

    test('JWTトークンの生成と検証', () => {
      const testUser = {
        id: 'user123',
        email: 'test@example.com',
        username: 'testuser',
        roles: ['miner'],
        permissions: ['submit_shares'],
        verified: true,
        createdAt: new Date()
      };

      const tokenPair = authProvider.generateTokenPair(testUser);
      
      expect(tokenPair.accessToken).toBeDefined();
      expect(tokenPair.refreshToken).toBeDefined();
      expect(tokenPair.tokenType).toBe('Bearer');
      expect(tokenPair.expiresIn).toBe(3600);

      const verifiedUser = authProvider.verifyAccessToken(tokenPair.accessToken);
      expect(verifiedUser).toBeDefined();
      expect(verifiedUser?.id).toBe('user123');
      expect(verifiedUser?.email).toBe('test@example.com');
    });

    test('無効なトークンの検証', () => {
      const invalidToken = 'invalid.token.here';
      const result = authProvider.verifyAccessToken(invalidToken);
      expect(result).toBeNull();
    });
  });

  describe('CQRS実装', () => {
    let cqrsBus: any;

    beforeEach(() => {
      cqrsBus = CQRSFactory.create(logger, cache);
    });

    test('コマンドの実行 - シェア提出', async () => {
      const command = {
        id: 'cmd-test-1',
        type: 'SUBMIT_SHARE',
        payload: {
          minerId: 'miner123',
          jobId: 'job456',
          nonce: 123456,
          result: '0000abcd' + '0'.repeat(56), // 64文字のハッシュ
          difficulty: 1024
        },
        metadata: {
          userId: 'user123',
          timestamp: Date.now()
        }
      };

      const result = await cqrsBus.executeCommand(command);
      
      expect(result.success).toBe(true);
      expect(result.aggregateId).toBe('miner123');
      expect(result.events).toBeDefined();
      expect(result.events!.length).toBe(1);
      expect(result.events![0].type).toBe('SHARE_SUBMITTED');
    });

    test('クエリの実行 - マイナー統計', async () => {
      const query = {
        id: 'query-test-1',
        type: 'GET_MINER_STATS',
        parameters: {
          minerId: 'miner123',
          timeframe: 'day'
        },
        metadata: {
          userId: 'user123',
          timestamp: Date.now()
        }
      };

      const result = await cqrsBus.executeQuery(query);
      
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.minerId).toBe('miner123');
      expect(result.data.hashrate).toBeDefined();
    });

    test('存在しないコマンドタイプ', async () => {
      const command = {
        id: 'cmd-invalid',
        type: 'INVALID_COMMAND',
        payload: {},
        metadata: {
          timestamp: Date.now()
        }
      };

      const result = await cqrsBus.executeCommand(command);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('No handler found');
    });
  });

  describe('コスト分析オプティマイザー', () => {
    let costOptimizer: CostAnalysisOptimizer;

    beforeEach(() => {
      costOptimizer = new CostAnalysisOptimizer(logger, cache);
    });

    test('コストメトリクスの記録', async () => {
      const metric = {
        service: 'EC2',
        resource: 'i-1234567890abcdef0',
        region: 'us-east-1',
        cost: 50.25,
        currency: 'USD',
        period: 'day' as const,
        timestamp: new Date(),
        tags: {
          environment: 'production',
          project: 'mining-pool'
        }
      };

      await expect(costOptimizer.recordCost(metric)).resolves.not.toThrow();
    });

    test('予算設定とアラート', async () => {
      costOptimizer.setBudget('test-budget', 1000, [80, 90]);
      
      const alerts = await costOptimizer.checkBudgetAlerts();
      expect(Array.isArray(alerts)).toBe(true);
    });

    test('コスト予測', async () => {
      const forecast = await costOptimizer.forecastCosts(7);
      
      expect(forecast.daily).toBeDefined();
      expect(forecast.total).toBeDefined();
      expect(forecast.daily.length).toBe(7);
      expect(typeof forecast.total).toBe('number');
    });

    test('最適化推奨の生成', async () => {
      const recommendations = await costOptimizer.generateRecommendations();
      
      expect(Array.isArray(recommendations)).toBe(true);
      // 実際の推奨はリソースメトリクスに依存するため、配列であることを確認
    });

    test('コストレポートの生成', async () => {
      const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const endDate = new Date();
      
      const report = await costOptimizer.getCostReport(startDate, endDate, 'service');
      
      expect(report.totalCost).toBeDefined();
      expect(report.breakdown).toBeDefined();
      expect(report.trend).toMatch(/^(increasing|decreasing|stable)$/);
      expect(report.period.start).toEqual(startDate);
      expect(report.period.end).toEqual(endDate);
    });
  });

  describe('統合テスト', () => {
    test('全コンポーネントの初期化', () => {
      // JWT設定
      const jwtConfig: JWTConfig = {
        secret: 'test-secret',
        issuer: 'test-issuer',
        audience: 'test-audience',
        expiresIn: '1h',
        refreshExpiresIn: '7d',
        algorithm: 'HS256'
      };

      // 各コンポーネントの初期化
      const authProvider = new OAuth2JWTProvider(jwtConfig, logger, cache);
      const cqrsBus = CQRSFactory.create(logger, cache);
      const costOptimizer = new CostAnalysisOptimizer(logger, cache);

      // 初期化確認
      expect(authProvider).toBeDefined();
      expect(cqrsBus).toBeDefined();
      expect(costOptimizer).toBeDefined();
    });

    test('認証からCQRS操作まで', async () => {
      const jwtConfig: JWTConfig = {
        secret: 'test-secret',
        issuer: 'test-issuer',
        audience: 'test-audience',
        expiresIn: '1h',
        refreshExpiresIn: '7d',
        algorithm: 'HS256'
      };

      const authProvider = new OAuth2JWTProvider(jwtConfig, logger, cache);
      const cqrsBus = CQRSFactory.create(logger, cache);

      // ユーザー認証
      const testUser = {
        id: 'user123',
        email: 'test@example.com',
        username: 'testuser',
        roles: ['miner'],
        permissions: ['submit_shares'],
        verified: true,
        createdAt: new Date()
      };

      const tokenPair = authProvider.generateTokenPair(testUser);
      const verifiedUser = authProvider.verifyAccessToken(tokenPair.accessToken);

      expect(verifiedUser).toBeDefined();

      // 認証済みユーザーでのCQRS操作
      const command = {
        id: 'cmd-integration-test',
        type: 'SUBMIT_SHARE',
        payload: {
          minerId: verifiedUser!.id,
          jobId: 'job789',
          nonce: 987654,
          result: '0000beef' + '0'.repeat(56),
          difficulty: 2048
        },
        metadata: {
          userId: verifiedUser!.id,
          timestamp: Date.now()
        }
      };

      const result = await cqrsBus.executeCommand(command);
      expect(result.success).toBe(true);
    });
  });
});

// モック関数のセットアップ
jest.mock('../logging/logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }))
}));

// テスト用のヘルパー関数
export class TestHelper {
  static createMockUser(overrides: Partial<any> = {}) {
    return {
      id: 'test-user-123',
      email: 'test@example.com',
      username: 'testuser',
      roles: ['miner'],
      permissions: ['submit_shares', 'view_stats'],
      verified: true,
      createdAt: new Date(),
      ...overrides
    };
  }

  static createMockCommand(type: string, payload: any, userId?: string) {
    return {
      id: `cmd-${Date.now()}`,
      type,
      payload,
      metadata: {
        userId,
        timestamp: Date.now(),
        correlationId: `corr-${Date.now()}`
      }
    };
  }

  static createMockQuery(type: string, parameters: any, userId?: string) {
    return {
      id: `query-${Date.now()}`,
      type,
      parameters,
      metadata: {
        userId,
        timestamp: Date.now()
      }
    };
  }
}

// テスト実行用のセットアップ
export const setupTestEnvironment = () => {
  // テスト環境用の環境変数設定
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.REDIS_URL = 'redis://localhost:6379';
  
  return {
    cleanup: () => {
      // テスト後のクリーンアップ
      delete process.env.JWT_SECRET;
    }
  };
};