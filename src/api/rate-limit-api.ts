/**
 * Rate Limit Management API
 * 
 * 設計原則（Robert C. Martin風）:
 * - 単一責任の原則: レート制限管理に特化
 * - 開放閉鎖の原則: 新しいルールタイプを追加可能
 * - RESTfulで直感的なインターフェース
 */

import { Router, Request, Response } from 'express';
import { APIRateLimiter, RateLimitRule, RateLimitStats } from './rate-limiter';
import { createLogger } from '../utils/logger';
import { ValidationError } from '../errors/pool-errors';

export class RateLimitManagementAPI {
    private router: Router;
    private logger = createLogger('RateLimitAPI');

    constructor(private rateLimiter: APIRateLimiter) {
        this.router = Router();
        this.setupRoutes();
    }

    private setupRoutes(): void {
        // レート制限ルール管理
        this.router.get('/rules', this.getRules.bind(this));
        this.router.get('/rules/:id', this.getRule.bind(this));
        this.router.post('/rules', this.createRule.bind(this));
        this.router.put('/rules/:id', this.updateRule.bind(this));
        this.router.delete('/rules/:id', this.deleteRule.bind(this));
        this.router.patch('/rules/:id/toggle', this.toggleRule.bind(this));

        // レート制限状態確認
        this.router.get('/status/:key', this.getKeyStatus.bind(this));
        this.router.delete('/status/:key', this.clearKey.bind(this));

        // 統計情報
        this.router.get('/stats', this.getStats.bind(this));
        this.router.post('/stats/reset', this.resetStats.bind(this));

        // 一括操作
        this.router.post('/rules/bulk', this.bulkCreateRules.bind(this));
        this.router.put('/rules/bulk', this.bulkUpdateRules.bind(this));

        // プリセット
        this.router.get('/presets', this.getPresets.bind(this));
        this.router.post('/presets/:name/apply', this.applyPreset.bind(this));

        // テスト機能
        this.router.post('/test', this.testRateLimit.bind(this));
    }

    // ルール一覧取得
    private async getRules(req: Request, res: Response): Promise<void> {
        try {
            const rules = this.rateLimiter.getRules();
            
            res.json({
                total: rules.length,
                rules: rules.map(rule => this.sanitizeRule(rule))
            });
        } catch (error) {
            this.handleError(error, res);
        }
    }

    // 特定のルール取得
    private async getRule(req: Request, res: Response): Promise<void> {
        try {
            const { id } = req.params;
            const rules = this.rateLimiter.getRules();
            const rule = rules.find(r => r.id === id);

            if (!rule) {
                res.status(404).json({
                    error: 'Rule not found',
                    code: 'RULE_NOT_FOUND'
                });
                return;
            }

            res.json(this.sanitizeRule(rule));
        } catch (error) {
            this.handleError(error, res);
        }
    }

    // ルール作成
    private async createRule(req: Request, res: Response): Promise<void> {
        try {
            const rule = this.validateRule(req.body);
            
            // ID重複チェック
            const existingRules = this.rateLimiter.getRules();
            if (existingRules.some(r => r.id === rule.id)) {
                throw new ValidationError('Rule ID already exists', 'id', rule.id);
            }

            this.rateLimiter.addRule(rule);

            res.status(201).json({
                message: 'Rule created successfully',
                rule: this.sanitizeRule(rule)
            });
        } catch (error) {
            this.handleError(error, res);
        }
    }

    // ルール更新
    private async updateRule(req: Request, res: Response): Promise<void> {
        try {
            const { id } = req.params;
            const updates = req.body;

            const rules = this.rateLimiter.getRules();
            const existingRule = rules.find(r => r.id === id);

            if (!existingRule) {
                res.status(404).json({
                    error: 'Rule not found',
                    code: 'RULE_NOT_FOUND'
                });
                return;
            }

            const updatedRule = { ...existingRule, ...updates, id }; // IDは変更不可
            const validatedRule = this.validateRule(updatedRule);

            this.rateLimiter.updateRule(validatedRule);

            res.json({
                message: 'Rule updated successfully',
                rule: this.sanitizeRule(validatedRule)
            });
        } catch (error) {
            this.handleError(error, res);
        }
    }

    // ルール削除
    private async deleteRule(req: Request, res: Response): Promise<void> {
        try {
            const { id } = req.params;

            // デフォルトルールの削除防止
            if (this.isProtectedRule(id)) {
                res.status(403).json({
                    error: 'Cannot delete protected rule',
                    code: 'PROTECTED_RULE'
                });
                return;
            }

            this.rateLimiter.removeRule(id);

            res.json({
                message: 'Rule deleted successfully',
                id
            });
        } catch (error) {
            this.handleError(error, res);
        }
    }

    // ルールの有効/無効切り替え
    private async toggleRule(req: Request, res: Response): Promise<void> {
        try {
            const { id } = req.params;
            const rules = this.rateLimiter.getRules();
            const rule = rules.find(r => r.id === id);

            if (!rule) {
                res.status(404).json({
                    error: 'Rule not found',
                    code: 'RULE_NOT_FOUND'
                });
                return;
            }

            rule.enabled = !rule.enabled;
            this.rateLimiter.updateRule(rule);

            res.json({
                message: `Rule ${rule.enabled ? 'enabled' : 'disabled'} successfully`,
                rule: this.sanitizeRule(rule)
            });
        } catch (error) {
            this.handleError(error, res);
        }
    }

    // キーの状態確認
    private async getKeyStatus(req: Request, res: Response): Promise<void> {
        try {
            const { key } = req.params;
            
            // 実際のリクエストをシミュレート
            const mockReq = {
                path: req.query.path || '/api/test',
                method: req.query.method || 'GET',
                ip: key.split(':')[1] || '127.0.0.1'
            };

            const result = this.rateLimiter.checkRateLimit(mockReq);

            res.json({
                key,
                allowed: result.allowed,
                rateLimitInfo: result.rateLimitInfo,
                rule: result.rule ? this.sanitizeRule(result.rule) : null
            });
        } catch (error) {
            this.handleError(error, res);
        }
    }

    // キーのクリア
    private async clearKey(req: Request, res: Response): Promise<void> {
        try {
            const { key } = req.params;
            const cleared = this.rateLimiter.clearKey(key);

            if (!cleared) {
                res.status(404).json({
                    error: 'Key not found',
                    code: 'KEY_NOT_FOUND'
                });
                return;
            }

            res.json({
                message: 'Key cleared successfully',
                key
            });
        } catch (error) {
            this.handleError(error, res);
        }
    }

    // 統計情報取得
    private async getStats(req: Request, res: Response): Promise<void> {
        try {
            const stats = this.rateLimiter.getStats();
            
            res.json({
                ...stats,
                timestamp: new Date(),
                uptime: process.uptime()
            });
        } catch (error) {
            this.handleError(error, res);
        }
    }

    // 統計リセット
    private async resetStats(req: Request, res: Response): Promise<void> {
        try {
            this.rateLimiter.resetStats();

            res.json({
                message: 'Stats reset successfully',
                timestamp: new Date()
            });
        } catch (error) {
            this.handleError(error, res);
        }
    }

    // 一括ルール作成
    private async bulkCreateRules(req: Request, res: Response): Promise<void> {
        try {
            const { rules } = req.body;

            if (!Array.isArray(rules)) {
                throw new ValidationError('Rules must be an array');
            }

            const created: RateLimitRule[] = [];
            const errors: any[] = [];

            for (const ruleData of rules) {
                try {
                    const rule = this.validateRule(ruleData);
                    this.rateLimiter.addRule(rule);
                    created.push(rule);
                } catch (error) {
                    errors.push({
                        rule: ruleData,
                        error: error.message
                    });
                }
            }

            res.status(errors.length > 0 ? 207 : 201).json({
                message: `Created ${created.length} rules`,
                created: created.map(r => this.sanitizeRule(r)),
                errors
            });
        } catch (error) {
            this.handleError(error, res);
        }
    }

    // 一括ルール更新
    private async bulkUpdateRules(req: Request, res: Response): Promise<void> {
        try {
            const { rules } = req.body;

            if (!Array.isArray(rules)) {
                throw new ValidationError('Rules must be an array');
            }

            const updated: RateLimitRule[] = [];
            const errors: any[] = [];

            for (const ruleData of rules) {
                try {
                    const rule = this.validateRule(ruleData);
                    this.rateLimiter.updateRule(rule);
                    updated.push(rule);
                } catch (error) {
                    errors.push({
                        rule: ruleData,
                        error: error.message
                    });
                }
            }

            res.status(errors.length > 0 ? 207 : 200).json({
                message: `Updated ${updated.length} rules`,
                updated: updated.map(r => this.sanitizeRule(r)),
                errors
            });
        } catch (error) {
            this.handleError(error, res);
        }
    }

    // プリセット一覧取得
    private async getPresets(req: Request, res: Response): Promise<void> {
        const presets = {
            strict: {
                name: 'Strict',
                description: 'Strict rate limiting for production',
                rules: [
                    {
                        id: 'api-strict',
                        name: 'Strict API Limit',
                        path: '/api/*',
                        rateLimit: { windowMs: 60000, maxRequests: 30 },
                        enabled: true,
                        priority: 5
                    },
                    {
                        id: 'auth-very-strict',
                        name: 'Very Strict Auth Limit',
                        path: '/api/auth/*',
                        rateLimit: { windowMs: 900000, maxRequests: 3 },
                        enabled: true,
                        priority: 10
                    }
                ]
            },
            relaxed: {
                name: 'Relaxed',
                description: 'Relaxed rate limiting for development',
                rules: [
                    {
                        id: 'api-relaxed',
                        name: 'Relaxed API Limit',
                        path: '/api/*',
                        rateLimit: { windowMs: 60000, maxRequests: 1000 },
                        enabled: true,
                        priority: 5
                    }
                ]
            },
            mining_optimized: {
                name: 'Mining Optimized',
                description: 'Optimized for mining pool operations',
                rules: [
                    {
                        id: 'mining-shares',
                        name: 'Share Submission Limit',
                        path: '/api/shares',
                        method: 'POST',
                        rateLimit: { windowMs: 10000, maxRequests: 100 },
                        enabled: true,
                        priority: 8
                    },
                    {
                        id: 'mining-stats',
                        name: 'Stats Query Limit',
                        path: '/api/stats/*',
                        rateLimit: { windowMs: 30000, maxRequests: 60 },
                        enabled: true,
                        priority: 6
                    },
                    {
                        id: 'mining-workers',
                        name: 'Worker Updates Limit',
                        path: '/api/workers/*',
                        rateLimit: { windowMs: 60000, maxRequests: 120 },
                        enabled: true,
                        priority: 7
                    }
                ]
            }
        };

        res.json(presets);
    }

    // プリセット適用
    private async applyPreset(req: Request, res: Response): Promise<void> {
        try {
            const { name } = req.params;
            const { clearExisting = false } = req.body;

            const presets: any = {
                strict: this.getStrictPreset(),
                relaxed: this.getRelaxedPreset(),
                mining_optimized: this.getMiningOptimizedPreset()
            };

            const preset = presets[name];
            if (!preset) {
                res.status(404).json({
                    error: 'Preset not found',
                    code: 'PRESET_NOT_FOUND'
                });
                return;
            }

            // 既存ルールをクリア（オプション）
            if (clearExisting) {
                const existingRules = this.rateLimiter.getRules();
                existingRules.forEach(rule => {
                    if (!this.isProtectedRule(rule.id)) {
                        this.rateLimiter.removeRule(rule.id);
                    }
                });
            }

            // プリセットルールを適用
            const applied: RateLimitRule[] = [];
            for (const rule of preset) {
                try {
                    this.rateLimiter.addRule(rule);
                    applied.push(rule);
                } catch (error) {
                    // ルールが既に存在する場合は更新
                    this.rateLimiter.updateRule(rule);
                    applied.push(rule);
                }
            }

            res.json({
                message: `Applied ${name} preset successfully`,
                applied: applied.map(r => this.sanitizeRule(r))
            });
        } catch (error) {
            this.handleError(error, res);
        }
    }

    // レート制限テスト
    private async testRateLimit(req: Request, res: Response): Promise<void> {
        try {
            const { path, method = 'GET', ip = '127.0.0.1', count = 1 } = req.body;

            if (!path) {
                throw new ValidationError('Path is required');
            }

            const results = [];
            for (let i = 0; i < count; i++) {
                const mockReq = { path, method, ip };
                const result = this.rateLimiter.checkRateLimit(mockReq);
                results.push({
                    attempt: i + 1,
                    allowed: result.allowed,
                    remaining: result.rateLimitInfo.remaining,
                    rule: result.rule ? result.rule.name : 'No rule applied'
                });
            }

            res.json({
                test: { path, method, ip, count },
                results,
                summary: {
                    allowed: results.filter(r => r.allowed).length,
                    blocked: results.filter(r => !r.allowed).length
                }
            });
        } catch (error) {
            this.handleError(error, res);
        }
    }

    // ヘルパーメソッド
    private validateRule(data: any): RateLimitRule {
        const errors: string[] = [];

        if (!data.id || typeof data.id !== 'string') {
            errors.push('Rule ID is required and must be a string');
        }

        if (!data.name || typeof data.name !== 'string') {
            errors.push('Rule name is required and must be a string');
        }

        if (!data.path || typeof data.path !== 'string') {
            errors.push('Rule path is required and must be a string');
        }

        if (!data.rateLimit || typeof data.rateLimit !== 'object') {
            errors.push('Rate limit configuration is required');
        } else {
            if (!data.rateLimit.windowMs || data.rateLimit.windowMs < 1000) {
                errors.push('Window must be at least 1000ms');
            }

            if (!data.rateLimit.maxRequests || data.rateLimit.maxRequests < 1) {
                errors.push('Max requests must be at least 1');
            }
        }

        if (data.priority !== undefined && (typeof data.priority !== 'number' || data.priority < 0)) {
            errors.push('Priority must be a non-negative number');
        }

        if (errors.length > 0) {
            throw new ValidationError(errors.join(', '));
        }

        return {
            id: data.id,
            name: data.name,
            path: data.path,
            method: data.method,
            rateLimit: {
                windowMs: data.rateLimit.windowMs,
                maxRequests: data.rateLimit.maxRequests,
                keyGenerator: data.rateLimit.keyGenerator,
                skipIf: data.rateLimit.skipIf,
                onLimitReached: data.rateLimit.onLimitReached
            },
            enabled: data.enabled !== false,
            priority: data.priority || 5
        };
    }

    private sanitizeRule(rule: RateLimitRule): any {
        return {
            id: rule.id,
            name: rule.name,
            path: rule.path,
            method: rule.method,
            rateLimit: {
                windowMs: rule.rateLimit.windowMs,
                maxRequests: rule.rateLimit.maxRequests,
                hasKeyGenerator: !!rule.rateLimit.keyGenerator,
                hasSkipIf: !!rule.rateLimit.skipIf,
                hasOnLimitReached: !!rule.rateLimit.onLimitReached
            },
            enabled: rule.enabled,
            priority: rule.priority
        };
    }

    private isProtectedRule(id: string): boolean {
        const protectedRules = ['api-general', 'auth-strict'];
        return protectedRules.includes(id);
    }

    private handleError(error: any, res: Response): void {
        if (error instanceof ValidationError) {
            res.status(400).json({
                error: 'Validation Error',
                message: error.message,
                code: 'VALIDATION_ERROR'
            });
        } else {
            this.logger.error('Rate limit API error', error);
            res.status(500).json({
                error: 'Internal Server Error',
                message: 'An unexpected error occurred',
                code: 'INTERNAL_ERROR'
            });
        }
    }

    // プリセット定義
    private getStrictPreset(): RateLimitRule[] {
        return [
            {
                id: 'api-strict',
                name: 'Strict API Limit',
                path: '/api/*',
                rateLimit: { windowMs: 60000, maxRequests: 30 },
                enabled: true,
                priority: 5
            },
            {
                id: 'auth-very-strict',
                name: 'Very Strict Auth Limit',
                path: '/api/auth/*',
                rateLimit: { windowMs: 900000, maxRequests: 3 },
                enabled: true,
                priority: 10
            }
        ];
    }

    private getRelaxedPreset(): RateLimitRule[] {
        return [
            {
                id: 'api-relaxed',
                name: 'Relaxed API Limit',
                path: '/api/*',
                rateLimit: { windowMs: 60000, maxRequests: 1000 },
                enabled: true,
                priority: 5
            }
        ];
    }

    private getMiningOptimizedPreset(): RateLimitRule[] {
        return [
            {
                id: 'mining-shares',
                name: 'Share Submission Limit',
                path: '/api/shares',
                method: 'POST',
                rateLimit: { windowMs: 10000, maxRequests: 100 },
                enabled: true,
                priority: 8
            },
            {
                id: 'mining-stats',
                name: 'Stats Query Limit',
                path: '/api/stats/*',
                rateLimit: { windowMs: 30000, maxRequests: 60 },
                enabled: true,
                priority: 6
            },
            {
                id: 'mining-workers',
                name: 'Worker Updates Limit',
                path: '/api/workers/*',
                rateLimit: { windowMs: 60000, maxRequests: 120 },
                enabled: true,
                priority: 7
            }
        ];
    }

    public getRouter(): Router {
        return this.router;
    }
}
