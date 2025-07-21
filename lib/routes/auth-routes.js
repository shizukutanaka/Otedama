/**
 * Authentication and Security Routes
 * Provides endpoints for authentication, session management, and API key management
 */

import express from 'express';
import { TwoFactorAuth, TwoFactorRateLimiter } from '../auth/two-factor-auth.js';

export function createAuthRoutes(securityMiddleware, authManager) {
    const router = express.Router();
    
    // Session-based authentication
    router.post('/api/auth/login', async (req, res, next) => {
        try {
            const { username, password, twoFactorCode } = req.body;
            
            // Validate input
            if (!username || !password) {
                return res.status(400).json({
                    success: false,
                    error: 'Username and password are required'
                });
            }
            
            const result = await authManager.authenticateUser({
                username,
                password,
                twoFactorCode,
                ipAddress: req.security?.ip || req.ip,
                userAgent: req.headers['user-agent']
            });
            
            if (result.user) {
                // Create session
                const session = await req.createSession(result.user.id, {
                    username: result.user.username,
                    role: result.user.role,
                    permissions: result.user.permissions
                });
                
                res.json({
                    success: true,
                    user: {
                        id: result.user.id,
                        username: result.user.username,
                        role: result.user.role
                    },
                    session: {
                        token: session.token,
                        expiresAt: session.expiresAt
                    }
                });
            } else {
                res.status(401).json({
                    success: false,
                    error: 'Invalid credentials'
                });
            }
        } catch (error) {
            next(error);
        }
    });
    
    router.post('/api/auth/logout', securityMiddleware.requireAuth(), async (req, res, next) => {
        try {
            if (req.session) {
                await req.session.destroy();
            }
            
            res.json({ success: true, message: 'Logged out successfully' });
        } catch (error) {
            next(error);
        }
    });
    
    router.get('/api/auth/session', securityMiddleware.requireAuth(), (req, res) => {
        res.json({
            success: true,
            session: {
                userId: req.userId,
                data: req.session.data,
                expiresAt: req.session.expiresAt
            }
        });
    });
    
    router.post('/api/auth/refresh', securityMiddleware.requireAuth(), async (req, res, next) => {
        try {
            // Extend session expiration
            if (req.session && req.session.save) {
                await req.session.save({ lastRefresh: Date.now() });
            }
            
            res.json({
                success: true,
                expiresAt: req.session.expiresAt
            });
        } catch (error) {
            next(error);
        }
    });
    
    // API Key Management
    router.get('/api/keys', securityMiddleware.requireAuth(), async (req, res, next) => {
        try {
            const keys = await securityMiddleware.apiKeyManager.listKeys(req.userId, {
                includeRevoked: req.query.includeRevoked === 'true',
                includeExpired: req.query.includeExpired === 'true'
            });
            
            res.json({
                success: true,
                keys: keys.map(key => ({
                    id: key.id,
                    name: key.name,
                    prefix: key.key_prefix,
                    permissions: key.permissions,
                    scopes: key.scopes,
                    status: key.status,
                    lastUsed: key.last_used_at,
                    usageCount: key.usage_count,
                    expiresAt: key.expires_at,
                    createdAt: key.created_at
                }))
            });
        } catch (error) {
            next(error);
        }
    });
    
    router.post('/api/keys', securityMiddleware.requireAuth(), async (req, res, next) => {
        try {
            const { name, permissions, scopes, expiresIn, ipWhitelist, rateLimit } = req.body;
            
            // Validate input
            if (!name) {
                return res.status(400).json({
                    success: false,
                    error: 'API key name is required'
                });
            }
            
            const key = await securityMiddleware.apiKeyManager.generateKey(req.userId, {
                name,
                permissions: permissions || ['read'],
                scopes: scopes || [],
                expiresIn,
                ipWhitelist,
                rateLimit
            });
            
            res.json({
                success: true,
                key: {
                    id: key.id,
                    key: key.key, // Only time the full key is shown
                    name: key.name,
                    prefix: key.prefix,
                    permissions: key.permissions,
                    scopes: key.scopes,
                    expiresAt: key.expiresAt,
                    createdAt: key.createdAt
                },
                warning: 'Save this API key securely. You will not be able to see it again.'
            });
        } catch (error) {
            next(error);
        }
    });
    
    router.post('/api/keys/:id/rotate', securityMiddleware.requireAuth(), async (req, res, next) => {
        try {
            const newKey = await securityMiddleware.apiKeyManager.rotateKey(
                req.params.id,
                req.userId
            );
            
            res.json({
                success: true,
                newKey: {
                    id: newKey.id,
                    key: newKey.key, // Only time the full key is shown
                    rotationDeadline: newKey.rotationDeadline
                },
                warning: 'Save this new API key securely. The old key will stop working after the rotation deadline.'
            });
        } catch (error) {
            next(error);
        }
    });
    
    router.delete('/api/keys/:id', securityMiddleware.requireAuth(), async (req, res, next) => {
        try {
            await securityMiddleware.apiKeyManager.revokeKey(
                req.params.id,
                req.userId,
                req.body.reason || 'User requested'
            );
            
            res.json({
                success: true,
                message: 'API key revoked successfully'
            });
        } catch (error) {
            next(error);
        }
    });
    
    router.get('/api/keys/:id/stats', securityMiddleware.requireAuth(), async (req, res, next) => {
        try {
            const stats = await securityMiddleware.apiKeyManager.getKeyStats(
                req.params.id,
                req.userId,
                req.query.period || '24h'
            );
            
            res.json({
                success: true,
                stats
            });
        } catch (error) {
            next(error);
        }
    });
    
    router.patch('/api/keys/:id/permissions', securityMiddleware.requireAuth(), async (req, res, next) => {
        try {
            const { permissions } = req.body;
            
            if (!Array.isArray(permissions)) {
                return res.status(400).json({
                    success: false,
                    error: 'Permissions must be an array'
                });
            }
            
            await securityMiddleware.apiKeyManager.updateKeyPermissions(
                req.params.id,
                req.userId,
                permissions
            );
            
            res.json({
                success: true,
                message: 'API key permissions updated successfully'
            });
        } catch (error) {
            next(error);
        }
    });
    
    router.patch('/api/keys/:id/rate-limit', securityMiddleware.requireAuth(), async (req, res, next) => {
        try {
            const { requests, window, burst } = req.body;
            
            await securityMiddleware.apiKeyManager.updateKeyRateLimit(
                req.params.id,
                req.userId,
                { requests, window, burst }
            );
            
            res.json({
                success: true,
                message: 'API key rate limit updated successfully'
            });
        } catch (error) {
            next(error);
        }
    });
    
    // Security Status
    router.get('/api/auth/security-status', securityMiddleware.requireAuth(), (req, res) => {
        const report = securityMiddleware.getSecurityReport();
        
        res.json({
            success: true,
            security: {
                authenticated: req.security?.authenticated || false,
                authMethod: req.security?.authMethod,
                sessionActive: !!req.session,
                apiKeyActive: !!req.apiKey,
                csrfEnabled: !!securityMiddleware.csrfProtection,
                rateLimitStatus: report.rateLimit,
                stats: report.stats
            }
        });
    });
    
    // CSRF Token endpoint
    router.get('/api/auth/csrf-token', (req, res) => {
        if (req.csrfToken) {
            res.json({
                success: true,
                csrfToken: req.csrfToken()
            });
        } else {
            res.json({
                success: false,
                error: 'CSRF protection not enabled'
            });
        }
    });
    
    // Password reset request
    router.post('/api/auth/reset-password/request', async (req, res, next) => {
        try {
            const { email } = req.body;
            
            if (!email) {
                return res.status(400).json({
                    success: false,
                    error: 'Email is required'
                });
            }
            
            const passwordResetManager = authManager.passwordResetManager;
            const result = await passwordResetManager.requestReset(email);
            
            res.json(result);
        } catch (error) {
            next(error);
        }
    });
    
    // Verify reset token
    router.get('/api/auth/reset-password/verify', async (req, res, next) => {
        try {
            const { token } = req.query;
            
            if (!token) {
                return res.status(400).json({
                    success: false,
                    error: 'Reset token is required'
                });
            }
            
            const passwordResetManager = authManager.passwordResetManager;
            const result = await passwordResetManager.verifyToken(token);
            
            res.json({
                success: result.valid,
                valid: result.valid,
                ...(result.valid && { username: result.username })
            });
        } catch (error) {
            next(error);
        }
    });
    
    // Complete password reset
    router.post('/api/auth/reset-password/complete', async (req, res, next) => {
        try {
            const { token, newPassword } = req.body;
            
            if (!token || !newPassword) {
                return res.status(400).json({
                    success: false,
                    error: 'Token and new password are required'
                });
            }
            
            const passwordResetManager = authManager.passwordResetManager;
            const result = await passwordResetManager.resetPassword(token, newPassword);
            
            res.json(result);
        } catch (error) {
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    });
    
    // Two-factor authentication
    const twoFactorAuth = authManager.twoFactorAuth || new TwoFactorAuth();
    const twoFactorRateLimiter = new TwoFactorRateLimiter();
    
    // Generate 2FA secret
    router.post('/api/auth/2fa/generate', securityMiddleware.requireAuth(), async (req, res, next) => {
        try {
            const user = req.session?.data || req.user;
            const result = await twoFactorAuth.generateSecret(req.userId, user.email || user.username);
            
            res.json({
                success: true,
                secret: result.secret,
                qrCode: result.qrCode,
                manualEntry: result.manualEntry
            });
        } catch (error) {
            next(error);
        }
    });
    
    // Enable 2FA
    router.post('/api/auth/2fa/enable', securityMiddleware.requireAuth(), async (req, res, next) => {
        try {
            const { token } = req.body;
            
            if (!token) {
                return res.status(400).json({
                    success: false,
                    error: 'Verification token is required'
                });
            }
            
            // Check rate limit
            if (twoFactorRateLimiter.isBlocked(req.userId)) {
                return res.status(429).json({
                    success: false,
                    error: 'Too many failed attempts. Please try again later.'
                });
            }
            
            try {
                const result = await twoFactorAuth.enableTwoFactor(req.userId, token);
                
                // Clear rate limit on success
                twoFactorRateLimiter.clearAttempts(req.userId);
                
                res.json({
                    success: true,
                    backupCodes: result.backupCodes,
                    message: '2FA enabled successfully'
                });
            } catch (error) {
                // Record failed attempt
                const rateLimit = twoFactorRateLimiter.recordFailedAttempt(req.userId);
                
                if (rateLimit.blocked) {
                    return res.status(429).json({
                        success: false,
                        error: 'Too many failed attempts. Account temporarily locked.',
                        retryAfter: Math.ceil(rateLimit.remainingTime / 1000)
                    });
                }
                
                return res.status(400).json({
                    success: false,
                    error: error.message,
                    remainingAttempts: rateLimit.remainingAttempts
                });
            }
        } catch (error) {
            next(error);
        }
    });
    
    // Disable 2FA
    router.post('/api/auth/2fa/disable', securityMiddleware.requireAuth(), async (req, res, next) => {
        try {
            const { token } = req.body;
            
            if (!token) {
                return res.status(400).json({
                    success: false,
                    error: 'Verification token is required'
                });
            }
            
            const result = await twoFactorAuth.disableTwoFactor(req.userId, token);
            
            res.json({
                success: true,
                message: '2FA disabled successfully'
            });
        } catch (error) {
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    });
    
    // Verify 2FA token
    router.post('/api/auth/2fa/verify', securityMiddleware.requireAuth(), async (req, res, next) => {
        try {
            const { token } = req.body;
            
            if (!token) {
                return res.status(400).json({
                    success: false,
                    error: 'Verification token is required'
                });
            }
            
            const result = await twoFactorAuth.verifyUserToken(req.userId, token);
            
            if (result.valid) {
                // Mark as verified in session
                if (req.session && req.session.save) {
                    await req.session.save({ twoFactorVerified: true });
                }
                
                res.json({
                    success: true,
                    method: result.method,
                    ...(result.method === 'backup' && { remainingCodes: result.remainingCodes })
                });
            } else {
                res.status(400).json({
                    success: false,
                    error: result.reason
                });
            }
        } catch (error) {
            next(error);
        }
    });
    
    // Regenerate backup codes
    router.post('/api/auth/2fa/backup-codes', securityMiddleware.requireAuth(), async (req, res, next) => {
        try {
            const { token } = req.body;
            
            if (!token) {
                return res.status(400).json({
                    success: false,
                    error: 'Verification token is required'
                });
            }
            
            const result = await twoFactorAuth.regenerateBackupCodes(req.userId, token);
            
            res.json({
                success: true,
                backupCodes: result.backupCodes
            });
        } catch (error) {
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    });
    
    // Get 2FA status
    router.get('/api/auth/2fa/status', securityMiddleware.requireAuth(), (req, res) => {
        const enabled = twoFactorAuth.isEnabled(req.userId);
        const remainingBackupCodes = enabled ? twoFactorAuth.getRemainingBackupCodes(req.userId) : 0;
        
        res.json({
            success: true,
            enabled,
            remainingBackupCodes
        });
    });
    
    return router;
}

export default createAuthRoutes;