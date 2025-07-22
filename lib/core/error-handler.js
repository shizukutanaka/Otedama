const { EventEmitter } = require('events');
const fs = require('fs').promises;
const path = require('path');

/**
 * 統一的なエラーハンドリングシステム
 */
class ErrorHandler extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            logPath: config.logPath || './logs/errors',
            maxRetries: config.maxRetries || 3,
            retryDelay: config.retryDelay || 1000,
            alertThreshold: config.alertThreshold || 10,
            alertInterval: config.alertInterval || 300000, // 5分
            ...config
        };
        
        this.errorCounts = new Map();
        this.retryQueues = new Map();
        this.alertsSent = new Map();
        
        this.initializeErrorTypes();
        this.setupGlobalHandlers();
    }
    
    /**
     * エラータイプを初期化
     */
    initializeErrorTypes() {
        this.errorTypes = {
            NETWORK_ERROR: {
                severity: 'medium',
                retryable: true,
                alert: true
            },
            DATABASE_ERROR: {
                severity: 'high',
                retryable: true,
                alert: true
            },
            VALIDATION_ERROR: {
                severity: 'low',
                retryable: false,
                alert: false
            },
            AUTHENTICATION_ERROR: {
                severity: 'high',
                retryable: false,
                alert: true
            },
            BLOCKCHAIN_ERROR: {
                severity: 'high',
                retryable: true,
                alert: true
            },
            RESOURCE_ERROR: {
                severity: 'critical',
                retryable: false,
                alert: true
            },
            BUSINESS_LOGIC_ERROR: {
                severity: 'medium',
                retryable: false,
                alert: false
            }
        };
    }
    
    /**
     * グローバルエラーハンドラーを設定
     */
    setupGlobalHandlers() {
        // 未処理のPromiseリジェクション
        process.on('unhandledRejection', (reason, promise) => {
            this.handleError(new Error(`Unhandled Rejection: ${reason}`), {
                type: 'UNHANDLED_REJECTION',
                promise
            });
        });
        
        // 未処理の例外
        process.on('uncaughtException', (error) => {
            this.handleError(error, {
                type: 'UNCAUGHT_EXCEPTION',
                critical: true
            });
            
            // クリティカルエラーの場合は適切にシャットダウン
            this.gracefulShutdown();
        });
        
        // 警告
        process.on('warning', (warning) => {
            this.handleWarning(warning);
        });
    }
    
    /**
     * エラーを処理
     */
    async handleError(error, context = {}) {
        const errorInfo = this.enrichError(error, context);
        
        // エラーをログに記録
        await this.logError(errorInfo);
        
        // エラーカウントを更新
        this.updateErrorCount(errorInfo.type);
        
        // アラートが必要か確認
        if (this.shouldAlert(errorInfo)) {
            this.sendAlert(errorInfo);
        }
        
        // リトライ可能か確認
        if (this.shouldRetry(errorInfo)) {
            return this.scheduleRetry(errorInfo);
        }
        
        // エラーイベントを発行
        this.emit('error', errorInfo);
        
        return errorInfo;
    }
    
    /**
     * エラー情報を拡充
     */
    enrichError(error, context) {
        const type = context.type || this.classifyError(error);
        const errorType = this.errorTypes[type] || this.errorTypes.BUSINESS_LOGIC_ERROR;
        
        return {
            id: this.generateErrorId(),
            timestamp: new Date().toISOString(),
            type,
            severity: errorType.severity,
            message: error.message,
            stack: error.stack,
            code: error.code,
            context: {
                ...context,
                hostname: require('os').hostname(),
                pid: process.pid,
                memory: process.memoryUsage(),
                uptime: process.uptime()
            },
            retryable: errorType.retryable,
            retryCount: context.retryCount || 0
        };
    }
    
    /**
     * エラーを分類
     */
    classifyError(error) {
        if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
            return 'NETWORK_ERROR';
        }
        
        if (error.message.includes('database') || error.message.includes('SQLITE')) {
            return 'DATABASE_ERROR';
        }
        
        if (error.message.includes('validation') || error.message.includes('invalid')) {
            return 'VALIDATION_ERROR';
        }
        
        if (error.message.includes('auth') || error.message.includes('permission')) {
            return 'AUTHENTICATION_ERROR';
        }
        
        if (error.message.includes('blockchain') || error.message.includes('rpc')) {
            return 'BLOCKCHAIN_ERROR';
        }
        
        if (error.code === 'ENOMEM' || error.code === 'ENOSPC') {
            return 'RESOURCE_ERROR';
        }
        
        return 'BUSINESS_LOGIC_ERROR';
    }
    
    /**
     * エラーをログに記録
     */
    async logError(errorInfo) {
        const logDir = path.join(this.config.logPath, errorInfo.severity);
        const logFile = path.join(logDir, `${errorInfo.timestamp.split('T')[0]}.log`);
        
        try {
            await fs.mkdir(logDir, { recursive: true });
            
            const logEntry = JSON.stringify(errorInfo) + '\n';
            await fs.appendFile(logFile, logEntry);
            
        } catch (logError) {
            // ログ書き込みエラーは別途処理
            console.error('Failed to write error log:', logError);
        }
    }
    
    /**
     * エラーカウントを更新
     */
    updateErrorCount(type) {
        const count = this.errorCounts.get(type) || 0;
        this.errorCounts.set(type, count + 1);
        
        // 定期的にカウントをリセット
        setTimeout(() => {
            this.errorCounts.set(type, 0);
        }, this.config.alertInterval);
    }
    
    /**
     * アラートが必要か判定
     */
    shouldAlert(errorInfo) {
        const errorType = this.errorTypes[errorInfo.type];
        if (!errorType || !errorType.alert) {
            return false;
        }
        
        const count = this.errorCounts.get(errorInfo.type) || 0;
        if (count < this.config.alertThreshold) {
            return false;
        }
        
        const lastAlert = this.alertsSent.get(errorInfo.type);
        if (lastAlert && Date.now() - lastAlert < this.config.alertInterval) {
            return false;
        }
        
        return true;
    }
    
    /**
     * アラートを送信
     */
    sendAlert(errorInfo) {
        this.alertsSent.set(errorInfo.type, Date.now());
        
        this.emit('alert', {
            type: errorInfo.type,
            severity: errorInfo.severity,
            count: this.errorCounts.get(errorInfo.type),
            message: `High error rate detected: ${errorInfo.type}`,
            errorInfo
        });
    }
    
    /**
     * リトライが必要か判定
     */
    shouldRetry(errorInfo) {
        return errorInfo.retryable && errorInfo.retryCount < this.config.maxRetries;
    }
    
    /**
     * リトライをスケジュール
     */
    async scheduleRetry(errorInfo) {
        const retryCount = errorInfo.retryCount + 1;
        const delay = this.config.retryDelay * Math.pow(2, retryCount - 1); // 指数バックオフ
        
        return new Promise((resolve) => {
            setTimeout(() => {
                this.emit('retry', {
                    ...errorInfo,
                    retryCount,
                    delay
                });
                resolve({ retry: true, retryCount, delay });
            }, delay);
        });
    }
    
    /**
     * 警告を処理
     */
    handleWarning(warning) {
        this.emit('warning', {
            timestamp: new Date().toISOString(),
            name: warning.name,
            message: warning.message,
            stack: warning.stack
        });
    }
    
    /**
     * グレースフルシャットダウン
     */
    async gracefulShutdown() {
        console.error('Critical error detected. Initiating graceful shutdown...');
        
        this.emit('shutdown');
        
        // クリーンアップ処理
        try {
            // 保留中のログを書き込み
            await this.flushLogs();
            
            // リソースを解放
            this.cleanup();
            
            // 少し待ってから終了
            setTimeout(() => {
                process.exit(1);
            }, 1000);
            
        } catch (error) {
            console.error('Error during shutdown:', error);
            process.exit(1);
        }
    }
    
    /**
     * エラーIDを生成
     */
    generateErrorId() {
        return `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    /**
     * ログをフラッシュ
     */
    async flushLogs() {
        // 実装依存
    }
    
    /**
     * クリーンアップ
     */
    cleanup() {
        this.removeAllListeners();
        this.errorCounts.clear();
        this.retryQueues.clear();
        this.alertsSent.clear();
    }
    
    /**
     * エラー統計を取得
     */
    getStats() {
        const stats = {
            errors: {},
            alerts: {},
            totalErrors: 0
        };
        
        this.errorCounts.forEach((count, type) => {
            stats.errors[type] = count;
            stats.totalErrors += count;
        });
        
        this.alertsSent.forEach((timestamp, type) => {
            stats.alerts[type] = new Date(timestamp).toISOString();
        });
        
        return stats;
    }
    
    /**
     * エラーハンドリングをラップ
     */
    wrap(fn, context = {}) {
        return async (...args) => {
            try {
                return await fn(...args);
            } catch (error) {
                return this.handleError(error, context);
            }
        };
    }
    
    /**
     * Express用エラーミドルウェア
     */
    expressMiddleware() {
        return (err, req, res, next) => {
            this.handleError(err, {
                type: 'HTTP_ERROR',
                method: req.method,
                url: req.url,
                ip: req.ip,
                userAgent: req.get('user-agent')
            });
            
            res.status(err.status || 500).json({
                error: {
                    message: err.message,
                    code: err.code || 'INTERNAL_ERROR'
                }
            });
        };
    }
}

// シングルトンインスタンス
let instance = null;

module.exports = {
    ErrorHandler,
    
    /**
     * シングルトンインスタンスを取得
     */
    getInstance(config) {
        if (!instance) {
            instance = new ErrorHandler(config);
        }
        return instance;
    },
    
    /**
     * カスタムエラークラス
     */
    OtedamaError: class OtedamaError extends Error {
        constructor(message, code, statusCode = 500) {
            super(message);
            this.name = 'OtedamaError';
            this.code = code;
            this.statusCode = statusCode;
        }
    },
    
    ValidationError: class ValidationError extends Error {
        constructor(message, field) {
            super(message);
            this.name = 'ValidationError';
            this.field = field;
            this.statusCode = 400;
        }
    },
    
    AuthenticationError: class AuthenticationError extends Error {
        constructor(message = 'Authentication failed') {
            super(message);
            this.name = 'AuthenticationError';
            this.statusCode = 401;
        }
    },
    
    AuthorizationError: class AuthorizationError extends Error {
        constructor(message = 'Access denied') {
            super(message);
            this.name = 'AuthorizationError';
            this.statusCode = 403;
        }
    },
    
    NotFoundError: class NotFoundError extends Error {
        constructor(resource) {
            super(`${resource} not found`);
            this.name = 'NotFoundError';
            this.statusCode = 404;
        }
    }
};