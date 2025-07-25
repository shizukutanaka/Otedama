const { StandardizedErrorHandler, ValidationError, AuthenticationError, getErrorHandler } = require('../../lib/core/standardized-error-handler');

describe('ErrorHandler', () => {
    let errorHandler;
    
    beforeEach(() => {
        errorHandler = new StandardizedErrorHandler({
            logPath: './test-logs',
            alertInterval: 1000,
            alertThreshold: 3
        });
    });
    
    afterEach(() => {
        errorHandler.cleanup();
    });
    
    describe('Error Classification', () => {
        test('should classify network errors correctly', () => {
            const error = new Error('Connection failed');
            error.code = 'ECONNREFUSED';
            
            const type = errorHandler.classifyError(error);
            expect(type).toBe('NETWORK_ERROR');
        });
        
        test('should classify database errors correctly', () => {
            const error = new Error('SQLITE_ERROR: database is locked');
            const type = errorHandler.classifyError(error);
            expect(type).toBe('DATABASE_ERROR');
        });
        
        test('should classify validation errors correctly', () => {
            const error = new Error('Invalid input validation failed');
            const type = errorHandler.classifyError(error);
            expect(type).toBe('VALIDATION_ERROR');
        });
        
        test('should classify authentication errors correctly', () => {
            const error = new Error('Authentication failed: invalid token');
            const type = errorHandler.classifyError(error);
            expect(type).toBe('AUTHENTICATION_ERROR');
        });
        
        test('should classify resource errors correctly', () => {
            const error = new Error('Out of memory');
            error.code = 'ENOMEM';
            const type = errorHandler.classifyError(error);
            expect(type).toBe('RESOURCE_ERROR');
        });
    });
    
    describe('Error Handling', () => {
        test('should handle errors and emit events', async () => {
            const errorSpy = jest.fn();
            errorHandler.on('error', errorSpy);
            
            const error = new Error('Test error');
            const result = await errorHandler.handleError(error, {
                type: 'TEST_ERROR',
                userId: 'test123'
            });
            
            expect(result).toHaveProperty('id');
            expect(result).toHaveProperty('timestamp');
            expect(result.message).toBe('Test error');
            expect(result.context.userId).toBe('test123');
            expect(errorSpy).toHaveBeenCalled();
        });
        
        test('should retry retryable errors', async () => {
            const retrySpy = jest.fn();
            errorHandler.on('retry', retrySpy);
            
            const error = new Error('Network timeout');
            error.code = 'ETIMEDOUT';
            
            const result = await errorHandler.handleError(error);
            
            expect(result.retry).toBe(true);
            expect(result.retryCount).toBe(1);
            expect(retrySpy).toHaveBeenCalled();
        });
        
        test('should send alerts when threshold exceeded', async () => {
            const alertSpy = jest.fn();
            errorHandler.on('alert', alertSpy);
            
            // トリガー複数のエラー
            for (let i = 0; i < 4; i++) {
                await errorHandler.handleError(new Error('DB Error'), {
                    type: 'DATABASE_ERROR'
                });
            }
            
            expect(alertSpy).toHaveBeenCalled();
            expect(alertSpy.mock.calls[0][0].type).toBe('DATABASE_ERROR');
        });
    });
    
    describe('Error Wrapping', () => {
        test('should wrap async functions', async () => {
            const asyncFunc = async (value) => {
                if (value < 0) {
                    throw new Error('Value must be positive');
                }
                return value * 2;
            };
            
            const wrapped = errorHandler.wrap(asyncFunc, { type: 'CALCULATION' });
            
            // 正常ケース
            const result = await wrapped(5);
            expect(result).toBe(10);
            
            // エラーケース
            const errorResult = await wrapped(-5);
            expect(errorResult).toHaveProperty('id');
            expect(errorResult.message).toBe('Value must be positive');
        });
    });
    
    describe('Express Middleware', () => {
        test('should handle Express errors', () => {
            const middleware = errorHandler.expressMiddleware();
            const req = global.testHelpers.mockRequest({
                method: 'POST',
                url: '/api/test',
                ip: '192.168.1.1'
            });
            const res = global.testHelpers.mockResponse();
            const next = jest.fn();
            
            const error = new Error('API Error');
            error.status = 400;
            
            middleware(error, req, res, next);
            
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({
                error: {
                    message: 'API Error',
                    code: 'INTERNAL_ERROR'
                }
            });
        });
    });
    
    describe('Custom Error Classes', () => {
        test('ValidationError should have correct properties', () => {
            const error = new ValidationError('Invalid email', 'email');
            expect(error.name).toBe('ValidationError');
            expect(error.message).toBe('Invalid email');
            expect(error.field).toBe('email');
            expect(error.statusCode).toBe(400);
        });
        
        test('AuthenticationError should have correct properties', () => {
            const error = new AuthenticationError();
            expect(error.name).toBe('AuthenticationError');
            expect(error.message).toBe('Authentication failed');
            expect(error.statusCode).toBe(401);
        });
    });
    
    describe('Statistics', () => {
        test('should track error statistics', async () => {
            await errorHandler.handleError(new Error('Error 1'), { type: 'TYPE_A' });
            await errorHandler.handleError(new Error('Error 2'), { type: 'TYPE_A' });
            await errorHandler.handleError(new Error('Error 3'), { type: 'TYPE_B' });
            
            const stats = errorHandler.getStats();
            expect(stats.errors.TYPE_A).toBe(2);
            expect(stats.errors.TYPE_B).toBe(1);
            expect(stats.totalErrors).toBe(3);
        });
    });
});