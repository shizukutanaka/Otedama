/**
 * Otedama Remote Management API
 * Secure remote administration for mining pool operators
 * 
 * Design:
 * - Carmack: Direct, efficient API design
 * - Martin: Clean separation of admin functions
 * - Pike: Simple but secure implementation
 */

import { createLogger } from '../core/logger.js';
import express from 'express';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { rateLimiter } from '../core/rate-limiter.js';

const logger = createLogger('RemoteManagementAPI');

/**
 * Admin permissions
 */
export const AdminPermission = {
  VIEW_STATS: 'view_stats',
  MANAGE_MINERS: 'manage_miners',
  CONFIGURE_POOL: 'configure_pool',
  MANAGE_PAYMENTS: 'manage_payments',
  SYSTEM_CONTROL: 'system_control',
  FULL_ACCESS: 'full_access'
};

/**
 * Remote Management API
 */
export class RemoteManagementAPI {
  constructor(config = {}) {
    this.config = {
      jwtSecret: config.jwtSecret || crypto.randomBytes(32).toString('hex'),
      tokenExpiry: config.tokenExpiry || '24h',
      apiPrefix: config.apiPrefix || '/api/admin',
      enableAuditLog: config.enableAuditLog !== false,
      maxLoginAttempts: config.maxLoginAttempts || 5,
      lockoutDuration: config.lockoutDuration || 900000 // 15 minutes
    };
    
    // Express router
    this.router = Router();
    
    // Admin users (in production, store in database)
    this.adminUsers = new Map();
    
    // Login attempts tracking
    this.loginAttempts = new Map();
    
    // Audit log
    this.auditLog = [];
    
    // Pool reference
    this.pool = null;
    
    // Setup routes
    this.setupRoutes();
    
    // Create default admin
    this.createDefaultAdmin();
  }
  
  /**
   * Initialize with pool reference
   */
  initialize(pool) {
    this.pool = pool;
    logger.info('Remote management API initialized');
  }
  
  /**
   * Create default admin user
   */
  createDefaultAdmin() {
    const defaultAdmin = {
      username: 'admin',
      password: this.hashPassword('otedama-admin-2024'),
      permissions: [AdminPermission.FULL_ACCESS],
      createdAt: Date.now(),
      lastLogin: null,
      apiKeys: []
    };
    
    this.adminUsers.set('admin', defaultAdmin);
    logger.info('Default admin user created (change password immediately!)');
  }
  
  /**
   * Hash password
   */
  hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
  }
  
  /**
   * Verify password
   */
  verifyPassword(password, storedPassword) {
    const [salt, hash] = storedPassword.split(':');
    const verifyHash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return hash === verifyHash;
  }
  
  /**
   * Generate JWT token
   */
  generateToken(username, permissions) {
    return jwt.sign(
      { username, permissions },
      this.config.jwtSecret,
      { expiresIn: this.config.tokenExpiry }
    );
  }
  
  /**
   * Verify JWT token middleware
   */
  authenticateToken(requiredPermission = null) {
    return (req, res, next) => {
      const authHeader = req.headers['authorization'];
      const token = authHeader && authHeader.split(' ')[1];
      
      if (!token) {
        return res.status(401).json({ error: 'Access token required' });
      }
      
      jwt.verify(token, this.config.jwtSecret, (err, user) => {
        if (err) {
          return res.status(403).json({ error: 'Invalid or expired token' });
        }
        
        // Check permission
        if (requiredPermission && !this.hasPermission(user.permissions, requiredPermission)) {
          return res.status(403).json({ error: 'Insufficient permissions' });
        }
        
        req.user = user;
        next();
      });
    };
  }
  
  /**
   * Check if user has permission
   */
  hasPermission(userPermissions, requiredPermission) {
    if (userPermissions.includes(AdminPermission.FULL_ACCESS)) return true;
    return userPermissions.includes(requiredPermission);
  }
  
  /**
   * Audit log middleware
   */
  auditLog(action) {
    return (req, res, next) => {
      if (this.config.enableAuditLog) {
        const entry = {
          timestamp: Date.now(),
          action,
          user: req.user?.username || 'anonymous',
          ip: req.ip,
          path: req.path,
          method: req.method,
          body: req.body,
          result: null
        };
        
        // Capture response
        const originalSend = res.send;
        res.send = function(data) {
          entry.result = res.statusCode;
          this.auditLog.push(entry);
          
          // Keep last 10000 entries
          if (this.auditLog.length > 10000) {
            this.auditLog.shift();
          }
          
          originalSend.call(res, data);
        }.bind(this);
      }
      
      next();
    };
  }
  
  /**
   * Setup routes
   */
  setupRoutes() {
    // Rate limiting for auth endpoints
    const authLimiter = rateLimiter.createLimiter({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 5 // 5 requests per window
    });
    
    // Authentication
    this.router.post('/auth/login', authLimiter, this.handleLogin.bind(this));
    this.router.post('/auth/logout', this.authenticateToken(), this.handleLogout.bind(this));
    this.router.post('/auth/change-password', this.authenticateToken(), this.handleChangePassword.bind(this));
    
    // Admin user management
    this.router.get('/users', this.authenticateToken(AdminPermission.FULL_ACCESS), this.handleGetUsers.bind(this));
    this.router.post('/users', this.authenticateToken(AdminPermission.FULL_ACCESS), this.handleCreateUser.bind(this));
    this.router.delete('/users/:username', this.authenticateToken(AdminPermission.FULL_ACCESS), this.handleDeleteUser.bind(this));
    
    // Pool statistics
    this.router.get('/stats', this.authenticateToken(AdminPermission.VIEW_STATS), this.handleGetStats.bind(this));
    this.router.get('/stats/detailed', this.authenticateToken(AdminPermission.VIEW_STATS), this.handleGetDetailedStats.bind(this));
    
    // Miner management
    this.router.get('/miners', this.authenticateToken(AdminPermission.MANAGE_MINERS), this.handleGetMiners.bind(this));
    this.router.get('/miners/:id', this.authenticateToken(AdminPermission.MANAGE_MINERS), this.handleGetMiner.bind(this));
    this.router.post('/miners/:id/ban', this.authenticateToken(AdminPermission.MANAGE_MINERS), this.auditLog('ban_miner'), this.handleBanMiner.bind(this));
    this.router.post('/miners/:id/unban', this.authenticateToken(AdminPermission.MANAGE_MINERS), this.auditLog('unban_miner'), this.handleUnbanMiner.bind(this));
    
    // Pool configuration
    this.router.get('/config', this.authenticateToken(AdminPermission.CONFIGURE_POOL), this.handleGetConfig.bind(this));
    this.router.put('/config', this.authenticateToken(AdminPermission.CONFIGURE_POOL), this.auditLog('update_config'), this.handleUpdateConfig.bind(this));
    this.router.post('/config/difficulty', this.authenticateToken(AdminPermission.CONFIGURE_POOL), this.auditLog('update_difficulty'), this.handleUpdateDifficulty.bind(this));
    
    // Payment management
    this.router.get('/payments', this.authenticateToken(AdminPermission.MANAGE_PAYMENTS), this.handleGetPayments.bind(this));
    this.router.post('/payments/process', this.authenticateToken(AdminPermission.MANAGE_PAYMENTS), this.auditLog('process_payments'), this.handleProcessPayments.bind(this));
    this.router.get('/payments/pending', this.authenticateToken(AdminPermission.MANAGE_PAYMENTS), this.handleGetPendingPayments.bind(this));
    
    // System control
    this.router.post('/system/restart', this.authenticateToken(AdminPermission.SYSTEM_CONTROL), this.auditLog('restart_pool'), this.handleRestartPool.bind(this));
    this.router.post('/system/maintenance', this.authenticateToken(AdminPermission.SYSTEM_CONTROL), this.auditLog('maintenance_mode'), this.handleMaintenanceMode.bind(this));
    this.router.get('/system/health', this.authenticateToken(AdminPermission.VIEW_STATS), this.handleHealthCheck.bind(this));
    
    // Audit log
    this.router.get('/audit', this.authenticateToken(AdminPermission.FULL_ACCESS), this.handleGetAuditLog.bind(this));
    
    // API keys
    this.router.post('/apikeys', this.authenticateToken(), this.handleCreateAPIKey.bind(this));
    this.router.get('/apikeys', this.authenticateToken(), this.handleGetAPIKeys.bind(this));
    this.router.delete('/apikeys/:key', this.authenticateToken(), this.handleDeleteAPIKey.bind(this));
  }
  
  /**
   * Handle login
   */
  async handleLogin(req, res) {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    // Check lockout
    const attempts = this.loginAttempts.get(username) || { count: 0, lastAttempt: 0 };
    if (attempts.count >= this.config.maxLoginAttempts) {
      const timeSinceLastAttempt = Date.now() - attempts.lastAttempt;
      if (timeSinceLastAttempt < this.config.lockoutDuration) {
        const remainingTime = Math.ceil((this.config.lockoutDuration - timeSinceLastAttempt) / 1000);
        return res.status(429).json({ error: `Account locked. Try again in ${remainingTime} seconds` });
      } else {
        // Reset attempts after lockout period
        this.loginAttempts.delete(username);
      }
    }
    
    const user = this.adminUsers.get(username);
    if (!user || !this.verifyPassword(password, user.password)) {
      // Track failed attempt
      attempts.count++;
      attempts.lastAttempt = Date.now();
      this.loginAttempts.set(username, attempts);
      
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Success - reset attempts
    this.loginAttempts.delete(username);
    
    // Update last login
    user.lastLogin = Date.now();
    
    // Generate token
    const token = this.generateToken(username, user.permissions);
    
    res.json({
      token,
      username,
      permissions: user.permissions,
      expiresIn: this.config.tokenExpiry
    });
  }
  
  /**
   * Handle logout
   */
  async handleLogout(req, res) {
    // In a real implementation, you might want to blacklist the token
    res.json({ message: 'Logged out successfully' });
  }
  
  /**
   * Handle change password
   */
  async handleChangePassword(req, res) {
    const { currentPassword, newPassword } = req.body;
    const username = req.user.username;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }
    
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    
    const user = this.adminUsers.get(username);
    if (!this.verifyPassword(currentPassword, user.password)) {
      return res.status(401).json({ error: 'Current password incorrect' });
    }
    
    user.password = this.hashPassword(newPassword);
    user.passwordChangedAt = Date.now();
    
    res.json({ message: 'Password changed successfully' });
  }
  
  /**
   * Handle get users
   */
  async handleGetUsers(req, res) {
    const users = Array.from(this.adminUsers.entries()).map(([username, user]) => ({
      username,
      permissions: user.permissions,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin
    }));
    
    res.json({ users });
  }
  
  /**
   * Handle create user
   */
  async handleCreateUser(req, res) {
    const { username, password, permissions } = req.body;
    
    if (!username || !password || !permissions) {
      return res.status(400).json({ error: 'Username, password, and permissions required' });
    }
    
    if (this.adminUsers.has(username)) {
      return res.status(409).json({ error: 'User already exists' });
    }
    
    const newUser = {
      username,
      password: this.hashPassword(password),
      permissions,
      createdAt: Date.now(),
      lastLogin: null,
      apiKeys: []
    };
    
    this.adminUsers.set(username, newUser);
    
    res.json({ message: 'User created successfully', username });
  }
  
  /**
   * Handle delete user
   */
  async handleDeleteUser(req, res) {
    const { username } = req.params;
    
    if (username === 'admin') {
      return res.status(403).json({ error: 'Cannot delete default admin user' });
    }
    
    if (!this.adminUsers.has(username)) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    this.adminUsers.delete(username);
    
    res.json({ message: 'User deleted successfully' });
  }
  
  /**
   * Handle get stats
   */
  async handleGetStats(req, res) {
    if (!this.pool) {
      return res.status(503).json({ error: 'Pool not initialized' });
    }
    
    const stats = this.pool.getStats();
    res.json(stats);
  }
  
  /**
   * Handle get detailed stats
   */
  async handleGetDetailedStats(req, res) {
    if (!this.pool) {
      return res.status(503).json({ error: 'Pool not initialized' });
    }
    
    const detailedStats = {
      pool: this.pool.getStats(),
      miners: this.pool.minerManager.getDetailedStats(),
      shares: this.pool.shareValidator.getStats(),
      payments: this.pool.paymentProcessor.getStats(),
      network: this.pool.getNetworkStats(),
      performance: this.pool.getPerformanceMetrics()
    };
    
    res.json(detailedStats);
  }
  
  /**
   * Handle get miners
   */
  async handleGetMiners(req, res) {
    if (!this.pool) {
      return res.status(503).json({ error: 'Pool not initialized' });
    }
    
    const { limit = 100, offset = 0, sortBy = 'hashrate', order = 'desc' } = req.query;
    
    const miners = this.pool.minerManager.getAllMiners();
    
    // Sort miners
    miners.sort((a, b) => {
      const aVal = a[sortBy] || 0;
      const bVal = b[sortBy] || 0;
      return order === 'desc' ? bVal - aVal : aVal - bVal;
    });
    
    // Paginate
    const paginatedMiners = miners.slice(offset, offset + limit);
    
    res.json({
      total: miners.length,
      miners: paginatedMiners,
      limit,
      offset
    });
  }
  
  /**
   * Handle get miner
   */
  async handleGetMiner(req, res) {
    if (!this.pool) {
      return res.status(503).json({ error: 'Pool not initialized' });
    }
    
    const { id } = req.params;
    const miner = this.pool.minerManager.getMiner(id);
    
    if (!miner) {
      return res.status(404).json({ error: 'Miner not found' });
    }
    
    res.json(miner);
  }
  
  /**
   * Handle ban miner
   */
  async handleBanMiner(req, res) {
    if (!this.pool) {
      return res.status(503).json({ error: 'Pool not initialized' });
    }
    
    const { id } = req.params;
    const { reason, duration } = req.body;
    
    try {
      await this.pool.minerManager.banMiner(id, reason, duration);
      res.json({ message: 'Miner banned successfully' });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }
  
  /**
   * Handle unban miner
   */
  async handleUnbanMiner(req, res) {
    if (!this.pool) {
      return res.status(503).json({ error: 'Pool not initialized' });
    }
    
    const { id } = req.params;
    
    try {
      await this.pool.minerManager.unbanMiner(id);
      res.json({ message: 'Miner unbanned successfully' });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }
  
  /**
   * Handle get config
   */
  async handleGetConfig(req, res) {
    if (!this.pool) {
      return res.status(503).json({ error: 'Pool not initialized' });
    }
    
    const config = {
      poolName: this.pool.config.poolName,
      poolFee: this.pool.config.poolFee,
      paymentScheme: this.pool.config.paymentScheme,
      minimumPayment: this.pool.config.minimumPayment,
      paymentInterval: this.pool.config.paymentInterval,
      difficulty: this.pool.config.startDifficulty,
      ports: {
        stratum: this.pool.config.port,
        api: this.pool.config.apiPort,
        p2p: this.pool.config.p2pPort
      }
    };
    
    res.json(config);
  }
  
  /**
   * Handle update config
   */
  async handleUpdateConfig(req, res) {
    if (!this.pool) {
      return res.status(503).json({ error: 'Pool not initialized' });
    }
    
    const updates = req.body;
    
    // Validate updates
    const allowedUpdates = ['poolFee', 'minimumPayment', 'paymentInterval'];
    const validUpdates = {};
    
    for (const key of allowedUpdates) {
      if (key in updates) {
        validUpdates[key] = updates[key];
      }
    }
    
    // Apply updates
    Object.assign(this.pool.config, validUpdates);
    
    res.json({ message: 'Configuration updated', updates: validUpdates });
  }
  
  /**
   * Handle update difficulty
   */
  async handleUpdateDifficulty(req, res) {
    if (!this.pool) {
      return res.status(503).json({ error: 'Pool not initialized' });
    }
    
    const { difficulty } = req.body;
    
    if (!difficulty || difficulty <= 0) {
      return res.status(400).json({ error: 'Invalid difficulty' });
    }
    
    this.pool.updateDifficulty(difficulty);
    
    res.json({ message: 'Difficulty updated', difficulty });
  }
  
  /**
   * Handle get payments
   */
  async handleGetPayments(req, res) {
    if (!this.pool) {
      return res.status(503).json({ error: 'Pool not initialized' });
    }
    
    const { limit = 100, offset = 0 } = req.query;
    
    const payments = await this.pool.paymentProcessor.getRecentPayments(limit, offset);
    
    res.json({
      total: payments.total,
      payments: payments.data,
      limit,
      offset
    });
  }
  
  /**
   * Handle process payments
   */
  async handleProcessPayments(req, res) {
    if (!this.pool) {
      return res.status(503).json({ error: 'Pool not initialized' });
    }
    
    try {
      const result = await this.pool.paymentProcessor.processPayments();
      res.json({
        message: 'Payments processed',
        processed: result.processed,
        total: result.total,
        failed: result.failed
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
  
  /**
   * Handle get pending payments
   */
  async handleGetPendingPayments(req, res) {
    if (!this.pool) {
      return res.status(503).json({ error: 'Pool not initialized' });
    }
    
    const pending = await this.pool.paymentProcessor.getPendingPayments();
    
    res.json({
      count: pending.length,
      totalAmount: pending.reduce((sum, p) => sum + p.amount, 0),
      payments: pending
    });
  }
  
  /**
   * Handle restart pool
   */
  async handleRestartPool(req, res) {
    if (!this.pool) {
      return res.status(503).json({ error: 'Pool not initialized' });
    }
    
    try {
      // Schedule restart
      setTimeout(async () => {
        await this.pool.restart();
      }, 1000);
      
      res.json({ message: 'Pool restart scheduled' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
  
  /**
   * Handle maintenance mode
   */
  async handleMaintenanceMode(req, res) {
    if (!this.pool) {
      return res.status(503).json({ error: 'Pool not initialized' });
    }
    
    const { enabled, message } = req.body;
    
    this.pool.setMaintenanceMode(enabled, message);
    
    res.json({
      message: `Maintenance mode ${enabled ? 'enabled' : 'disabled'}`,
      maintenanceMode: enabled
    });
  }
  
  /**
   * Handle health check
   */
  async handleHealthCheck(req, res) {
    if (!this.pool) {
      return res.status(503).json({ error: 'Pool not initialized' });
    }
    
    const health = await this.pool.getHealthStatus();
    
    const statusCode = health.status === 'healthy' ? 200 : 
                      health.status === 'degraded' ? 206 : 503;
    
    res.status(statusCode).json(health);
  }
  
  /**
   * Handle get audit log
   */
  async handleGetAuditLog(req, res) {
    const { limit = 100, offset = 0, action, user } = req.query;
    
    let filteredLog = this.auditLog;
    
    // Filter by action
    if (action) {
      filteredLog = filteredLog.filter(entry => entry.action === action);
    }
    
    // Filter by user
    if (user) {
      filteredLog = filteredLog.filter(entry => entry.user === user);
    }
    
    // Sort by timestamp (newest first)
    filteredLog.sort((a, b) => b.timestamp - a.timestamp);
    
    // Paginate
    const paginatedLog = filteredLog.slice(offset, offset + limit);
    
    res.json({
      total: filteredLog.length,
      entries: paginatedLog,
      limit,
      offset
    });
  }
  
  /**
   * Handle create API key
   */
  async handleCreateAPIKey(req, res) {
    const { name, permissions } = req.body;
    const username = req.user.username;
    
    if (!name) {
      return res.status(400).json({ error: 'API key name required' });
    }
    
    const user = this.adminUsers.get(username);
    
    // Generate API key
    const apiKey = `otedama_${crypto.randomBytes(32).toString('hex')}`;
    
    const keyData = {
      key: apiKey,
      name,
      permissions: permissions || user.permissions,
      createdAt: Date.now(),
      lastUsed: null
    };
    
    user.apiKeys.push(keyData);
    
    res.json({
      message: 'API key created',
      apiKey,
      name
    });
  }
  
  /**
   * Handle get API keys
   */
  async handleGetAPIKeys(req, res) {
    const username = req.user.username;
    const user = this.adminUsers.get(username);
    
    const keys = user.apiKeys.map(key => ({
      name: key.name,
      permissions: key.permissions,
      createdAt: key.createdAt,
      lastUsed: key.lastUsed,
      keyPreview: key.key.substring(0, 16) + '...'
    }));
    
    res.json({ apiKeys: keys });
  }
  
  /**
   * Handle delete API key
   */
  async handleDeleteAPIKey(req, res) {
    const { key } = req.params;
    const username = req.user.username;
    const user = this.adminUsers.get(username);
    
    const index = user.apiKeys.findIndex(k => k.key === key);
    if (index === -1) {
      return res.status(404).json({ error: 'API key not found' });
    }
    
    user.apiKeys.splice(index, 1);
    
    res.json({ message: 'API key deleted' });
  }
  
  /**
   * Get Express router
   */
  getRouter() {
    return this.router;
  }
}

export default RemoteManagementAPI;
