/**
 * User Controller
 * 
 * Handles user profile, balance, and account management
 * Following clean code principles
 */

import express from 'express';
import bcrypt from 'bcrypt';
import { DatabaseManager } from '../core/database-manager.js';
import { CacheManager } from '../core/cache-manager.js';
import { createTwoFactorMiddleware } from './two-factor-auth.js';
import jwt from 'jsonwebtoken';

export class UserController {
    constructor(options = {}) {
        this.db = options.db || new DatabaseManager();
        this.cache = options.cache || new CacheManager();
        this.jwtSecret = options.jwtSecret || process.env.JWT_SECRET;
        
        // Password policy
        this.passwordPolicy = {
            minLength: parseInt(process.env.MIN_PASSWORD_LENGTH) || 8,
            requireUppercase: process.env.REQUIRE_UPPERCASE === 'true',
            requireLowercase: process.env.REQUIRE_LOWERCASE === 'true',
            requireNumbers: process.env.REQUIRE_NUMBERS === 'true',
            requireSpecialChars: process.env.REQUIRE_SPECIAL_CHARS === 'true'
        };
        
        // Session settings
        this.sessionTimeout = parseInt(process.env.SESSION_TIMEOUT) || 3600000;
        this.maxSessionsPerUser = parseInt(process.env.MAX_SESSIONS_PER_USER) || 5;
    }
    
    /**
     * Get user profile
     */
    async getProfile(userId) {
        // Check cache first
        const cacheKey = `user:profile:${userId}`;
        const cached = await this.cache.get(cacheKey);
        if (cached) return cached;
        
        // Get from database
        const user = await this.db.query(
            `SELECT 
                id, username, email, role, 
                created_at, updated_at, last_login,
                two_factor_enabled, api_key_count,
                total_volume_btc, total_fees_btc,
                mining_hashrate, active_workers
            FROM users 
            WHERE id = ?`,
            [userId]
        );
        
        if (!user || user.length === 0) {
            throw new Error('User not found');
        }
        
        const profile = user[0];
        
        // Remove sensitive fields
        delete profile.password;
        delete profile.password_history;
        
        // Cache for 5 minutes
        await this.cache.set(cacheKey, profile, 300);
        
        return profile;
    }
    
    /**
     * Update user profile
     */
    async updateProfile(userId, updates) {
        const allowedFields = ['username', 'email'];
        const updateFields = [];
        const values = [];
        
        // Validate and build update query
        for (const [field, value] of Object.entries(updates)) {
            if (allowedFields.includes(field)) {
                updateFields.push(`${field} = ?`);
                values.push(value);
            }
        }
        
        if (updateFields.length === 0) {
            throw new Error('No valid fields to update');
        }
        
        // Check username uniqueness
        if (updates.username) {
            const existing = await this.db.query(
                'SELECT id FROM users WHERE username = ? AND id != ?',
                [updates.username, userId]
            );
            if (existing.length > 0) {
                throw new Error('Username already taken');
            }
        }
        
        // Check email uniqueness
        if (updates.email) {
            const existing = await this.db.query(
                'SELECT id FROM users WHERE email = ? AND id != ?',
                [updates.email, userId]
            );
            if (existing.length > 0) {
                throw new Error('Email already in use');
            }
        }
        
        // Update user
        values.push(new Date(), userId);
        await this.db.query(
            `UPDATE users 
            SET ${updateFields.join(', ')}, updated_at = ? 
            WHERE id = ?`,
            values
        );
        
        // Invalidate cache
        await this.cache.delete(`user:profile:${userId}`);
        
        return await this.getProfile(userId);
    }
    
    /**
     * Get user balances
     */
    async getBalances(userId) {
        // Check cache
        const cacheKey = `user:balances:${userId}`;
        const cached = await this.cache.get(cacheKey);
        if (cached) return cached;
        
        // Get all balances
        const balances = await this.db.query(
            `SELECT 
                currency, 
                available_balance, 
                locked_balance,
                total_deposits,
                total_withdrawals,
                updated_at
            FROM user_balances 
            WHERE user_id = ?
            ORDER BY currency`,
            [userId]
        );
        
        // Calculate totals
        const result = {
            balances: {},
            totals: {
                btc_value: 0,
                usd_value: 0
            }
        };
        
        for (const balance of balances) {
            result.balances[balance.currency] = {
                available: parseFloat(balance.available_balance),
                locked: parseFloat(balance.locked_balance),
                total: parseFloat(balance.available_balance) + parseFloat(balance.locked_balance),
                deposits: parseFloat(balance.total_deposits),
                withdrawals: parseFloat(balance.total_withdrawals),
                updated_at: balance.updated_at
            };
            
            // Add BTC value calculation (simplified)
            if (balance.currency === 'BTC') {
                result.totals.btc_value += result.balances[balance.currency].total;
            }
        }
        
        // Cache for 1 minute
        await this.cache.set(cacheKey, result, 60);
        
        return result;
    }
    
    /**
     * Get transaction history
     */
    async getTransactionHistory(userId, options = {}) {
        const {
            type = null,
            currency = null,
            limit = 50,
            offset = 0,
            startDate = null,
            endDate = null
        } = options;
        
        let query = `
            SELECT 
                id, type, currency, amount, fee,
                status, tx_hash, confirmations,
                from_address, to_address,
                metadata, created_at, updated_at
            FROM transactions 
            WHERE user_id = ?
        `;
        
        const params = [userId];
        
        // Add filters
        if (type) {
            query += ' AND type = ?';
            params.push(type);
        }
        
        if (currency) {
            query += ' AND currency = ?';
            params.push(currency);
        }
        
        if (startDate) {
            query += ' AND created_at >= ?';
            params.push(startDate);
        }
        
        if (endDate) {
            query += ' AND created_at <= ?';
            params.push(endDate);
        }
        
        // Add ordering and pagination
        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);
        
        const transactions = await this.db.query(query, params);
        
        // Get total count
        const countQuery = query.replace(
            /SELECT.*FROM/,
            'SELECT COUNT(*) as total FROM'
        ).replace(/ORDER BY.*$/, '');
        
        const countResult = await this.db.query(
            countQuery,
            params.slice(0, -2) // Remove limit and offset
        );
        
        return {
            transactions,
            total: countResult[0].total,
            limit,
            offset
        };
    }
    
    /**
     * Change password
     */
    async changePassword(userId, currentPassword, newPassword) {
        // Get user
        const user = await this.db.query(
            'SELECT password, password_history FROM users WHERE id = ?',
            [userId]
        );
        
        if (!user || user.length === 0) {
            throw new Error('User not found');
        }
        
        // Verify current password
        const validPassword = await bcrypt.compare(currentPassword, user[0].password);
        if (!validPassword) {
            throw new Error('Current password is incorrect');
        }
        
        // Validate new password
        this.validatePassword(newPassword);
        
        // Check password history
        const history = JSON.parse(user[0].password_history || '[]');
        for (const oldHash of history) {
            if (await bcrypt.compare(newPassword, oldHash)) {
                throw new Error('Password was recently used');
            }
        }
        
        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        
        // Update password and history
        history.unshift(user[0].password);
        const historyLimit = parseInt(process.env.PASSWORD_HISTORY_COUNT) || 5;
        const newHistory = history.slice(0, historyLimit);
        
        await this.db.query(
            `UPDATE users 
            SET password = ?, password_history = ?, updated_at = ?
            WHERE id = ?`,
            [hashedPassword, JSON.stringify(newHistory), new Date(), userId]
        );
        
        // Invalidate all sessions
        await this.invalidateUserSessions(userId);
        
        return { success: true };
    }
    
    /**
     * Validate password according to policy
     */
    validatePassword(password) {
        const errors = [];
        
        if (password.length < this.passwordPolicy.minLength) {
            errors.push(`Password must be at least ${this.passwordPolicy.minLength} characters`);
        }
        
        if (this.passwordPolicy.requireUppercase && !/[A-Z]/.test(password)) {
            errors.push('Password must contain uppercase letters');
        }
        
        if (this.passwordPolicy.requireLowercase && !/[a-z]/.test(password)) {
            errors.push('Password must contain lowercase letters');
        }
        
        if (this.passwordPolicy.requireNumbers && !/\d/.test(password)) {
            errors.push('Password must contain numbers');
        }
        
        if (this.passwordPolicy.requireSpecialChars && !/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
            errors.push('Password must contain special characters');
        }
        
        if (errors.length > 0) {
            throw new Error(errors.join(', '));
        }
    }
    
    /**
     * Get API keys
     */
    async getApiKeys(userId) {
        const keys = await this.db.query(
            `SELECT 
                id, name, key_prefix, permissions,
                last_used_at, created_at, expires_at
            FROM api_keys 
            WHERE user_id = ? AND revoked = 0
            ORDER BY created_at DESC`,
            [userId]
        );
        
        return keys;
    }
    
    /**
     * Create API key
     */
    async createApiKey(userId, name, permissions = ['read']) {
        const keyPrefix = process.env.API_KEY_PREFIX || 'sk_';
        const keyLength = parseInt(process.env.API_KEY_LENGTH) || 32;
        
        // Generate key
        const randomBytes = await import('crypto').then(m => 
            m.randomBytes(keyLength).toString('hex')
        );
        const apiKey = `${keyPrefix}${randomBytes}`;
        
        // Hash key for storage
        const keyHash = await bcrypt.hash(apiKey, 10);
        
        // Store key
        const result = await this.db.query(
            `INSERT INTO api_keys 
            (user_id, name, key_hash, key_prefix, permissions, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
            [
                userId, 
                name, 
                keyHash, 
                apiKey.substring(0, 7) + '...', 
                JSON.stringify(permissions),
                new Date()
            ]
        );
        
        return {
            id: result.insertId,
            name,
            key: apiKey, // Only returned once
            key_prefix: apiKey.substring(0, 7) + '...',
            permissions,
            created_at: new Date()
        };
    }
    
    /**
     * Revoke API key
     */
    async revokeApiKey(userId, keyId) {
        const result = await this.db.query(
            'UPDATE api_keys SET revoked = 1 WHERE id = ? AND user_id = ?',
            [keyId, userId]
        );
        
        if (result.affectedRows === 0) {
            throw new Error('API key not found');
        }
        
        return { success: true };
    }
    
    /**
     * Get user sessions
     */
    async getUserSessions(userId) {
        const sessions = await this.db.query(
            `SELECT 
                id, ip_address, user_agent, 
                created_at, last_activity, expires_at
            FROM user_sessions 
            WHERE user_id = ? AND expires_at > NOW()
            ORDER BY last_activity DESC`,
            [userId]
        );
        
        return sessions;
    }
    
    /**
     * Invalidate user sessions
     */
    async invalidateUserSessions(userId, sessionId = null) {
        if (sessionId) {
            await this.db.query(
                'DELETE FROM user_sessions WHERE user_id = ? AND id = ?',
                [userId, sessionId]
            );
        } else {
            await this.db.query(
                'DELETE FROM user_sessions WHERE user_id = ?',
                [userId]
            );
        }
        
        // Clear cache
        await this.cache.delete(`user:sessions:${userId}`);
    }
    
    /**
     * Get user statistics
     */
    async getUserStats(userId) {
        const stats = await this.db.query(
            `SELECT 
                -- Mining stats
                (SELECT COUNT(*) FROM workers WHERE user_id = ? AND active = 1) as active_workers,
                (SELECT SUM(hashrate) FROM workers WHERE user_id = ?) as total_hashrate,
                (SELECT COUNT(*) FROM shares WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)) as shares_24h,
                
                -- Trading stats
                (SELECT COUNT(*) FROM orders WHERE user_id = ?) as total_orders,
                (SELECT COUNT(*) FROM trades WHERE user_id = ?) as total_trades,
                (SELECT SUM(amount * price) FROM trades WHERE user_id = ?) as total_volume,
                
                -- Account stats
                (SELECT COUNT(*) FROM referrals WHERE referrer_id = ?) as referral_count,
                (SELECT SUM(commission) FROM referral_commissions WHERE user_id = ?) as referral_earnings
            `,
            [userId, userId, userId, userId, userId, userId, userId, userId]
        );
        
        return stats[0];
    }
}

/**
 * Create user routes
 */
export function createUserRoutes(options = {}) {
    const router = express.Router();
    const userController = new UserController(options);
    const twoFactorMiddleware = options.twoFactorMiddleware || ((req, res, next) => next());
    
    // Authentication middleware
    const requireAuth = async (req, res, next) => {
        try {
            const token = req.headers.authorization?.replace('Bearer ', '');
            if (!token) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            req.user = decoded;
            next();
        } catch (error) {
            res.status(401).json({ error: 'Invalid token' });
        }
    };
    
    // Get profile
    router.get('/profile', requireAuth, twoFactorMiddleware, async (req, res) => {
        try {
            const profile = await userController.getProfile(req.user.id);
            res.json(profile);
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });
    
    // Update profile
    router.put('/profile', requireAuth, twoFactorMiddleware, async (req, res) => {
        try {
            const updates = req.body;
            const profile = await userController.updateProfile(req.user.id, updates);
            res.json(profile);
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });
    
    // Get balances
    router.get('/balances', requireAuth, async (req, res) => {
        try {
            const balances = await userController.getBalances(req.user.id);
            res.json(balances);
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });
    
    // Get transaction history
    router.get('/transactions', requireAuth, async (req, res) => {
        try {
            const options = {
                type: req.query.type,
                currency: req.query.currency,
                limit: parseInt(req.query.limit) || 50,
                offset: parseInt(req.query.offset) || 0,
                startDate: req.query.start_date,
                endDate: req.query.end_date
            };
            
            const history = await userController.getTransactionHistory(req.user.id, options);
            res.json(history);
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });
    
    // Change password
    router.post('/change-password', requireAuth, twoFactorMiddleware, async (req, res) => {
        try {
            const { currentPassword, newPassword } = req.body;
            
            if (!currentPassword || !newPassword) {
                return res.status(400).json({ error: 'Both passwords required' });
            }
            
            await userController.changePassword(req.user.id, currentPassword, newPassword);
            res.json({ success: true, message: 'Password changed successfully' });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });
    
    // API Keys
    router.get('/api-keys', requireAuth, twoFactorMiddleware, async (req, res) => {
        try {
            const keys = await userController.getApiKeys(req.user.id);
            res.json(keys);
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });
    
    router.post('/api-keys', requireAuth, twoFactorMiddleware, async (req, res) => {
        try {
            const { name, permissions } = req.body;
            
            if (!name) {
                return res.status(400).json({ error: 'Key name required' });
            }
            
            const key = await userController.createApiKey(req.user.id, name, permissions);
            res.json(key);
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });
    
    router.delete('/api-keys/:id', requireAuth, twoFactorMiddleware, async (req, res) => {
        try {
            await userController.revokeApiKey(req.user.id, req.params.id);
            res.json({ success: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });
    
    // Sessions
    router.get('/sessions', requireAuth, async (req, res) => {
        try {
            const sessions = await userController.getUserSessions(req.user.id);
            res.json(sessions);
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });
    
    router.delete('/sessions/:id', requireAuth, async (req, res) => {
        try {
            await userController.invalidateUserSessions(req.user.id, req.params.id);
            res.json({ success: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });
    
    // Statistics
    router.get('/stats', requireAuth, async (req, res) => {
        try {
            const stats = await userController.getUserStats(req.user.id);
            res.json(stats);
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });
    
    return router;
}

export default UserController;