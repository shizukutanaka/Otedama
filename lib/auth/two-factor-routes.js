/**
 * Two-Factor Authentication API Routes
 */

import express from 'express';
import { TwoFactorAuth, TwoFactorRateLimiter, createTwoFactorMiddleware } from './two-factor-auth.js';

export function createTwoFactorRoutes(options = {}) {
    const router = express.Router();
    
    // Initialize 2FA service
    const twoFactorAuth = new TwoFactorAuth({
        issuer: options.issuer || 'Otedama',
        ...options
    });
    
    // Rate limiter for 2FA attempts
    const rateLimiter = new TwoFactorRateLimiter({
        maxAttempts: 5,
        windowMs: 900000, // 15 minutes
        blockDurationMs: 3600000 // 1 hour
    });
    
    // Cleanup interval
    setInterval(() => {
        twoFactorAuth.cleanupPendingSetups();
        rateLimiter.cleanup();
    }, 300000); // 5 minutes
    
    /**
     * Setup 2FA - Generate secret and QR code
     */
    router.post('/2fa/setup', async (req, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            
            // Check if already enabled
            if (twoFactorAuth.isEnabled(req.user.id)) {
                return res.status(400).json({ error: '2FA already enabled' });
            }
            
            // Generate secret
            const setup = await twoFactorAuth.generateSecret(
                req.user.id,
                req.user.email || req.user.username
            );
            
            res.json({
                qrCode: setup.qrCode,
                secret: setup.manualEntry,
                backupCodes: setup.backupCodes
            });
            
        } catch (error) {
            console.error('2FA setup error:', error);
            res.status(500).json({ error: 'Failed to setup 2FA' });
        }
    });
    
    /**
     * Enable 2FA - Verify initial token
     */
    router.post('/2fa/enable', async (req, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            
            const { token } = req.body;
            if (!token) {
                return res.status(400).json({ error: 'Verification token required' });
            }
            
            // Enable 2FA
            const result = await twoFactorAuth.enableTwoFactor(req.user.id, token);
            
            res.json({
                success: true,
                message: '2FA enabled successfully',
                backupCodes: result.backupCodes
            });
            
        } catch (error) {
            console.error('2FA enable error:', error);
            res.status(400).json({ error: error.message });
        }
    });
    
    /**
     * Disable 2FA
     */
    router.post('/2fa/disable', async (req, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            
            const { token } = req.body;
            if (!token) {
                return res.status(400).json({ error: 'Verification token required' });
            }
            
            // Disable 2FA
            await twoFactorAuth.disableTwoFactor(req.user.id, token);
            
            res.json({
                success: true,
                message: '2FA disabled successfully'
            });
            
        } catch (error) {
            console.error('2FA disable error:', error);
            res.status(400).json({ error: error.message });
        }
    });
    
    /**
     * Verify 2FA token
     */
    router.post('/2fa/verify', async (req, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            
            const { token } = req.body;
            if (!token) {
                return res.status(400).json({ error: 'Verification token required' });
            }
            
            // Check rate limit
            if (rateLimiter.isBlocked(req.user.id)) {
                const remainingTime = rateLimiter.getRemainingBlockTime(req.user.id);
                return res.status(429).json({
                    error: 'Too many failed attempts',
                    retryAfter: Math.ceil(remainingTime / 1000)
                });
            }
            
            // Verify token
            const result = await twoFactorAuth.verifyUserToken(req.user.id, token);
            
            if (!result.valid) {
                // Record failed attempt
                const rateLimit = rateLimiter.recordFailedAttempt(req.user.id);
                
                return res.status(400).json({
                    error: result.reason,
                    remainingAttempts: rateLimit.remainingAttempts,
                    blocked: rateLimit.blocked,
                    retryAfter: rateLimit.blocked ? Math.ceil(rateLimit.remainingTime / 1000) : null
                });
            }
            
            // Clear rate limit on success
            rateLimiter.clearAttempts(req.user.id);
            
            // Mark as verified in session
            if (req.session) {
                req.session.twoFactorVerified = true;
            }
            
            res.json({
                success: true,
                method: result.method,
                remainingBackupCodes: result.remainingCodes
            });
            
        } catch (error) {
            console.error('2FA verify error:', error);
            res.status(500).json({ error: 'Verification failed' });
        }
    });
    
    /**
     * Regenerate backup codes
     */
    router.post('/2fa/backup-codes/regenerate', async (req, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            
            const { token } = req.body;
            if (!token) {
                return res.status(400).json({ error: 'Verification token required' });
            }
            
            // Regenerate codes
            const result = await twoFactorAuth.regenerateBackupCodes(req.user.id, token);
            
            res.json({
                success: true,
                backupCodes: result.backupCodes
            });
            
        } catch (error) {
            console.error('Backup codes regeneration error:', error);
            res.status(400).json({ error: error.message });
        }
    });
    
    /**
     * Get 2FA status
     */
    router.get('/2fa/status', async (req, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            
            const enabled = twoFactorAuth.isEnabled(req.user.id);
            const remainingBackupCodes = enabled ? 
                twoFactorAuth.getRemainingBackupCodes(req.user.id) : 0;
            
            res.json({
                enabled,
                remainingBackupCodes,
                verified: req.session?.twoFactorVerified || false
            });
            
        } catch (error) {
            console.error('2FA status error:', error);
            res.status(500).json({ error: 'Failed to get 2FA status' });
        }
    });
    
    return {
        router,
        twoFactorAuth,
        middleware: createTwoFactorMiddleware(twoFactorAuth)
    };
}

/**
 * WebSocket 2FA handler
 */
export function createWebSocket2FAHandler(twoFactorAuth) {
    return async (connection, message) => {
        const { action, token } = message;
        
        if (!connection.authenticated || !connection.metadata.userId) {
            throw new Error('Authentication required');
        }
        
        const userId = connection.metadata.userId;
        
        switch (action) {
            case 'verify':
                const result = await twoFactorAuth.verifyUserToken(userId, token);
                
                if (result.valid) {
                    connection.metadata.twoFactorVerified = true;
                    
                    return {
                        type: '2fa:verified',
                        method: result.method,
                        remainingBackupCodes: result.remainingCodes
                    };
                } else {
                    throw new Error(result.reason);
                }
                
            case 'status':
                const enabled = twoFactorAuth.isEnabled(userId);
                const verified = connection.metadata.twoFactorVerified || false;
                
                return {
                    type: '2fa:status',
                    enabled,
                    verified,
                    remainingBackupCodes: enabled ? 
                        twoFactorAuth.getRemainingBackupCodes(userId) : 0
                };
                
            default:
                throw new Error('Invalid 2FA action');
        }
    };
}

export default createTwoFactorRoutes;