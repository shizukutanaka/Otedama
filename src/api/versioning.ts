/**
 * API Versioning Middleware
 * 
 * 設計原則（Rob Pike風）:
 * - シンプルさを優先
 * - 明確なインターフェース
 * - 後方互換性を保証
 */

import { Request, Response, NextFunction, Router } from 'express';
import { createLogger } from '../utils/logger';
import { ValidationError } from '../errors/pool-errors';

const logger = createLogger('APIVersioning');

export interface ApiVersion {
    version: string;
    deprecated?: boolean;
    deprecationDate?: Date;
    removalDate?: Date;
    changes?: string[];
}

export interface VersionedRoute {
    path: string;
    method: string;
    versions: {
        [version: string]: any; // Handler function
    };
    defaultVersion?: string;
}

export class ApiVersionManager {
    private versions: Map<string, ApiVersion> = new Map();
    private routes: Map<string, VersionedRoute> = new Map();
    private defaultVersion: string = 'v1';
    private latestVersion: string = 'v1';

    constructor() {
        this.initializeVersions();
    }

    private initializeVersions(): void {
        // バージョン定義
        this.addVersion({
            version: 'v1',
            deprecated: false,
        });

        this.addVersion({
            version: 'v2',
            deprecated: false,
            changes: [
                'Enhanced miner stats with additional metrics',
                'New payment calculation algorithm',
                'Improved error responses with error codes',
                'WebSocket support for real-time updates',
            ],
        });

        this.addVersion({
            version: 'v3-beta',
            deprecated: false,
            changes: [
                'GraphQL endpoint integration',
                'Batch operations support',
                'Advanced filtering and sorting',
                'Response field selection',
            ],
        });

        this.latestVersion = 'v2';
    }

    public addVersion(version: ApiVersion): void {
        this.versions.set(version.version, version);
        logger.info(`API version ${version.version} registered`, version);
    }

    public addRoute(route: VersionedRoute): void {
        const key = `${route.method}:${route.path}`;
        this.routes.set(key, route);
    }

    /**
     * バージョン検出ミドルウェア
     * Accept-Version ヘッダー、URLパス、クエリパラメータから検出
     */
    public versionDetectionMiddleware() {
        return (req: Request, res: Response, next: NextFunction) => {
            let version = this.defaultVersion;

            // 1. Accept-Version ヘッダーから検出（推奨）
            const acceptVersion = req.headers['accept-version'] as string;
            if (acceptVersion && this.versions.has(acceptVersion)) {
                version = acceptVersion;
            }

            // 2. URLパスから検出（例: /api/v2/...）
            const pathMatch = req.path.match(/^\/api\/(v\d+(?:-\w+)?)\//);
            if (pathMatch && this.versions.has(pathMatch[1])) {
                version = pathMatch[1];
            }

            // 3. クエリパラメータから検出（例: ?api_version=v2）
            const queryVersion = req.query.api_version as string;
            if (queryVersion && this.versions.has(queryVersion)) {
                version = queryVersion;
            }

            // バージョン情報をリクエストに追加
            (req as any).apiVersion = version;
            const versionInfo = this.versions.get(version);

            // レスポンスヘッダーに情報を追加
            res.setHeader('X-API-Version', version);
            res.setHeader('X-Latest-Version', this.latestVersion);

            // 非推奨バージョンの警告
            if (versionInfo?.deprecated) {
                res.setHeader('X-API-Deprecated', 'true');
                if (versionInfo.deprecationDate) {
                    res.setHeader('X-API-Deprecation-Date', versionInfo.deprecationDate.toISOString());
                }
                if (versionInfo.removalDate) {
                    res.setHeader('X-API-Removal-Date', versionInfo.removalDate.toISOString());
                }
                res.setHeader('Warning', `299 - "This API version is deprecated. Please upgrade to ${this.latestVersion}"`);
            }

            logger.debug(`API request using version ${version}`, {
                path: req.path,
                method: req.method,
                userAgent: req.headers['user-agent'],
            });

            next();
        };
    }

    /**
     * バージョン別ルーティング
     */
    public createVersionedRouter(): Router {
        const router = Router();

        // 各ルートに対してバージョン別のハンドラーを設定
        this.routes.forEach((route, key) => {
            const [method, path] = key.split(':');
            
            (router as any)[method.toLowerCase()](path, (req: Request, res: Response, next: NextFunction) => {
                const version = (req as any).apiVersion || this.defaultVersion;
                const handler = route.versions[version] || route.versions[route.defaultVersion || this.defaultVersion];

                if (!handler) {
                    return res.status(404).json({
                        error: 'Version Not Found',
                        message: `This endpoint is not available in API version ${version}`,
                        availableVersions: Object.keys(route.versions),
                    });
                }

                handler(req, res, next);
            });
        });

        return router;
    }

    /**
     * バージョン間の変換ヘルパー
     */
    public transformResponse(data: any, fromVersion: string, toVersion: string): any {
        // バージョン間の変換ロジック
        if (fromVersion === 'v2' && toVersion === 'v1') {
            // v2からv1への変換例
            return this.transformV2ToV1(data);
        }
        
        if (fromVersion === 'v1' && toVersion === 'v2') {
            // v1からv2への変換例
            return this.transformV1ToV2(data);
        }

        return data;
    }

    private transformV2ToV1(data: any): any {
        // v2特有のフィールドを削除または変換
        if (data.minerStats) {
            // v2の詳細な統計をv1のシンプルな形式に変換
            data.minerStats = {
                hashrate: data.minerStats.currentHashrate,
                shares: data.minerStats.validShares,
                balance: data.minerStats.unpaidBalance,
            };
            delete data.minerStats.hashrate24h;
            delete data.minerStats.efficiency;
        }

        if (data.payments) {
            // v2のpayment構造をv1に変換
            data.payments = data.payments.map((payment: any) => ({
                amount: payment.amount,
                timestamp: payment.timestamp,
                txHash: payment.transactionHash,
            }));
        }

        return data;
    }

    private transformV1ToV2(data: any): any {
        // v1のデータをv2の拡張形式に変換
        if (data.minerStats) {
            // 基本的な統計を拡張
            data.minerStats = {
                currentHashrate: data.minerStats.hashrate,
                hashrate24h: data.minerStats.hashrate, // 仮の値
                validShares: data.minerStats.shares,
                invalidShares: 0, // デフォルト値
                unpaidBalance: data.minerStats.balance,
                paidTotal: 0, // デフォルト値
                efficiency: 100, // デフォルト値
            };
        }

        if (data.payments) {
            // payment構造を拡張
            data.payments = data.payments.map((payment: any) => ({
                id: Math.random().toString(36).substr(2, 9), // 仮のID
                amount: payment.amount,
                timestamp: payment.timestamp,
                transactionHash: payment.txHash,
                status: 'confirmed', // デフォルト値
                confirmations: 6, // デフォルト値
            }));
        }

        return data;
    }

    /**
     * APIバージョン情報エンドポイント
     */
    public getVersionInfoHandler() {
        return (req: Request, res: Response) => {
            const versions = Array.from(this.versions.values());
            const current = (req as any).apiVersion || this.defaultVersion;

            res.json({
                current,
                latest: this.latestVersion,
                default: this.defaultVersion,
                versions: versions.map(v => ({
                    version: v.version,
                    deprecated: v.deprecated || false,
                    deprecationDate: v.deprecationDate,
                    removalDate: v.removalDate,
                    changes: v.changes || [],
                })),
                recommendedVersion: this.latestVersion,
                migrationGuide: `https://docs.otedama-pool.com/api/migration/${current}-to-${this.latestVersion}`,
            });
        };
    }

    /**
     * 後方互換性チェック
     */
    public checkBackwardCompatibility(oldVersion: string, newVersion: string): {
        compatible: boolean;
        breakingChanges: string[];
        migrationSteps: string[];
    } {
        const result = {
            compatible: true,
            breakingChanges: [] as string[],
            migrationSteps: [] as string[],
        };

        // バージョン間の互換性チェックロジック
        if (oldVersion === 'v1' && newVersion === 'v2') {
            result.breakingChanges = [
                'minerStats structure has changed',
                'payment response includes additional fields',
            ];
            result.migrationSteps = [
                'Update client to handle new minerStats fields',
                'Add support for payment status field',
            ];
        }

        if (oldVersion === 'v2' && newVersion === 'v3-beta') {
            result.compatible = false;
            result.breakingChanges = [
                'REST endpoints migrated to GraphQL',
                'Response format completely changed',
            ];
            result.migrationSteps = [
                'Implement GraphQL client',
                'Update all API calls to use new schema',
                'Test thoroughly before production deployment',
            ];
        }

        return result;
    }
}

/**
 * レスポンス変換ミドルウェア
 * クライアントが古いバージョンを要求した場合、新しいバージョンのレスポンスを変換
 */
export function createResponseTransformer(versionManager: ApiVersionManager) {
    return (req: Request, res: Response, next: NextFunction) => {
        const requestedVersion = (req as any).apiVersion;
        const actualVersion = res.locals.actualVersion || requestedVersion;

        if (requestedVersion !== actualVersion) {
            // レスポンスを傍受して変換
            const originalJson = res.json;
            res.json = function(data: any) {
                const transformed = versionManager.transformResponse(
                    data,
                    actualVersion,
                    requestedVersion
                );
                return originalJson.call(this, transformed);
            };
        }

        next();
    };
}

/**
 * バージョン別ハンドラーデコレーター（TypeScript用）
 */
export function ApiVersion(version: string) {
    return function(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const originalMethod = descriptor.value;

        descriptor.value = function(...args: any[]) {
            const req = args[0] as Request;
            const requestedVersion = (req as any).apiVersion;

            if (requestedVersion !== version) {
                logger.warn(`Version mismatch: requested ${requestedVersion}, handler for ${version}`);
            }

            return originalMethod.apply(this, args);
        };

        return descriptor;
    };
}

// エクスポート
export const versionManager = new ApiVersionManager();
