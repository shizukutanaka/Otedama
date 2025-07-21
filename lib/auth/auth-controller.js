/**
 * Authentication Controller
 * 
 * Handles user registration, login, and authentication
 * Following security best practices
 */

import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { DatabaseManager } from '../core/database-manager.js';
import { CacheManager } from '../core/cache-manager.js';
import { RateLimiter } from '../security/rate-limiter.js';
import { createHash, randomBytes } from 'crypto';

export class AuthController {
    constructor(options = {}) {
        this.db = options.db || new DatabaseManager();
        this.cache = options.cache || new CacheManager();
        this.rateLimiter = options.rateLimiter || new RateLimiter();
        
        // JWT settings
        this.jwtSecret = process.env.JWT_SECRET;
        this.jwtExpiry = process.env.JWT_EXPIRY || '24h';
        this.refreshTokenExpiry = process.env.REFRESH_TOKEN_EXPIRY || '30d';
        
        // Session settings
        this.sessionTimeout = parseInt(process.env.SESSION_TIMEOUT) || 3600000;
        this.maxSessionsPerUser = parseInt(process.env.MAX_SESSIONS_PER_USER) || 5;
        
        if (!this.jwtSecret) {
            throw new Error('JWT_SECRET is required');
        }
    }
    
    /**
     * Register new user
     */
    async register(userData) {
        const { username, email, password, referralCode } = userData;
        
        // Validate input
        if (!username || !email || !password) {
            throw new Error('Username, email, and password are required');
        }
        
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            throw new Error('Invalid email format');
        }
        
        // Validate username
        if (username.length < 3 || username.length > 30) {
            throw new Error('Username must be between 3 and 30 characters');
        }
        
        if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
            throw new Error('Username can only contain letters, numbers, hyphens, and underscores');
        }
        
        // Check if user exists
        const existingUser = await this.db.query(
            'SELECT id FROM users WHERE username = ? OR email = ?',
            [username, email]
        );
        
        if (existingUser.length > 0) {
            throw new Error('Username or email already exists');
        }
        
        // Validate password
        this.validatePassword(password);
        
        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Handle referral
        let referrerId = null;
        if (referralCode) {
            const referrer = await this.db.query(
                'SELECT id FROM users WHERE referral_code = ?',
                [referralCode]
            );
            
            if (referrer.length > 0) {
                referrerId = referrer[0].id;
            }
        }
        
        // Generate user's referral code
        const userReferralCode = this.generateReferralCode();
        
        // Start transaction
        const connection = await this.db.getConnection();
        await connection.beginTransaction();
        
        try {
            // Create user
            const result = await connection.query(
                `INSERT INTO users 
                (username, email, password, role, referral_code, referred_by, created_at)
                VALUES (?, ?, ?, 'user', ?, ?, ?)`,
                [username, email, hashedPassword, userReferralCode, referrerId, new Date()]
            );
            
            const userId = result.insertId;
            
            // Initialize user balances
            const currencies = ['BTC', 'ETH', 'USDT'];
            for (const currency of currencies) {
                await connection.query(
                    `INSERT INTO user_balances 
                    (user_id, currency, available_balance, locked_balance)
                    VALUES (?, ?, 0, 0)`,
                    [userId, currency]
                );
            }
            
            // Create referral record if referred
            if (referrerId) {
                await connection.query(
                    `INSERT INTO referrals 
                    (referrer_id, referred_id, created_at)
                    VALUES (?, ?, ?)`,
                    [referrerId, userId, new Date()]
                );
            }
            
            await connection.commit();
            
            return {
                id: userId,
                username,
                email,
                referralCode: userReferralCode
            };
            
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }
    
    /**
     * Login user
     */
    async login(credentials, ipAddress, userAgent) {
        const { username, password } = credentials;
        
        // Rate limiting check
        const rateLimitKey = `login:${username}:${ipAddress}`;
        if (!await this.rateLimiter.checkLimit(rateLimitKey, 5, 900000)) { // 5 attempts per 15 min
            throw new Error('Too many login attempts. Please try again later.');
        }
        
        // Find user by username or email
        const users = await this.db.query(
            `SELECT id, username, email, password, role, 
                    two_factor_enabled, status
             FROM users 
             WHERE username = ? OR email = ?`,
            [username, username]
        );
        
        if (users.length === 0) {
            await this.rateLimiter.recordAttempt(rateLimitKey);
            throw new Error('Invalid credentials');
        }
        
        const user = users[0];
        
        // Check account status
        if (user.status === 'suspended') {
            throw new Error('Account suspended');
        }
        
        if (user.status === 'locked') {
            throw new Error('Account locked. Please contact support.');
        }
        
        // Verify password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            await this.rateLimiter.recordAttempt(rateLimitKey);
            throw new Error('Invalid credentials');
        }
        
        // Clear rate limit on successful login
        await this.rateLimiter.clearAttempts(rateLimitKey);
        
        // Check session limit
        await this.enforceSessionLimit(user.id);
        
        // Generate tokens
        const accessToken = this.generateAccessToken(user);
        const refreshToken = this.generateRefreshToken();
        
        // Create session
        const sessionId = randomBytes(32).toString('hex');
        await this.db.query(
            `INSERT INTO user_sessions 
            (id, user_id, refresh_token, ip_address, user_agent, 
             created_at, last_activity, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                sessionId,
                user.id,
                await bcrypt.hash(refreshToken, 10),
                ipAddress,
                userAgent,
                new Date(),
                new Date(),
                new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
            ]
        );
        
        // Update last login
        await this.db.query(
            'UPDATE users SET last_login = ? WHERE id = ?',
            [new Date(), user.id]
        );
        
        return {
            accessToken,
            refreshToken,
            sessionId,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                twoFactorEnabled: user.two_factor_enabled
            },
            requiresTwoFactor: user.two_factor_enabled
        };
    }
    
    /**
     * Refresh access token
     */
    async refreshAccessToken(refreshToken, sessionId) {
        // Get session
        const sessions = await this.db.query(
            `SELECT id, user_id, refresh_token, expires_at 
             FROM user_sessions 
             WHERE id = ? AND expires_at > NOW()`,
            [sessionId]
        );
        
        if (sessions.length === 0) {
            throw new Error('Invalid session');
        }
        
        const session = sessions[0];
        
        // Verify refresh token
        const validToken = await bcrypt.compare(refreshToken, session.refresh_token);
        if (!validToken) {
            // Invalid token - delete session for security
            await this.db.query('DELETE FROM user_sessions WHERE id = ?', [sessionId]);
            throw new Error('Invalid refresh token');
        }
        
        // Get user
        const users = await this.db.query(
            'SELECT id, username, email, role, status FROM users WHERE id = ?',
            [session.user_id]
        );
        
        if (users.length === 0 || users[0].status !== 'active') {
            throw new Error('User not found or inactive');
        }
        
        const user = users[0];
        
        // Generate new access token
        const accessToken = this.generateAccessToken(user);
        
        // Update session activity
        await this.db.query(
            'UPDATE user_sessions SET last_activity = ? WHERE id = ?',
            [new Date(), sessionId]
        );
        
        return { accessToken };
    }
    
    /**
     * Logout user
     */
    async logout(sessionId) {
        await this.db.query(
            'DELETE FROM user_sessions WHERE id = ?',
            [sessionId]
        );
        
        return { success: true };
    }
    
    /**
     * Logout all sessions
     */
    async logoutAll(userId) {
        await this.db.query(
            'DELETE FROM user_sessions WHERE user_id = ?',
            [userId]
        );
        
        return { success: true };
    }
    
    /**
     * Generate access token
     */
    generateAccessToken(user) {
        return jwt.sign(
            {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role
            },
            this.jwtSecret,
            { expiresIn: this.jwtExpiry }
        );
    }
    
    /**
     * Generate refresh token
     */
    generateRefreshToken() {
        return randomBytes(64).toString('hex');
    }
    
    /**
     * Generate referral code
     */
    generateReferralCode() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let code = '';
        for (let i = 0; i < 8; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return code;
    }
    
    /**
     * Validate password
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
    
    /**
     * Enforce session limit per user
     */
    async enforceSessionLimit(userId) {
        const sessions = await this.db.query(
            `SELECT id FROM user_sessions 
             WHERE user_id = ? 
             ORDER BY created_at DESC`,
            [userId]
        );
        
        if (sessions.length >= this.maxSessionsPerUser) {
            // Delete oldest sessions
            const toDelete = sessions.slice(this.maxSessionsPerUser - 1);
            for (const session of toDelete) {
                await this.db.query(
                    'DELETE FROM user_sessions WHERE id = ?',
                    [session.id]
                );
            }
        }
    }
    
    /**
     * Verify API key
     */
    async verifyApiKey(apiKey) {
        // Extract key ID from prefix
        const keyPrefix = apiKey.substring(0, 7) + '...';
        
        // Find key
        const keys = await this.db.query(
            `SELECT id, user_id, key_hash, permissions, last_used_at
             FROM api_keys 
             WHERE key_prefix = ? AND revoked = 0`,
            [keyPrefix]
        );
        
        if (keys.length === 0) {
            throw new Error('Invalid API key');
        }
        
        // Verify full key
        let validKey = null;
        for (const key of keys) {
            if (await bcrypt.compare(apiKey, key.key_hash)) {
                validKey = key;
                break;
            }
        }
        
        if (!validKey) {
            throw new Error('Invalid API key');
        }
        
        // Update last used
        await this.db.query(
            'UPDATE api_keys SET last_used_at = ? WHERE id = ?',
            [new Date(), validKey.id]
        );
        
        // Get user
        const users = await this.db.query(
            'SELECT id, username, email, role, status FROM users WHERE id = ?',
            [validKey.user_id]
        );
        
        if (users.length === 0 || users[0].status !== 'active') {
            throw new Error('User not found or inactive');
        }
        
        return {
            user: users[0],
            permissions: JSON.parse(validKey.permissions)
        };
    }
}

/**
 * Create authentication routes
 */
export function createAuthRoutes(options = {}) {
    const router = express.Router();
    const authController = new AuthController(options);
    
    // Register
    router.post('/register', async (req, res) => {
        try {
            const user = await authController.register(req.body);
            res.status(201).json({
                success: true,
                user
            });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });
    
    // Login
    router.post('/login', async (req, res) => {
        try {
            const ipAddress = req.ip || req.connection.remoteAddress;
            const userAgent = req.headers['user-agent'] || 'Unknown';
            
            const result = await authController.login(req.body, ipAddress, userAgent);
            
            // Set secure cookies
            res.cookie('refreshToken', result.refreshToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'strict',
                maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
            });
            
            res.cookie('sessionId', result.sessionId, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'strict',
                maxAge: 30 * 24 * 60 * 60 * 1000
            });
            
            res.json({
                accessToken: result.accessToken,
                user: result.user,
                requiresTwoFactor: result.requiresTwoFactor
            });
        } catch (error) {
            res.status(401).json({ error: error.message });
        }
    });
    
    // Refresh token
    router.post('/refresh', async (req, res) => {
        try {
            const refreshToken = req.cookies.refreshToken || req.body.refreshToken;
            const sessionId = req.cookies.sessionId || req.body.sessionId;
            
            if (!refreshToken || !sessionId) {
                return res.status(401).json({ error: 'Refresh token and session ID required' });
            }
            
            const result = await authController.refreshAccessToken(refreshToken, sessionId);
            res.json(result);
        } catch (error) {
            res.status(401).json({ error: error.message });
        }
    });
    
    // Logout
    router.post('/logout', async (req, res) => {
        try {
            const sessionId = req.cookies.sessionId || req.body.sessionId;
            
            if (sessionId) {
                await authController.logout(sessionId);
            }
            
            res.clearCookie('refreshToken');
            res.clearCookie('sessionId');
            
            res.json({ success: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });
    
    // Logout all sessions
    router.post('/logout-all', async (req, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            
            await authController.logoutAll(req.user.id);
            
            res.clearCookie('refreshToken');
            res.clearCookie('sessionId');
            
            res.json({ success: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });
    
    return router;
}

/**
 * Authentication middleware
 */
export function createAuthMiddleware(options = {}) {
    const authController = new AuthController(options);
    
    return async (req, res, next) => {
        try {
            // Check for API key first
            const apiKey = req.headers['x-api-key'];
            if (apiKey) {
                const result = await authController.verifyApiKey(apiKey);
                req.user = result.user;
                req.apiKeyPermissions = result.permissions;
                return next();
            }
            
            // Check for JWT token
            const token = req.headers.authorization?.replace('Bearer ', '');
            if (!token) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            req.user = decoded;
            
            // Check if user still exists and is active
            const users = await authController.db.query(
                'SELECT status FROM users WHERE id = ?',
                [decoded.id]
            );
            
            if (users.length === 0 || users[0].status !== 'active') {
                return res.status(401).json({ error: 'User not found or inactive' });
            }
            
            next();
        } catch (error) {
            if (error.name === 'TokenExpiredError') {
                return res.status(401).json({ error: 'Token expired' });
            }
            res.status(401).json({ error: 'Invalid token' });
        }
    };
}

export default AuthController;