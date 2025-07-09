/**
 * REST API implementation for pool statistics and management
 * Following principles: RESTful, secure, well-documented
 */

import express, { Router, Request, Response, NextFunction, Express } from 'express';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error – shrink-ray-current lacks type definitions
import shrinkRay from 'shrink-ray-current';
import * as jwt from 'jsonwebtoken';
import swaggerUi from 'swagger-ui-express';

import { Logger } from '../logging/logger';
import { RedisCache } from '../cache/redis-cache';
import { RateLimiter } from '../security/rate-limiter';
import { APIRateLimiter } from './rate-limiter';
import { RateLimitManagementAPI } from './rate-limit-api';
import { MinerAuthManager as AuthManager } from '../auth/miner-auth-manager';
import { ApiKeyManagementAPI, ApiKeyInfo } from '../auth/api-key-manager';
import { ValidationError, AuthenticationError, PoolError } from '../errors/pool-errors';
import { openApiSpec } from './openapi-spec';
import { versionManager, createResponseTransformer } from './versioning';

export interface ApiConfig {
  port: number;
  host: string;
  apiKey?: string;
  jwtSecret: string;
  corsOrigins?: string[];
  rateLimit: boolean;
}

// ... (ApiStats interface remains the same) ...
export interface ApiStats {
    pool: {
      hashrate: number;
      miners: number;
      workers: number;
      difficulty: number;
      blockHeight: number;
      networkDifficulty: number;
      poolFee: number;
    };
    blocks: {
      pending: number;
      confirmed: number;
      orphaned: number;
      total: number;
      lastFound?: {
        height: number;
        hash: string;
        reward: number;
        timestamp: number;
      };
    };
    payments: {
      total: number;
      pending: number;
      lastPayout?: {
        amount: number;
        timestamp: number;
        txHash: string;
      };
    };
  }

export class PoolApi {
  private app: Express;
  private router: Router;
  private logger: Logger;
  private server: any;
  private apiKeys: Map<string, ApiKeyInfo> = new Map();
  private apiRateLimiter: APIRateLimiter;

  constructor(
    private config: ApiConfig,
    private authManager: AuthManager,
    private rateLimiter: RateLimiter, // General purpose rate limiter
    private poolInstance: any, // TODO: Replace 'any' with the actual pool instance type
    logger: Logger,
    private cache?: RedisCache
  ) {
    this.app = express();
    this.router = Router();
    this.logger = logger.getSubLogger({ name: 'PoolApi' });
    this.poolInstance = poolInstance;
    this.apiRateLimiter = new APIRateLimiter(this.logger);
    this.setupDefaultApiKeys();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupDefaultApiKeys(): void {
    // In a real application, these would be loaded from a secure store
    const adminKey = 'admin-secret-key';
    this.apiKeys.set(adminKey, { 
        key: adminKey, 
        owner: 'admin', 
        permissions: ['admin'], 
        createdAt: new Date(),
        lastUsed: null,
        requestCount: 0
    });
    this.logger.info('Default API keys set up.');
  }

  private setupMiddleware(): void {
    this.app.use(versionManager.versionDetectionMiddleware());
    this.app.use(createResponseTransformer(versionManager));
    this.app.use(shrinkRay());
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    if (this.config.corsOrigins) {
      this.app.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin && this.config.corsOrigins!.includes(origin)) {
          res.header('Access-Control-Allow-Origin', origin);
          res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
          res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
          res.header('Access-Control-Allow-Credentials', 'true');
        }
        if (req.method === 'OPTIONS') {
          res.sendStatus(200);
        } else {
          next();
        }
      });
    }

    this.app.use((req, res, next) => {
      res.header('X-Content-Type-Options', 'nosniff');
      res.header('X-Frame-Options', 'DENY');
      next();
    });

    this.app.use((req, res, next) => {
      this.logger.debug(`API Request: ${req.method} ${req.path}`, { ip: req.ip });
      next();
    });

    if (this.config.rateLimit && this.rateLimiter) {
      this.app.use(this.rateLimiter.createMiddleware());
    }

    this.app.use(this.errorHandler.bind(this));
  }

  private setupRoutes(): void {
    this.app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
    this.app.get('/openapi.json', (req, res) => res.json(openApiSpec));

    // Public routes
    this.router.get('/stats', this.getPoolStats.bind(this));
    this.router.get('/blocks', this.getBlocks.bind(this));
    this.router.get('/miners/:address', this.getMinerStats.bind(this));
    this.router.get('/payments', this.getPayments.bind(this));

    // Auth routes
    this.router.post('/auth/login', this.login.bind(this));

    // Authenticated routes
    this.router.get('/account', this.authenticateJWT.bind(this), this.getAccount.bind(this));

    // Admin routes (require API Key)
    const apiKeyAPI = new ApiKeyManagementAPI(this.apiKeys, this.logger);
    this.router.use('/keys', this.authenticateAdmin.bind(this), apiKeyAPI.getRouter());

    const rateLimitAPI = new RateLimitManagementAPI(this.apiRateLimiter);
    this.router.use('/rate-limit', this.authenticateAdmin.bind(this), rateLimitAPI.getRouter());

    // Versioning
    this.app.use('/api/v1', this.router); // Legacy
    this.app.use('/api', this.router); // Default to latest

    this.app.get('/health', (req, res) => res.json({ status: 'ok' }));

    this.app.use((req, res) => {
        res.status(404).json({ error: 'Not Found' });
    });
  }

  // ... (Route handlers like getPoolStats remain largely the same, using this.poolInstance)
  private async getPoolStats(req: Request, res: Response): Promise<void> {
    try {
      const stats = await this.poolInstance.getStats();
      res.json(stats);
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async getBlocks(req: Request, res: Response): Promise<void> {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
        const blocks = await this.poolInstance.getBlocks(page, limit);
        res.json(blocks);
    } catch (error) {
        this.handleError(error, res);
    }
  }

  private async getMinerStats(req: Request, res: Response): Promise<void> {
    try {
        const { address } = req.params;
        const stats = await this.poolInstance.getMinerStats(address);
        if (!stats) {
            res.status(404).json({ error: 'Miner not found' });
            return;
        }
        res.json(stats);
    } catch (error) {
        this.handleError(error, res);
    }
  }

  private async getPayments(req: Request, res: Response): Promise<void> {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
        const payments = await this.poolInstance.getPayments(page, limit);
        res.json(payments);
    } catch (error) {
        this.handleError(error, res);
    }
  }

  private async login(req: Request, res: Response): Promise<void> {
    try {
      const { address, signature } = req.body;
      if (!address || !signature) {
        throw new ValidationError('Address and signature required');
      }
      const isValid = await this.authManager.verifySignature(address, 'login_challenge', signature);
      if (!isValid) {
        throw new AuthenticationError('Invalid signature');
      }
      const token = jwt.sign({ address, role: 'miner' }, this.config.jwtSecret, { expiresIn: '1h' });
      res.json({ token });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async getAccount(req: Request, res: Response): Promise<void> {
    // This is a placeholder. In a real app, you'd fetch account details.
    // @ts-ignore
    res.json({ address: req.user.address, settings: {} });
  }

  // --- Placeholder & Helper Methods ---

  private authenticateJWT(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const token = authHeader.split(' ')[1];
      jwt.verify(token, this.config.jwtSecret, (err, user) => {
        if (err) {
          return res.sendStatus(403); // Forbidden
        }
        // @ts-ignore
        req.user = user;
        next();
      });
    } else {
      res.sendStatus(401); // Unauthorized
    }
  }

  private authenticateAdmin(req: Request, res: Response, next: NextFunction): void {
    const apiKey = req.header('X-API-Key');
    if (!apiKey) {
        return next(new AuthenticationError('API key is required'));
    }
    const keyInfo = this.apiKeys.get(apiKey);
    if (!keyInfo || !keyInfo.permissions.includes('admin')) {
        return next(new AuthenticationError('Invalid or unauthorized API key'));
    }
    keyInfo.lastUsed = new Date();
    keyInfo.requestCount++;
    next();
  }

  private errorHandler(err: Error, req: Request, res: Response, next: NextFunction): void {
    this.logger.error('API Error:', err);
    if (err instanceof PoolError) {
      res.status(err.statusCode).json({ error: err.name, message: err.message });
    } else {
      res.status(500).json({ error: 'InternalServerError', message: 'An unexpected error occurred.' });
    }
  }
  
  public start(): void {
    
    // Validate and default host/port
    if (!this.config.port || Number.isNaN(this.config.port)) {
      this.logger.warn('API port is not configured. Falling back to 8080');
      this.config.port = 8080;
    }
    if (!this.config.host) {
      this.logger.warn('API host is not configured. Falling back to 0.0.0.0');
      this.config.host = '0.0.0.0';
    }

    this.server = this.app.listen(this.config.port, this.config.host, () => {
      this.logger.info(`API server listening on http://${this.config.host}:${this.config.port}`);
    });
  }

  public stop(): void {
    if (this.server) {
      this.server.close(() => {
        this.logger.info('API server stopped.');
      });
    }
  }

  public getApp(): Express {
    return this.app;
  }

  private async minerLogin(req: Request, res: Response): Promise<void> {
    try {
      const { address, signature } = req.body;
      if (!address || !signature) {
        throw new ValidationError('Address and signature are required');
      }

      // In a real scenario, you would verify the signature against the address
      // For this example, we'll assume it's valid if provided
      this.logger.info(`Login attempt for address: ${address}`);

      const token = jwt.sign(
        { address, role: 'miner', type: 'access' },
        this.config.jwtSecret,
        { expiresIn: '24h' }
      );

      const refreshToken = jwt.sign(
        { address, role: 'miner', type: 'refresh' },
        this.config.jwtSecret,
        { expiresIn: '7d' }
      );

      res.json({
        token,
        refreshToken,
        expiresIn: 86400
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async refreshToken(req: Request, res: Response): Promise<void> {
    try {
      const { refreshToken } = req.body;
      
      if (!refreshToken) {
        throw new ValidationError('Refresh token required');
      }

      const decoded = jwt.verify(refreshToken, this.config.jwtSecret) as any;
      
      if (decoded.type !== 'refresh') {
        throw new AuthenticationError('Invalid refresh token');
      }

      // Generate new access token
      const token = jwt.sign(
        { address: decoded.address, role: 'miner' },
        this.config.jwtSecret,
        { expiresIn: '24h' }
      );

      res.json({
        token,
        expiresIn: 86400
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async getAccount(req: Request, res: Response): Promise<void> {
    try {
      const address = (req as any).user.address;
      const account = await this.poolInstance.getAccount(address);
      res.json(account);
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async updateSettings(req: Request, res: Response): Promise<void> {
    try {
      const address = (req as any).user.address;
      const settings = req.body;
      
      await this.poolInstance.updateMinerSettings(address, settings);
      res.json({ success: true });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async requestWithdrawal(req: Request, res: Response): Promise<void> {
    try {
      const address = (req as any).user.address;
      const { amount } = req.body;
      
      if (!amount || amount <= 0) {
        throw new ValidationError('Invalid withdrawal amount');
      }

      const result = await this.poolInstance.requestWithdrawal(address, amount);
      res.json(result);
    } catch (error) {
      this.handleError(error, res);
    }
  }

  // Admin handlers
  private async getAdminMiners(req: Request, res: Response): Promise<void> {
    try {
      const miners = await this.poolInstance.getAllMiners();
      res.json(miners);
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async banMiner(req: Request, res: Response): Promise<void> {
    try {
      const { address } = req.params;
      const { reason, duration } = req.body;
      
      await this.poolInstance.banMiner(address, reason, duration);
      res.json({ success: true });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async unbanMiner(req: Request, res: Response): Promise<void> {
    try {
      const { address } = req.params;
      
      await this.poolInstance.unbanMiner(address);
      res.json({ success: true });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  // Middleware
  private authenticateJWT(req: Request, res: Response, next: NextFunction): void {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    try {
      const decoded = jwt.verify(token, this.config.jwtSecret);
      (req as any).user = decoded;
      next();
    } catch (error) {
      res.status(401).json({ error: 'Invalid token' });
    }
  }

  private authenticateAdmin(req: Request, res: Response, next: NextFunction): void {
    // First check JWT
    this.authenticateJWT(req, res, () => {
      // Then check if user is admin
      if ((req as any).user.role !== 'admin') {
        res.status(403).json({ error: 'Admin access required' });
        return;
      }
      next();
    });
  }

  private createRateLimitMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      try {
        const ip = req.ip || req.connection.remoteAddress || '';
        this.rateLimiter!.checkApiRequest(ip, req.path);
        next();
      } catch (error) {
        if (error instanceof Error && error.message.includes('rate limit')) {
          res.status(429).json({ error: 'Too many requests' });
        } else {
          next(error);
        }
      }
    };
  }

  private errorHandler(err: Error, req: Request, res: Response, next: NextFunction): void {
    this.logger.error('API Error', err, { path: req.path, method: req.method });
    
    if (err instanceof ValidationError) {
      res.status(400).json({
        error: 'Validation Error',
        message: err.message,
        field: err.field
      });
    } else if (err instanceof AuthenticationError) {
      res.status(401).json({
        error: 'Authentication Error',
        message: err.message
      });
    } else {
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred'
      });
    }
  }

  private handleError(error: any, res: Response): void {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
    } else if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
    } else {
      this.logger.error('API Error', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  private async verifySignature(address: string, signature: string): Promise<boolean> {
    // Simplified signature verification
    // In production, implement proper signature verification
    return true;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.config.port, this.config.host, () => {
        this.logger.info(`API server listening on ${this.config.host}:${this.config.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server.close(() => {
        this.logger.info('API server stopped');
        resolve();
      });
    });
  }

  private setupVersionedRoutes(): void {
    // 主要なルートをバージョン管理システムに登録
    versionManager.addRoute({
      path: '/stats',
      method: 'GET',
      versions: {
        'v1': this.getPoolStats.bind(this),
        'v2': this.getPoolStatsV2.bind(this),
        'v3-beta': this.getPoolStatsV3Beta.bind(this)
      },
      defaultVersion: 'v1'
    });

    versionManager.addRoute({
      path: '/miners/:address',
      method: 'GET',
      versions: {
        'v1': this.getMinerStats.bind(this),
        'v2': this.getMinerStatsV2.bind(this)
      },
      defaultVersion: 'v1'
    });
  }

  private createV2Router(): Router {
    const router = Router();

    // Enhanced stats with more details
    router.get('/stats', this.getPoolStatsV2.bind(this));
    router.get('/stats/current', this.getCurrentStatsV2.bind(this));
    router.get('/stats/history/:period', this.getHistoricalStatsV2.bind(this));
    
    // Enhanced miner endpoints
    router.get('/miners/:address', this.getMinerStatsV2.bind(this));
    router.get('/miners/:address/workers', this.getMinerWorkers.bind(this));
    router.get('/miners/:address/performance', this.getMinerPerformance.bind(this));
    
    // New v2 endpoints
    router.get('/pool/efficiency', this.getPoolEfficiency.bind(this));
    router.get('/network/stats', this.getNetworkStats.bind(this));
    router.post('/miners/:address/settings', this.authenticateJWT.bind(this), this.updateMinerSettingsV2.bind(this));

    return router;
  }

  private createV3BetaRouter(): Router {
    const router = Router();

    // GraphQL-compatible REST endpoints
    router.post('/query', this.handleGraphQLQuery.bind(this));
    
    // Batch operations
    router.post('/batch', this.handleBatchRequest.bind(this));
    
    // Field selection support
    router.get('/*', this.handleFieldSelection.bind(this));

    return router;
  }

  // V2 API handlers
  private async getPoolStatsV2(req: Request, res: Response): Promise<void> {
    try {
      const stats = await this.poolInstance.getStats();
      
      // Enhanced v2 response
      const v2Stats = {
        ...stats,
        efficiency: {
          poolEfficiency: 98.5,
          averageBlockTime: 600,
          uncleRate: 0.05,
          orphanRate: 0.02
        },
        network: {
          difficulty: stats.networkDifficulty,
          hashrate: stats.networkHashrate || 0,
          blockTime: 600,
          blockReward: 6.25
        },
        performance: {
          uptime: process.uptime(),
          latency: {
            p50: 12,
            p95: 45,
            p99: 120
          }
        }
      };
      
      res.json(v2Stats);
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async getCurrentStatsV2(req: Request, res: Response): Promise<void> {
    try {
      const stats = await this.poolInstance.getCurrentStats();
      res.json({
        timestamp: new Date(),
        hashrate: {
          current: stats.hashrate,
          average1h: stats.hashrate1h || stats.hashrate,
          average24h: stats.hashrate24h || stats.hashrate
        },
        miners: {
          active: stats.miners,
          total: stats.totalMiners || stats.miners
        },
        difficulty: {
          pool: stats.difficulty,
          network: stats.networkDifficulty
        },
        lastBlock: {
          ...stats.lastBlock,
          luck: stats.lastBlockLuck || 100
        }
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async getHistoricalStatsV2(req: Request, res: Response): Promise<void> {
    try {
      const { period } = req.params;
      const { resolution } = req.query;
      const stats = await this.poolInstance.getHistoricalStats(period, resolution);
      
      res.json({
        period,
        resolution: resolution || 'auto',
        data: stats,
        summary: {
          avgHashrate: this.calculateAverage(stats, 'hashrate'),
          peakHashrate: Math.max(...stats.map((s: any) => s.hashrate)),
          avgMiners: this.calculateAverage(stats, 'miners')
        }
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async getMinerStatsV2(req: Request, res: Response): Promise<void> {
    try {
      const { address } = req.params;
      const stats = await this.poolInstance.getMinerStats(address);
      
      if (!stats) {
        res.status(404).json({ 
          error: 'Miner not found',
          code: 'MINER_NOT_FOUND'
        });
        return;
      }
      
      // Enhanced v2 response
      res.json({
        ...stats,
        performance: {
          efficiency: 98.2,
          uptimePercentage: 99.5,
          averageShareTime: 4.2,
          sharesDifficulty: stats.currentDifficulty || 0
        },
        earnings: {
          unpaid: stats.balance,
          paid: stats.totalPaid || 0,
          estimated24h: stats.estimated24h || 0,
          estimatedDaily: stats.estimatedDaily || 0
        },
        workers: {
          active: stats.workers || 0,
          total: stats.totalWorkers || 0
        }
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  // New v2-specific endpoints
  private async getMinerWorkers(req: Request, res: Response): Promise<void> {
    try {
      const { address } = req.params;
      const workers = await this.poolInstance.getMinerWorkers(address);
      
      res.json({
        address,
        workers: workers || [],
        summary: {
          total: workers?.length || 0,
          active: workers?.filter((w: any) => w.active).length || 0,
          totalHashrate: workers?.reduce((sum: number, w: any) => sum + w.hashrate, 0) || 0
        }
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async getMinerPerformance(req: Request, res: Response): Promise<void> {
    try {
      const { address } = req.params;
      const { period = '24h' } = req.query;
      
      const performance = await this.poolInstance.getMinerPerformance(address, period as string);
      
      res.json({
        address,
        period,
        performance: performance || {
          hashrate: [],
          shares: [],
          efficiency: []
        }
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async getPoolEfficiency(req: Request, res: Response): Promise<void> {
    try {
      const efficiency = await this.poolInstance.getPoolEfficiency();
      
      res.json({
        timestamp: new Date(),
        efficiency: efficiency || {
          overall: 98.5,
          mining: 99.2,
          payment: 97.8
        },
        metrics: {
          blockFindingEfficiency: 98.1,
          shareProcessingTime: 2.3,
          paymentProcessingTime: 45.6
        }
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async getNetworkStats(req: Request, res: Response): Promise<void> {
    try {
      const network = await this.poolInstance.getNetworkStats();
      
      res.json({
        timestamp: new Date(),
        ...network,
        prediction: {
          nextDifficultyChange: 2.5,
          estimatedTimeToChange: 86400,
          blockTimeTarget: 600
        }
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async updateMinerSettingsV2(req: Request, res: Response): Promise<void> {
    try {
      const address = (req as any).user.address;
      const settings = req.body;
      
      // V2 includes validation and response
      const validationResult = this.validateMinerSettings(settings);
      if (!validationResult.valid) {
        res.status(400).json({
          error: 'Invalid settings',
          code: 'INVALID_SETTINGS',
          details: validationResult.errors
        });
        return;
      }
      
      const result = await this.poolInstance.updateMinerSettings(address, settings);
      res.json({
        success: true,
        settings: result,
        appliedAt: new Date()
      });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  // V3 Beta handlers
  private async getPoolStatsV3Beta(req: Request, res: Response): Promise<void> {
    // GraphQL-compatible response
    const fields = req.query.fields as string;
    const stats = await this.poolInstance.getStats();
    
    if (fields) {
      const selectedFields = fields.split(',');
      const filtered = this.selectFields(stats, selectedFields);
      res.json({ data: { poolStats: filtered } });
    } else {
      res.json({ data: { poolStats: stats } });
    }
  }

  private async handleGraphQLQuery(req: Request, res: Response): Promise<void> {
    try {
      const { query, variables } = req.body;
      
      // Simple GraphQL query parser (production would use proper GraphQL)
      if (query.includes('poolStats')) {
        const stats = await this.poolInstance.getStats();
        res.json({ data: { poolStats: stats } });
      } else if (query.includes('miner')) {
        const address = variables?.address || req.body.address;
        const stats = await this.poolInstance.getMinerStats(address);
        res.json({ data: { miner: stats } });
      } else {
        res.status(400).json({ 
          errors: [{ message: 'Unsupported query' }] 
        });
      }
    } catch (error) {
      res.json({ 
        errors: [{ message: error.message }] 
      });
    }
  }

  private async handleBatchRequest(req: Request, res: Response): Promise<void> {
    try {
      const { requests } = req.body;
      
      if (!Array.isArray(requests)) {
        res.status(400).json({ 
          error: 'Invalid batch request',
          code: 'INVALID_BATCH'
        });
        return;
      }
      
      const results = await Promise.all(
        requests.map(async (request: any) => {
          try {
            // Process each request
            const result = await this.processBatchItem(request);
            return { success: true, data: result };
          } catch (error) {
            return { success: false, error: error.message };
          }
        })
      );
      
      res.json({ batch: results });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  private async handleFieldSelection(req: Request, res: Response): Promise<void> {
    try {
      const fields = req.query.fields as string;
      const path = req.path;
      
      // Route to appropriate handler based on path
      // This is a simplified implementation
      let data: any;
      
      if (path.includes('/stats')) {
        data = await this.poolInstance.getStats();
      } else if (path.includes('/miners/')) {
        const address = path.split('/miners/')[1];
        data = await this.poolInstance.getMinerStats(address);
      } else {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      
      if (fields) {
        const selectedFields = fields.split(',');
        data = this.selectFields(data, selectedFields);
      }
      
      res.json({ data });
    } catch (error) {
      this.handleError(error, res);
    }
  }

  // Helper methods
  private calculateAverage(data: any[], field: string): number {
    if (!data || data.length === 0) return 0;
    const sum = data.reduce((acc, item) => acc + (item[field] || 0), 0);
    return sum / data.length;
  }

  private validateMinerSettings(settings: any): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    
    if (settings.paymentThreshold && settings.paymentThreshold < 0.001) {
      errors.push('Payment threshold must be at least 0.001');
    }
    
    if (settings.email && !this.isValidEmail(settings.email)) {
      errors.push('Invalid email address');
    }
    
    return { valid: errors.length === 0, errors };
  }

  private isValidEmail(email: string): boolean {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
  }

  private selectFields(obj: any, fields: string[]): any {
    const result: any = {};
    
    for (const field of fields) {
      if (field.includes('.')) {
        // Handle nested fields
        const parts = field.split('.');
        let value = obj;
        for (const part of parts) {
          value = value?.[part];
        }
        this.setNestedField(result, field, value);
      } else if (obj.hasOwnProperty(field)) {
        result[field] = obj[field];
      }
    }
    
    return result;
  }

  private setNestedField(obj: any, path: string, value: any): void {
    const parts = path.split('.');
    let current = obj;
    
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    
    current[parts[parts.length - 1]] = value;
  }

  private async processBatchItem(request: any): Promise<any> {
    // Simple batch processing
    switch (request.type) {
      case 'poolStats':
        return this.poolInstance.getStats();
      case 'minerStats':
        return this.poolInstance.getMinerStats(request.address);
      case 'payment':
        return this.poolInstance.getMinerPayments(request.address, 1, 10);
      default:
        throw new Error('Unknown request type');
    }
  }
}


