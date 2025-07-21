/**
 * Password Reset Manager
 * Handles password reset tokens and email notifications
 */

import { randomBytes } from 'crypto';
import bcrypt from 'bcrypt';
import { DatabaseManager } from '../core/database-manager.js';
import { CacheManager } from '../core/cache-manager.js';

export class PasswordResetManager {
    constructor(options = {}) {
        this.db = options.db || new DatabaseManager();
        this.cache = options.cache || new CacheManager();
        this.emailService = options.emailService;
        
        // Configuration
        this.tokenExpiry = parseInt(process.env.PASSWORD_RESET_TOKEN_EXPIRY) || 3600000; // 1 hour
        this.maxAttempts = parseInt(process.env.PASSWORD_RESET_MAX_ATTEMPTS) || 3;
        this.cooldownPeriod = parseInt(process.env.PASSWORD_RESET_COOLDOWN) || 3600000; // 1 hour
    }
    
    /**
     * Request password reset
     */
    async requestReset(email) {
        // Check rate limiting
        const rateLimitKey = `password_reset:${email}`;
        const attempts = await this.cache.get(rateLimitKey) || 0;
        
        if (attempts >= this.maxAttempts) {
            throw new Error('Too many password reset attempts. Please try again later.');
        }
        
        // Find user by email
        const users = await this.db.query(
            'SELECT id, username, email, status FROM users WHERE email = ?',
            [email]
        );
        
        if (users.length === 0) {
            // Return success even if user not found (security best practice)
            return { success: true, message: 'If the email exists, a reset link has been sent.' };
        }
        
        const user = users[0];
        
        if (user.status !== 'active') {
            return { success: true, message: 'If the email exists, a reset link has been sent.' };
        }
        
        // Generate reset token
        const token = randomBytes(32).toString('hex');
        const hashedToken = await bcrypt.hash(token, 10);
        
        // Store reset token
        await this.db.query(
            `INSERT INTO password_reset_tokens 
            (user_id, token_hash, expires_at, created_at)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE 
            token_hash = VALUES(token_hash),
            expires_at = VALUES(expires_at),
            created_at = VALUES(created_at)`,
            [
                user.id,
                hashedToken,
                new Date(Date.now() + this.tokenExpiry),
                new Date()
            ]
        );
        
        // Update rate limiting
        await this.cache.set(rateLimitKey, attempts + 1, this.cooldownPeriod);
        
        // Send email (if email service is configured)
        if (this.emailService) {
            const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
            
            await this.emailService.sendEmail({
                to: user.email,
                subject: 'Password Reset Request - Otedama',
                template: 'password-reset',
                data: {
                    username: user.username,
                    resetUrl,
                    expiryMinutes: Math.floor(this.tokenExpiry / 60000)
                }
            });
        }
        
        // Log the reset request
        await this.db.query(
            `INSERT INTO security_audit_log 
            (user_id, action, ip_address, details, created_at)
            VALUES (?, ?, ?, ?, ?)`,
            [
                user.id,
                'password_reset_requested',
                null, // IP would come from request context
                JSON.stringify({ email }),
                new Date()
            ]
        );
        
        return {
            success: true,
            message: 'If the email exists, a reset link has been sent.',
            // Only return token in dev mode for testing
            ...(process.env.NODE_ENV === 'development' && { token })
        };
    }
    
    /**
     * Verify reset token
     */
    async verifyToken(token) {
        // Find valid token
        const tokens = await this.db.query(
            `SELECT t.id, t.user_id, t.token_hash, t.used, 
                    u.username, u.email
             FROM password_reset_tokens t
             JOIN users u ON t.user_id = u.id
             WHERE t.expires_at > NOW() AND t.used = 0`,
            []
        );
        
        // Check each token
        for (const tokenRecord of tokens) {
            if (await bcrypt.compare(token, tokenRecord.token_hash)) {
                return {
                    valid: true,
                    tokenId: tokenRecord.id,
                    userId: tokenRecord.user_id,
                    username: tokenRecord.username,
                    email: tokenRecord.email
                };
            }
        }
        
        return { valid: false };
    }
    
    /**
     * Reset password with token
     */
    async resetPassword(token, newPassword) {
        // Verify token
        const verification = await this.verifyToken(token);
        
        if (!verification.valid) {
            throw new Error('Invalid or expired reset token');
        }
        
        // Validate new password
        this.validatePassword(newPassword);
        
        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        
        // Start transaction
        const connection = await this.db.getConnection();
        await connection.beginTransaction();
        
        try {
            // Update password
            await connection.query(
                'UPDATE users SET password = ?, updated_at = ? WHERE id = ?',
                [hashedPassword, new Date(), verification.userId]
            );
            
            // Mark token as used
            await connection.query(
                'UPDATE password_reset_tokens SET used = 1 WHERE id = ?',
                [verification.tokenId]
            );
            
            // Invalidate all user sessions for security
            await connection.query(
                'DELETE FROM user_sessions WHERE user_id = ?',
                [verification.userId]
            );
            
            // Log the password reset
            await connection.query(
                `INSERT INTO security_audit_log 
                (user_id, action, details, created_at)
                VALUES (?, ?, ?, ?)`,
                [
                    verification.userId,
                    'password_reset_completed',
                    JSON.stringify({ email: verification.email }),
                    new Date()
                ]
            );
            
            await connection.commit();
            
            // Clear rate limiting
            const rateLimitKey = `password_reset:${verification.email}`;
            await this.cache.delete(rateLimitKey);
            
            // Send confirmation email
            if (this.emailService) {
                await this.emailService.sendEmail({
                    to: verification.email,
                    subject: 'Password Reset Successful - Otedama',
                    template: 'password-reset-success',
                    data: {
                        username: verification.username
                    }
                });
            }
            
            return {
                success: true,
                message: 'Password reset successful. Please login with your new password.'
            };
            
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }
    
    /**
     * Clean up expired tokens
     */
    async cleanupExpiredTokens() {
        const result = await this.db.query(
            'DELETE FROM password_reset_tokens WHERE expires_at < NOW() OR used = 1'
        );
        
        return { deleted: result.affectedRows };
    }
    
    /**
     * Validate password strength
     */
    validatePassword(password) {
        const minLength = parseInt(process.env.MIN_PASSWORD_LENGTH) || 8;
        
        if (password.length < minLength) {
            throw new Error(`Password must be at least ${minLength} characters`);
        }
        
        const requirements = [];
        
        if (process.env.REQUIRE_UPPERCASE === 'true' && !/[A-Z]/.test(password)) {
            requirements.push('uppercase letter');
        }
        
        if (process.env.REQUIRE_LOWERCASE === 'true' && !/[a-z]/.test(password)) {
            requirements.push('lowercase letter');
        }
        
        if (process.env.REQUIRE_NUMBERS === 'true' && !/\d/.test(password)) {
            requirements.push('number');
        }
        
        if (process.env.REQUIRE_SPECIAL_CHARS === 'true' && !/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
            requirements.push('special character');
        }
        
        if (requirements.length > 0) {
            throw new Error(`Password must contain at least one ${requirements.join(', ')}`);
        }
    }
}

export default PasswordResetManager;