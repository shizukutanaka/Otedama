/**
 * Two-Factor Authentication Module
 * 
 * Implements TOTP (Time-based One-Time Password) for 2FA
 * Following security best practices
 */

import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import { randomBytes } from 'crypto';

export class TwoFactorAuth {
    constructor(options = {}) {
        this.issuer = options.issuer || 'Otedama';
        this.window = options.window || 2; // Accept codes from 2 windows before/after
        this.backupCodesCount = options.backupCodesCount || 10;
        this.secretLength = options.secretLength || 32;
        
        // In-memory storage (use database in production)
        this.userSecrets = new Map();
        this.backupCodes = new Map();
        this.pendingSetups = new Map();
    }
    
    /**
     * Generate 2FA secret for user
     */
    async generateSecret(userId, userEmail) {
        const secret = speakeasy.generateSecret({
            length: this.secretLength,
            name: `${this.issuer} (${userEmail})`,
            issuer: this.issuer
        });
        
        // Generate backup codes
        const backupCodes = this.generateBackupCodes();
        
        // Store as pending setup
        this.pendingSetups.set(userId, {
            secret: secret.base32,
            backupCodes,
            createdAt: Date.now()
        });
        
        // Generate QR code
        const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);
        
        return {
            secret: secret.base32,
            qrCode: qrCodeUrl,
            backupCodes,
            manualEntry: secret.base32
        };
    }
    
    /**
     * Verify and enable 2FA
     */
    async enableTwoFactor(userId, token) {
        const pending = this.pendingSetups.get(userId);
        if (!pending) {
            throw new Error('No pending 2FA setup found');
        }
        
        // Verify token
        const isValid = this.verifyToken(pending.secret, token);
        if (!isValid) {
            throw new Error('Invalid verification code');
        }
        
        // Move to active secrets
        this.userSecrets.set(userId, {
            secret: pending.secret,
            enabledAt: Date.now()
        });
        
        // Store backup codes
        this.backupCodes.set(userId, new Set(pending.backupCodes));
        
        // Clean up pending
        this.pendingSetups.delete(userId);
        
        return {
            success: true,
            backupCodes: pending.backupCodes
        };
    }
    
    /**
     * Disable 2FA for user
     */
    async disableTwoFactor(userId, currentToken) {
        const userSecret = this.userSecrets.get(userId);
        if (!userSecret) {
            throw new Error('2FA not enabled');
        }
        
        // Verify current token
        const isValid = this.verifyToken(userSecret.secret, currentToken);
        if (!isValid) {
            throw new Error('Invalid verification code');
        }
        
        // Remove 2FA
        this.userSecrets.delete(userId);
        this.backupCodes.delete(userId);
        
        return { success: true };
    }
    
    /**
     * Verify TOTP token
     */
    verifyToken(secret, token) {
        try {
            return speakeasy.totp.verify({
                secret: secret,
                encoding: 'base32',
                token: token,
                window: this.window
            });
        } catch (error) {
            console.error('Token verification error:', error);
            return false;
        }
    }
    
    /**
     * Verify 2FA for user
     */
    async verifyUserToken(userId, token) {
        const userSecret = this.userSecrets.get(userId);
        if (!userSecret) {
            return { valid: false, reason: '2FA not enabled' };
        }
        
        // Check if it's a backup code
        if (token.length === 16) { // Backup codes are 16 chars
            return this.verifyBackupCode(userId, token);
        }
        
        // Verify TOTP
        const isValid = this.verifyToken(userSecret.secret, token);
        
        if (isValid) {
            return {
                valid: true,
                method: 'totp'
            };
        }
        
        return {
            valid: false,
            reason: 'Invalid code'
        };
    }
    
    /**
     * Verify backup code
     */
    verifyBackupCode(userId, code) {
        const userBackupCodes = this.backupCodes.get(userId);
        if (!userBackupCodes) {
            return { valid: false, reason: 'No backup codes found' };
        }
        
        if (userBackupCodes.has(code)) {
            // Remove used backup code
            userBackupCodes.delete(code);
            
            return {
                valid: true,
                method: 'backup',
                remainingCodes: userBackupCodes.size
            };
        }
        
        return {
            valid: false,
            reason: 'Invalid backup code'
        };
    }
    
    /**
     * Generate backup codes
     */
    generateBackupCodes() {
        const codes = [];
        for (let i = 0; i < this.backupCodesCount; i++) {
            codes.push(this.generateBackupCode());
        }
        return codes;
    }
    
    /**
     * Generate single backup code
     */
    generateBackupCode() {
        const bytes = randomBytes(8);
        return bytes.toString('hex').toUpperCase();
    }
    
    /**
     * Regenerate backup codes
     */
    async regenerateBackupCodes(userId, currentToken) {
        const userSecret = this.userSecrets.get(userId);
        if (!userSecret) {
            throw new Error('2FA not enabled');
        }
        
        // Verify current token
        const isValid = this.verifyToken(userSecret.secret, currentToken);
        if (!isValid) {
            throw new Error('Invalid verification code');
        }
        
        // Generate new codes
        const newCodes = this.generateBackupCodes();
        this.backupCodes.set(userId, new Set(newCodes));
        
        return {
            success: true,
            backupCodes: newCodes
        };
    }
    
    /**
     * Check if user has 2FA enabled
     */
    isEnabled(userId) {
        return this.userSecrets.has(userId);
    }
    
    /**
     * Get remaining backup codes count
     */
    getRemainingBackupCodes(userId) {
        const codes = this.backupCodes.get(userId);
        return codes ? codes.size : 0;
    }
    
    /**
     * Clean up expired pending setups
     */
    cleanupPendingSetups() {
        const now = Date.now();
        const timeout = 600000; // 10 minutes
        
        for (const [userId, setup] of this.pendingSetups) {
            if (now - setup.createdAt > timeout) {
                this.pendingSetups.delete(userId);
            }
        }
    }
    
    /**
     * Export user's 2FA data (for backup)
     */
    exportUserData(userId) {
        const secret = this.userSecrets.get(userId);
        const codes = this.backupCodes.get(userId);
        
        if (!secret) {
            return null;
        }
        
        return {
            userId,
            twoFactorEnabled: true,
            enabledAt: secret.enabledAt,
            remainingBackupCodes: codes ? codes.size : 0
        };
    }
    
    /**
     * Get 2FA statistics
     */
    getStats() {
        return {
            enabledUsers: this.userSecrets.size,
            pendingSetups: this.pendingSetups.size,
            totalBackupCodesUsed: Array.from(this.backupCodes.values())
                .reduce((sum, codes) => sum + (this.backupCodesCount - codes.size), 0)
        };
    }
}

/**
 * Express middleware for 2FA verification
 */
export function createTwoFactorMiddleware(twoFactorAuth) {
    return async (req, res, next) => {
        // Skip if no user or 2FA not enabled
        if (!req.user || !twoFactorAuth.isEnabled(req.user.id)) {
            return next();
        }
        
        // Check if already verified in session
        if (req.session && req.session.twoFactorVerified) {
            return next();
        }
        
        // Extract 2FA token
        const token = req.headers['x-2fa-token'] || req.body.twoFactorToken;
        
        if (!token) {
            return res.status(403).json({
                error: '2FA verification required',
                require2FA: true
            });
        }
        
        // Verify token
        const result = await twoFactorAuth.verifyUserToken(req.user.id, token);
        
        if (!result.valid) {
            return res.status(403).json({
                error: result.reason,
                require2FA: true
            });
        }
        
        // Mark as verified in session
        if (req.session) {
            req.session.twoFactorVerified = true;
        }
        
        // Add verification info to request
        req.twoFactorVerification = result;
        
        next();
    };
}

/**
 * Rate limiter for 2FA attempts
 */
export class TwoFactorRateLimiter {
    constructor(options = {}) {
        this.maxAttempts = options.maxAttempts || 5;
        this.windowMs = options.windowMs || 900000; // 15 minutes
        this.blockDurationMs = options.blockDurationMs || 3600000; // 1 hour
        
        this.attempts = new Map();
        this.blocks = new Map();
    }
    
    /**
     * Check if user is blocked
     */
    isBlocked(userId) {
        const blockTime = this.blocks.get(userId);
        if (!blockTime) return false;
        
        if (Date.now() - blockTime < this.blockDurationMs) {
            return true;
        }
        
        // Remove expired block
        this.blocks.delete(userId);
        return false;
    }
    
    /**
     * Record failed attempt
     */
    recordFailedAttempt(userId) {
        if (this.isBlocked(userId)) {
            return { blocked: true, remainingTime: this.getRemainingBlockTime(userId) };
        }
        
        const userAttempts = this.attempts.get(userId) || [];
        const now = Date.now();
        
        // Filter out old attempts
        const recentAttempts = userAttempts.filter(time => now - time < this.windowMs);
        recentAttempts.push(now);
        
        this.attempts.set(userId, recentAttempts);
        
        // Check if should block
        if (recentAttempts.length >= this.maxAttempts) {
            this.blocks.set(userId, now);
            this.attempts.delete(userId);
            
            return {
                blocked: true,
                remainingTime: this.blockDurationMs
            };
        }
        
        return {
            blocked: false,
            remainingAttempts: this.maxAttempts - recentAttempts.length
        };
    }
    
    /**
     * Clear attempts on success
     */
    clearAttempts(userId) {
        this.attempts.delete(userId);
    }
    
    /**
     * Get remaining block time
     */
    getRemainingBlockTime(userId) {
        const blockTime = this.blocks.get(userId);
        if (!blockTime) return 0;
        
        const elapsed = Date.now() - blockTime;
        return Math.max(0, this.blockDurationMs - elapsed);
    }
    
    /**
     * Clean up old data
     */
    cleanup() {
        const now = Date.now();
        
        // Clean attempts
        for (const [userId, attempts] of this.attempts) {
            const recent = attempts.filter(time => now - time < this.windowMs);
            if (recent.length === 0) {
                this.attempts.delete(userId);
            } else {
                this.attempts.set(userId, recent);
            }
        }
        
        // Clean blocks
        for (const [userId, blockTime] of this.blocks) {
            if (now - blockTime >= this.blockDurationMs) {
                this.blocks.delete(userId);
            }
        }
    }
}

export default TwoFactorAuth;