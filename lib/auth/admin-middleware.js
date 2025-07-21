/**
 * Admin Authentication Middleware
 * 
 * Handles admin-only routes and permissions
 * Works without domain requirements (IP-based)
 */

import jwt from 'jsonwebtoken';
import { DatabaseManager } from '../core/database-manager.js';
import { createHash } from 'crypto';

export class AdminMiddleware {
    constructor(options = {}) {
        this.db = options.db || new DatabaseManager();
        
        // Admin settings (IP-based access)
        this.allowedAdminIPs = this.parseIPList(process.env.ADMIN_ALLOWED_IPS || '127.0.0.1,::1');
        this.requireIPWhitelist = process.env.ADMIN_REQUIRE_IP_WHITELIST === 'true';
        this.adminSecret = process.env.ADMIN_SECRET || process.env.JWT_SECRET;
        
        // Permission levels
        this.permissionLevels = {
            superadmin: 100,
            admin: 80,
            moderator: 60,
            support: 40,
            user: 20
        };
    }
    
    /**
     * Parse IP whitelist
     */
    parseIPList(ipString) {
        return ipString.split(',').map(ip => ip.trim()).filter(ip => ip);
    }
    
    /**
     * Check if IP is allowed
     */
    isIPAllowed(ip) {
        // Always allow localhost
        if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') {
            return true;
        }
        
        // Check if IP is in whitelist
        return this.allowedAdminIPs.includes(ip);
    }
    
    /**
     * Get client IP
     */
    getClientIP(req) {
        return req.ip || 
               req.headers['x-forwarded-for']?.split(',')[0] || 
               req.headers['x-real-ip'] ||
               req.connection.remoteAddress ||
               req.socket.remoteAddress ||
               'unknown';
    }
    
    /**
     * Admin authentication middleware
     */
    async requireAdmin(req, res, next) {
        try {
            // Check IP whitelist if enabled
            if (this.requireIPWhitelist) {
                const clientIP = this.getClientIP(req);
                if (!this.isIPAllowed(clientIP)) {
                    console.warn(`Admin access denied from IP: ${clientIP}`);
                    return res.status(403).json({ 
                        error: 'Access denied from this IP address' 
                    });
                }
            }
            
            // Check authentication
            if (!req.user) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            
            // Check if user is admin
            if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
                return res.status(403).json({ error: 'Admin access required' });
            }
            
            // Verify user still has admin rights in database
            const users = await this.db.query(
                'SELECT role, status FROM users WHERE id = ?',
                [req.user.id]
            );
            
            if (users.length === 0 || users[0].status !== 'active') {
                return res.status(403).json({ error: 'User not found or inactive' });
            }
            
            if (users[0].role !== 'admin' && users[0].role !== 'superadmin') {
                return res.status(403).json({ error: 'Admin privileges revoked' });
            }
            
            // Log admin action
            await this.logAdminAction(req.user.id, req.method, req.path, this.getClientIP(req));
            
            next();
        } catch (error) {
            console.error('Admin middleware error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    
    /**
     * Super admin only middleware
     */
    async requireSuperAdmin(req, res, next) {
        try {
            // Must pass admin check first
            await this.requireAdmin(req, res, () => {
                // Check super admin
                if (req.user.role !== 'superadmin') {
                    return res.status(403).json({ error: 'Super admin access required' });
                }
                next();
            });
        } catch (error) {
            console.error('Super admin middleware error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    
    /**
     * Check specific permission
     */
    hasPermission(userRole, requiredPermission) {
        const userLevel = this.permissionLevels[userRole] || 0;
        const requiredLevel = this.permissionLevels[requiredPermission] || 100;
        return userLevel >= requiredLevel;
    }
    
    /**
     * Permission-based middleware factory
     */
    requirePermission(permission) {
        return async (req, res, next) => {
            try {
                if (!req.user) {
                    return res.status(401).json({ error: 'Authentication required' });
                }
                
                if (!this.hasPermission(req.user.role, permission)) {
                    return res.status(403).json({ 
                        error: `${permission} permission required` 
                    });
                }
                
                next();
            } catch (error) {
                console.error('Permission middleware error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        };
    }
    
    /**
     * API key permission check
     */
    requireApiPermission(permission) {
        return (req, res, next) => {
            // Check if using API key
            if (req.apiKeyPermissions) {
                if (!req.apiKeyPermissions.includes(permission) && 
                    !req.apiKeyPermissions.includes('admin')) {
                    return res.status(403).json({ 
                        error: `API key missing permission: ${permission}` 
                    });
                }
            }
            next();
        };
    }
    
    /**
     * Log admin action
     */
    async logAdminAction(userId, method, path, ip) {
        try {
            await this.db.query(
                `INSERT INTO admin_logs 
                (user_id, action, method, path, ip_address, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
                [userId, 'api_access', method, path, ip, new Date()]
            );
        } catch (error) {
            console.error('Failed to log admin action:', error);
        }
    }
    
    /**
     * Generate admin token (for scripts/tools)
     */
    generateAdminToken(adminId, expiresIn = '1h') {
        return jwt.sign(
            {
                id: adminId,
                role: 'admin',
                type: 'admin_token',
                generated: Date.now()
            },
            this.adminSecret,
            { expiresIn }
        );
    }
    
    /**
     * Verify admin token
     */
    verifyAdminToken(token) {
        try {
            const decoded = jwt.verify(token, this.adminSecret);
            if (decoded.type !== 'admin_token') {
                throw new Error('Invalid token type');
            }
            return decoded;
        } catch (error) {
            throw new Error('Invalid admin token');
        }
    }
}

/**
 * Create admin routes
 */
export function createAdminRoutes(options = {}) {
    const router = express.Router();
    const adminMiddleware = new AdminMiddleware(options);
    const db = options.db || new DatabaseManager();
    
    // Apply admin middleware to all routes
    router.use(adminMiddleware.requireAdmin.bind(adminMiddleware));
    
    // Dashboard stats
    router.get('/dashboard', async (req, res) => {
        try {
            const stats = await db.query(`
                SELECT 
                    (SELECT COUNT(*) FROM users WHERE created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)) as new_users_24h,
                    (SELECT COUNT(*) FROM users WHERE status = 'active') as active_users,
                    (SELECT COUNT(*) FROM workers WHERE active = 1) as active_workers,
                    (SELECT SUM(hashrate) FROM workers WHERE active = 1) as total_hashrate,
                    (SELECT COUNT(*) FROM transactions WHERE created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)) as transactions_24h,
                    (SELECT SUM(amount) FROM transactions WHERE type = 'deposit' AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)) as deposits_24h,
                    (SELECT COUNT(*) FROM orders WHERE created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)) as orders_24h,
                    (SELECT SUM(amount * price) FROM trades WHERE created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)) as volume_24h
            `);
            
            res.json(stats[0]);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    // User management
    router.get('/users', async (req, res) => {
        try {
            const { 
                page = 1, 
                limit = 50, 
                search = '', 
                status = null,
                role = null 
            } = req.query;
            
            let query = `
                SELECT id, username, email, role, status, 
                       created_at, last_login, two_factor_enabled
                FROM users
                WHERE 1=1
            `;
            const params = [];
            
            if (search) {
                query += ' AND (username LIKE ? OR email LIKE ?)';
                params.push(`%${search}%`, `%${search}%`);
            }
            
            if (status) {
                query += ' AND status = ?';
                params.push(status);
            }
            
            if (role) {
                query += ' AND role = ?';
                params.push(role);
            }
            
            query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
            params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
            
            const users = await db.query(query, params);
            
            // Get total count
            const countQuery = query.replace(/SELECT.*FROM/, 'SELECT COUNT(*) as total FROM')
                                   .replace(/ORDER BY.*$/, '');
            const count = await db.query(countQuery, params.slice(0, -2));
            
            res.json({
                users,
                total: count[0].total,
                page: parseInt(page),
                limit: parseInt(limit)
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    // Update user status
    router.put('/users/:id/status', async (req, res) => {
        try {
            const { id } = req.params;
            const { status } = req.body;
            
            if (!['active', 'suspended', 'locked'].includes(status)) {
                return res.status(400).json({ error: 'Invalid status' });
            }
            
            await db.query(
                'UPDATE users SET status = ?, updated_at = ? WHERE id = ?',
                [status, new Date(), id]
            );
            
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    // Update user role (super admin only)
    router.put('/users/:id/role', 
        adminMiddleware.requireSuperAdmin.bind(adminMiddleware),
        async (req, res) => {
            try {
                const { id } = req.params;
                const { role } = req.body;
                
                if (!['user', 'support', 'moderator', 'admin'].includes(role)) {
                    return res.status(400).json({ error: 'Invalid role' });
                }
                
                await db.query(
                    'UPDATE users SET role = ?, updated_at = ? WHERE id = ?',
                    [role, new Date(), id]
                );
                
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        }
    );
    
    // System settings
    router.get('/settings', async (req, res) => {
        try {
            const settings = await db.query('SELECT * FROM system_settings');
            const settingsMap = {};
            
            for (const setting of settings) {
                settingsMap[setting.key] = {
                    value: setting.value,
                    updated_at: setting.updated_at
                };
            }
            
            res.json(settingsMap);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    // Update system setting
    router.put('/settings/:key', 
        adminMiddleware.requireSuperAdmin.bind(adminMiddleware),
        async (req, res) => {
            try {
                const { key } = req.params;
                const { value } = req.body;
                
                await db.query(
                    `INSERT INTO system_settings (key, value, updated_at)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE value = ?, updated_at = ?`,
                    [key, value, new Date(), value, new Date()]
                );
                
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        }
    );
    
    // Admin logs
    router.get('/logs', async (req, res) => {
        try {
            const { page = 1, limit = 100 } = req.query;
            
            const logs = await db.query(
                `SELECT l.*, u.username 
                 FROM admin_logs l
                 JOIN users u ON l.user_id = u.id
                 ORDER BY l.created_at DESC
                 LIMIT ? OFFSET ?`,
                [parseInt(limit), (parseInt(page) - 1) * parseInt(limit)]
            );
            
            res.json(logs);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    // Generate admin token for tools/scripts
    router.post('/generate-token', 
        adminMiddleware.requireSuperAdmin.bind(adminMiddleware),
        async (req, res) => {
            try {
                const { expiresIn = '1h' } = req.body;
                const token = adminMiddleware.generateAdminToken(req.user.id, expiresIn);
                
                res.json({ 
                    token,
                    expiresIn,
                    usage: 'Use this token in X-Admin-Token header for script access'
                });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        }
    );
    
    return router;
}

/**
 * Create admin panel HTML (for local access)
 */
export function getAdminPanelHTML() {
    return `
<!DOCTYPE html>
<html>
<head>
    <title>Otedama Admin Panel</title>
    <style>
        body { 
            font-family: Arial, sans-serif; 
            margin: 0; 
            padding: 20px;
            background: #f5f5f5;
        }
        .container { 
            max-width: 1200px; 
            margin: 0 auto;
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        h1 { color: #333; }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin: 20px 0;
        }
        .stat-card {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 4px;
            text-align: center;
        }
        .stat-value {
            font-size: 2em;
            font-weight: bold;
            color: #007bff;
        }
        .stat-label {
            color: #666;
            margin-top: 5px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
        }
        th, td {
            padding: 10px;
            text-align: left;
            border-bottom: 1px solid #ddd;
        }
        th {
            background: #f8f9fa;
            font-weight: bold;
        }
        .btn {
            padding: 5px 10px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        }
        .btn-primary { background: #007bff; color: white; }
        .btn-danger { background: #dc3545; color: white; }
        .btn-success { background: #28a745; color: white; }
        .alert {
            padding: 10px;
            margin: 10px 0;
            border-radius: 4px;
            background: #fff3cd;
            color: #856404;
            border: 1px solid #ffeaa7;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Otedama Admin Panel</h1>
        <div class="alert">
            ⚠️ Local Access Only - No domain required. Access from IP: <span id="client-ip"></span>
        </div>
        
        <div id="stats" class="stats">
            <div class="stat-card">
                <div class="stat-value" id="active-users">-</div>
                <div class="stat-label">Active Users</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="active-workers">-</div>
                <div class="stat-label">Active Workers</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="total-hashrate">-</div>
                <div class="stat-label">Total Hashrate</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="daily-volume">-</div>
                <div class="stat-label">24h Volume</div>
            </div>
        </div>
        
        <h2>Recent Users</h2>
        <table id="users-table">
            <thead>
                <tr>
                    <th>ID</th>
                    <th>Username</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody id="users-tbody">
                <tr><td colspan="7">Loading...</td></tr>
            </tbody>
        </table>
    </div>
    
    <script>
        // Simple admin panel JS
        const API_BASE = '/api/admin';
        let authToken = localStorage.getItem('adminToken');
        
        async function fetchStats() {
            try {
                const res = await fetch(API_BASE + '/dashboard', {
                    headers: { 'Authorization': 'Bearer ' + authToken }
                });
                const data = await res.json();
                
                document.getElementById('active-users').textContent = data.active_users || 0;
                document.getElementById('active-workers').textContent = data.active_workers || 0;
                document.getElementById('total-hashrate').textContent = formatHashrate(data.total_hashrate || 0);
                document.getElementById('daily-volume').textContent = formatBTC(data.volume_24h || 0);
            } catch (error) {
                console.error('Failed to fetch stats:', error);
            }
        }
        
        async function fetchUsers() {
            try {
                const res = await fetch(API_BASE + '/users?limit=10', {
                    headers: { 'Authorization': 'Bearer ' + authToken }
                });
                const data = await res.json();
                
                const tbody = document.getElementById('users-tbody');
                tbody.innerHTML = data.users.map(user => \`
                    <tr>
                        <td>\${user.id}</td>
                        <td>\${user.username}</td>
                        <td>\${user.email}</td>
                        <td>\${user.role}</td>
                        <td>\${user.status}</td>
                        <td>\${new Date(user.created_at).toLocaleDateString()}</td>
                        <td>
                            <button class="btn btn-primary" onclick="editUser(\${user.id})">Edit</button>
                        </td>
                    </tr>
                \`).join('');
            } catch (error) {
                console.error('Failed to fetch users:', error);
            }
        }
        
        function formatHashrate(h) {
            if (h > 1e12) return (h / 1e12).toFixed(2) + ' TH/s';
            if (h > 1e9) return (h / 1e9).toFixed(2) + ' GH/s';
            if (h > 1e6) return (h / 1e6).toFixed(2) + ' MH/s';
            return h.toFixed(2) + ' H/s';
        }
        
        function formatBTC(amount) {
            return (amount / 1e8).toFixed(8) + ' BTC';
        }
        
        // Get client IP
        fetch('/api/ip').then(r => r.json()).then(data => {
            document.getElementById('client-ip').textContent = data.ip;
        });
        
        // Initial load
        if (authToken) {
            fetchStats();
            fetchUsers();
            setInterval(fetchStats, 30000); // Refresh every 30s
        } else {
            alert('Please login first');
            window.location.href = '/login';
        }
    </script>
</body>
</html>
    `;
}

export default AdminMiddleware;