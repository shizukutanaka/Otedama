const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

class MobileAPI {
  constructor(options = {}) {
    this.config = {
      port: options.port || 3001,
      jwtSecret: options.jwtSecret || 'your-secret-key-change-in-production',
      jwtExpiry: options.jwtExpiry || '7d',
      
      // Rate limiting
      rateLimitWindow: options.rateLimitWindow || 15 * 60 * 1000, // 15 minutes
      rateLimitMax: options.rateLimitMax || 100,
      
      // Push notifications
      fcmServerKey: options.fcmServerKey,
      apnsKey: options.apnsKey,
      
      // Features
      enableWebSocket: options.enableWebSocket !== false,
      enablePushNotifications: options.enablePushNotifications !== false,
      enableOfflineMode: options.enableOfflineMode !== false
    };
    
    this.app = express();
    this.server = http.createServer(this.app);
    this.io = socketIo(this.server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });
    
    // Data stores
    this.users = new Map();
    this.sessions = new Map();
    this.deviceTokens = new Map();
    this.minerData = new Map();
    
    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
  }
  
  setupMiddleware() {
    // Body parser
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    
    // CORS
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      next();
    });
    
    // Rate limiting
    const limiter = rateLimit({
      windowMs: this.config.rateLimitWindow,
      max: this.config.rateLimitMax,
      message: 'Too many requests from this IP'
    });
    this.app.use('/api/', limiter);
    
    // Request logging
    this.app.use((req, res, next) => {
      console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
      next();
    });
  }
  
  setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ status: 'healthy', timestamp: Date.now() });
    });
    
    // Authentication routes
    this.app.post('/api/v1/auth/register', this.handleRegister.bind(this));
    this.app.post('/api/v1/auth/login', this.handleLogin.bind(this));
    this.app.post('/api/v1/auth/logout', this.authenticate.bind(this), this.handleLogout.bind(this));
    this.app.post('/api/v1/auth/refresh', this.handleRefreshToken.bind(this));
    
    // User routes
    this.app.get('/api/v1/user/profile', this.authenticate.bind(this), this.handleGetProfile.bind(this));
    this.app.put('/api/v1/user/profile', this.authenticate.bind(this), this.handleUpdateProfile.bind(this));
    this.app.post('/api/v1/user/device', this.authenticate.bind(this), this.handleRegisterDevice.bind(this));
    
    // Mining routes
    this.app.get('/api/v1/mining/status', this.authenticate.bind(this), this.handleGetMiningStatus.bind(this));
    this.app.post('/api/v1/mining/start', this.authenticate.bind(this), this.handleStartMining.bind(this));
    this.app.post('/api/v1/mining/stop', this.authenticate.bind(this), this.handleStopMining.bind(this));
    this.app.get('/api/v1/mining/stats', this.authenticate.bind(this), this.handleGetStats.bind(this));
    this.app.get('/api/v1/mining/history', this.authenticate.bind(this), this.handleGetHistory.bind(this));
    
    // Pool routes
    this.app.get('/api/v1/pools', this.authenticate.bind(this), this.handleGetPools.bind(this));
    this.app.post('/api/v1/pools/switch', this.authenticate.bind(this), this.handleSwitchPool.bind(this));
    this.app.get('/api/v1/pools/:poolId/stats', this.authenticate.bind(this), this.handleGetPoolStats.bind(this));
    
    // Wallet routes
    this.app.get('/api/v1/wallet/balance', this.authenticate.bind(this), this.handleGetBalance.bind(this));
    this.app.get('/api/v1/wallet/transactions', this.authenticate.bind(this), this.handleGetTransactions.bind(this));
    this.app.post('/api/v1/wallet/withdraw', this.authenticate.bind(this), this.handleWithdraw.bind(this));
    
    // Settings routes
    this.app.get('/api/v1/settings', this.authenticate.bind(this), this.handleGetSettings.bind(this));
    this.app.put('/api/v1/settings', this.authenticate.bind(this), this.handleUpdateSettings.bind(this));
    this.app.get('/api/v1/settings/notifications', this.authenticate.bind(this), this.handleGetNotificationSettings.bind(this));
    this.app.put('/api/v1/settings/notifications', this.authenticate.bind(this), this.handleUpdateNotificationSettings.bind(this));
    
    // Quick actions
    this.app.post('/api/v1/quick/start', this.authenticate.bind(this), this.handleQuickStart.bind(this));
    this.app.get('/api/v1/quick/summary', this.authenticate.bind(this), this.handleQuickSummary.bind(this));
    
    // Error handling
    this.app.use((err, req, res, next) => {
      console.error('API Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });
  }
  
  setupWebSocket() {
    if (!this.config.enableWebSocket) return;
    
    this.io.use((socket, next) => {
      const token = socket.handshake.auth.token;
      
      try {
        const decoded = jwt.verify(token, this.config.jwtSecret);
        socket.userId = decoded.userId;
        next();
      } catch (err) {
        next(new Error('Authentication error'));
      }
    });
    
    this.io.on('connection', (socket) => {
      console.log(`User ${socket.userId} connected via WebSocket`);
      
      // Join user room
      socket.join(`user:${socket.userId}`);
      
      // Real-time events
      socket.on('subscribe:stats', () => {
        socket.join('stats');
        this.sendCurrentStats(socket);
      });
      
      socket.on('unsubscribe:stats', () => {
        socket.leave('stats');
      });
      
      socket.on('subscribe:mining', () => {
        socket.join(`mining:${socket.userId}`);
        this.sendMiningStatus(socket);
      });
      
      socket.on('control:start', async (data) => {
        await this.handleRemoteStart(socket, data);
      });
      
      socket.on('control:stop', async () => {
        await this.handleRemoteStop(socket);
      });
      
      socket.on('disconnect', () => {
        console.log(`User ${socket.userId} disconnected`);
      });
    });
    
    // Start broadcasting stats
    this.startStatsBroadcast();
  }
  
  // Authentication middleware
  authenticate(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    try {
      const decoded = jwt.verify(token, this.config.jwtSecret);
      req.userId = decoded.userId;
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  }
  
  // Auth handlers
  async handleRegister(req, res) {
    try {
      const { email, password, walletAddress } = req.body;
      
      // Validate input
      if (!email || !password || !walletAddress) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      
      // Check if user exists
      if (this.users.has(email)) {
        return res.status(409).json({ error: 'User already exists' });
      }
      
      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);
      
      // Create user
      const userId = uuidv4();
      const user = {
        id: userId,
        email,
        password: hashedPassword,
        walletAddress,
        createdAt: Date.now(),
        settings: {
          autoStart: false,
          notifications: {
            blockFound: true,
            paymentReceived: true,
            minerOffline: true
          }
        }
      };
      
      this.users.set(email, user);
      
      // Generate token
      const token = jwt.sign(
        { userId, email },
        this.config.jwtSecret,
        { expiresIn: this.config.jwtExpiry }
      );
      
      res.json({
        success: true,
        token,
        user: {
          id: userId,
          email,
          walletAddress
        }
      });
      
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
  
  async handleLogin(req, res) {
    try {
      const { email, password } = req.body;
      
      // Get user
      const user = this.users.get(email);
      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      
      // Verify password
      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      
      // Generate token
      const token = jwt.sign(
        { userId: user.id, email },
        this.config.jwtSecret,
        { expiresIn: this.config.jwtExpiry }
      );
      
      // Create session
      const sessionId = uuidv4();
      this.sessions.set(sessionId, {
        userId: user.id,
        createdAt: Date.now()
      });
      
      res.json({
        success: true,
        token,
        sessionId,
        user: {
          id: user.id,
          email: user.email,
          walletAddress: user.walletAddress
        }
      });
      
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
  
  async handleLogout(req, res) {
    // Remove session
    const sessionId = req.headers['x-session-id'];
    if (sessionId) {
      this.sessions.delete(sessionId);
    }
    
    res.json({ success: true });
  }
  
  async handleRefreshToken(req, res) {
    try {
      const { refreshToken } = req.body;
      
      // Verify refresh token
      const decoded = jwt.verify(refreshToken, this.config.jwtSecret);
      
      // Generate new token
      const token = jwt.sign(
        { userId: decoded.userId, email: decoded.email },
        this.config.jwtSecret,
        { expiresIn: this.config.jwtExpiry }
      );
      
      res.json({ success: true, token });
      
    } catch (error) {
      res.status(401).json({ error: 'Invalid refresh token' });
    }
  }
  
  // User handlers
  async handleGetProfile(req, res) {
    const user = this.getUserById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({
      id: user.id,
      email: user.email,
      walletAddress: user.walletAddress,
      createdAt: user.createdAt,
      settings: user.settings
    });
  }
  
  async handleUpdateProfile(req, res) {
    const user = this.getUserById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const { walletAddress, settings } = req.body;
    
    if (walletAddress) {
      user.walletAddress = walletAddress;
    }
    
    if (settings) {
      user.settings = { ...user.settings, ...settings };
    }
    
    res.json({ success: true, user });
  }
  
  async handleRegisterDevice(req, res) {
    const { deviceToken, platform } = req.body;
    
    if (!deviceToken || !platform) {
      return res.status(400).json({ error: 'Missing device token or platform' });
    }
    
    // Store device token for push notifications
    if (!this.deviceTokens.has(req.userId)) {
      this.deviceTokens.set(req.userId, []);
    }
    
    const tokens = this.deviceTokens.get(req.userId);
    const existingIndex = tokens.findIndex(t => t.token === deviceToken);
    
    if (existingIndex >= 0) {
      tokens[existingIndex] = { token: deviceToken, platform, updatedAt: Date.now() };
    } else {
      tokens.push({ token: deviceToken, platform, createdAt: Date.now() });
    }
    
    res.json({ success: true });
  }
  
  // Mining handlers
  async handleGetMiningStatus(req, res) {
    const minerData = this.minerData.get(req.userId) || {
      status: 'idle',
      hashrate: 0,
      shares: { accepted: 0, rejected: 0 },
      uptime: 0,
      earnings: 0
    };
    
    res.json(minerData);
  }
  
  async handleStartMining(req, res) {
    const { algorithm, pool, intensity } = req.body;
    
    // Simulate starting mining
    this.minerData.set(req.userId, {
      status: 'mining',
      algorithm: algorithm || 'RandomX',
      pool: pool || 'auto',
      intensity: intensity || 'balanced',
      startTime: Date.now(),
      hashrate: 0,
      shares: { accepted: 0, rejected: 0 }
    });
    
    // Send push notification
    await this.sendPushNotification(req.userId, {
      title: 'Mining Started',
      body: 'Your miner has started successfully',
      data: { type: 'mining_started' }
    });
    
    res.json({ success: true, message: 'Mining started' });
  }
  
  async handleStopMining(req, res) {
    const minerData = this.minerData.get(req.userId);
    
    if (minerData) {
      minerData.status = 'idle';
      minerData.hashrate = 0;
    }
    
    res.json({ success: true, message: 'Mining stopped' });
  }
  
  async handleGetStats(req, res) {
    const { period = '24h' } = req.query;
    
    // Simulated stats
    const stats = {
      period,
      hashrate: {
        current: 45670000, // 45.67 MH/s
        average: 43210000,
        peak: 52340000
      },
      shares: {
        accepted: 1234,
        rejected: 12,
        efficiency: 99.03
      },
      earnings: {
        today: 0.00123,
        yesterday: 0.00119,
        week: 0.00834,
        month: 0.03421
      },
      uptime: {
        percentage: 98.5,
        totalHours: 672
      }
    };
    
    res.json(stats);
  }
  
  async handleGetHistory(req, res) {
    const { days = 7 } = req.query;
    
    // Generate sample history
    const history = [];
    const now = Date.now();
    
    for (let i = 0; i < days; i++) {
      const date = new Date(now - (i * 24 * 60 * 60 * 1000));
      history.push({
        date: date.toISOString().split('T')[0],
        hashrate: 40000000 + Math.random() * 10000000,
        shares: {
          accepted: Math.floor(1000 + Math.random() * 500),
          rejected: Math.floor(Math.random() * 20)
        },
        earnings: 0.001 + Math.random() * 0.0005,
        uptime: 90 + Math.random() * 10
      });
    }
    
    res.json(history);
  }
  
  // Pool handlers
  async handleGetPools(req, res) {
    const pools = [
      {
        id: 'otedama-p2p',
        name: 'Otedama P2P Pool',
        region: 'Global',
        fee: 1,
        hashrate: 1234567890000,
        miners: 12345,
        status: 'active'
      },
      {
        id: 'asia-pool',
        name: 'Asia Mining Pool',
        region: 'Asia',
        fee: 2,
        hashrate: 987654321000,
        miners: 8765,
        status: 'active'
      }
    ];
    
    res.json(pools);
  }
  
  async handleSwitchPool(req, res) {
    const { poolId } = req.body;
    
    const minerData = this.minerData.get(req.userId);
    if (minerData) {
      minerData.pool = poolId;
    }
    
    res.json({ success: true, message: `Switched to pool ${poolId}` });
  }
  
  async handleGetPoolStats(req, res) {
    const { poolId } = req.params;
    
    const stats = {
      poolId,
      hashrate: 1234567890000,
      miners: 12345,
      fee: 1,
      lastBlock: {
        height: 700000,
        time: Date.now() - 300000,
        reward: 6.25
      },
      nextPayout: Date.now() + 3600000
    };
    
    res.json(stats);
  }
  
  // Wallet handlers
  async handleGetBalance(req, res) {
    const balance = {
      confirmed: 0.12345678,
      unconfirmed: 0.00123456,
      total: 0.12469134,
      currency: 'BTC',
      usdValue: 6234.57
    };
    
    res.json(balance);
  }
  
  async handleGetTransactions(req, res) {
    const { limit = 10, offset = 0 } = req.query;
    
    const transactions = [];
    for (let i = 0; i < limit; i++) {
      transactions.push({
        id: `tx-${offset + i}`,
        type: i % 3 === 0 ? 'payout' : 'mining_reward',
        amount: 0.001 + Math.random() * 0.01,
        status: 'confirmed',
        confirmations: Math.floor(Math.random() * 100),
        timestamp: Date.now() - (i * 3600000),
        txid: `${Math.random().toString(36).substring(2)}${Math.random().toString(36).substring(2)}`
      });
    }
    
    res.json({
      transactions,
      total: 100,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  }
  
  async handleWithdraw(req, res) {
    const { amount, address, twoFactorCode } = req.body;
    
    // Validate 2FA if enabled
    // Process withdrawal
    
    res.json({
      success: true,
      transactionId: `wd-${Date.now()}`,
      message: 'Withdrawal initiated'
    });
  }
  
  // Settings handlers
  async handleGetSettings(req, res) {
    const user = this.getUserById(req.userId);
    res.json(user.settings || {});
  }
  
  async handleUpdateSettings(req, res) {
    const user = this.getUserById(req.userId);
    user.settings = { ...user.settings, ...req.body };
    
    res.json({ success: true, settings: user.settings });
  }
  
  async handleGetNotificationSettings(req, res) {
    const user = this.getUserById(req.userId);
    res.json(user.settings.notifications || {});
  }
  
  async handleUpdateNotificationSettings(req, res) {
    const user = this.getUserById(req.userId);
    user.settings.notifications = { ...user.settings.notifications, ...req.body };
    
    res.json({ success: true, notifications: user.settings.notifications });
  }
  
  // Quick actions
  async handleQuickStart(req, res) {
    // One-tap mining start with optimal settings
    const minerData = {
      status: 'mining',
      algorithm: 'auto',
      pool: 'auto',
      intensity: 'balanced',
      startTime: Date.now(),
      hashrate: 0,
      shares: { accepted: 0, rejected: 0 }
    };
    
    this.minerData.set(req.userId, minerData);
    
    res.json({
      success: true,
      message: 'Mining started with optimal settings',
      settings: minerData
    });
  }
  
  async handleQuickSummary(req, res) {
    // Get all important info in one call
    const minerData = this.minerData.get(req.userId) || { status: 'idle' };
    
    const summary = {
      mining: {
        status: minerData.status,
        hashrate: minerData.hashrate || 0,
        efficiency: minerData.shares?.accepted > 0 
          ? (minerData.shares.accepted / (minerData.shares.accepted + minerData.shares.rejected) * 100).toFixed(2)
          : 0
      },
      earnings: {
        today: 0.00123,
        pending: 0.00456,
        total: 0.12345
      },
      alerts: []
    };
    
    res.json(summary);
  }
  
  // WebSocket handlers
  sendCurrentStats(socket) {
    const stats = {
      networkHashrate: 123456789000000,
      poolHashrate: 1234567890000,
      activeMiners: 12345,
      difficulty: 25000000000000,
      blockHeight: 700000,
      price: {
        btc: 50000,
        change24h: 2.5
      }
    };
    
    socket.emit('stats:update', stats);
  }
  
  sendMiningStatus(socket) {
    const minerData = this.minerData.get(socket.userId) || {
      status: 'idle',
      hashrate: 0
    };
    
    socket.emit('mining:status', minerData);
  }
  
  async handleRemoteStart(socket, data) {
    const { algorithm, pool, intensity } = data;
    
    this.minerData.set(socket.userId, {
      status: 'mining',
      algorithm: algorithm || 'auto',
      pool: pool || 'auto',
      intensity: intensity || 'balanced',
      startTime: Date.now(),
      hashrate: 0,
      shares: { accepted: 0, rejected: 0 }
    });
    
    socket.emit('control:started', { success: true });
    
    // Notify other devices
    this.io.to(`user:${socket.userId}`).emit('mining:statusChanged', { status: 'mining' });
  }
  
  async handleRemoteStop(socket) {
    const minerData = this.minerData.get(socket.userId);
    
    if (minerData) {
      minerData.status = 'idle';
      minerData.hashrate = 0;
    }
    
    socket.emit('control:stopped', { success: true });
    
    // Notify other devices
    this.io.to(`user:${socket.userId}`).emit('mining:statusChanged', { status: 'idle' });
  }
  
  startStatsBroadcast() {
    // Broadcast stats every 5 seconds
    setInterval(() => {
      const stats = {
        networkHashrate: 120000000000000 + Math.random() * 10000000000000,
        poolHashrate: 1200000000000 + Math.random() * 100000000000,
        activeMiners: 12000 + Math.floor(Math.random() * 1000),
        difficulty: 25000000000000,
        blockHeight: 700000 + Math.floor(Date.now() / 600000),
        price: {
          btc: 50000 + Math.random() * 1000,
          change24h: -5 + Math.random() * 10
        }
      };
      
      this.io.to('stats').emit('stats:update', stats);
    }, 5000);
    
    // Simulate mining updates
    setInterval(() => {
      for (const [userId, minerData] of this.minerData) {
        if (minerData.status === 'mining') {
          // Update hashrate
          minerData.hashrate = 40000000 + Math.random() * 10000000;
          
          // Simulate shares
          if (Math.random() > 0.7) {
            minerData.shares.accepted++;
          }
          if (Math.random() > 0.98) {
            minerData.shares.rejected++;
          }
          
          // Send update
          this.io.to(`mining:${userId}`).emit('mining:update', {
            hashrate: minerData.hashrate,
            shares: minerData.shares
          });
        }
      }
    }, 2000);
  }
  
  // Push notifications
  async sendPushNotification(userId, notification) {
    if (!this.config.enablePushNotifications) return;
    
    const tokens = this.deviceTokens.get(userId);
    if (!tokens || tokens.length === 0) return;
    
    for (const device of tokens) {
      if (device.platform === 'ios') {
        await this.sendAPNS(device.token, notification);
      } else if (device.platform === 'android') {
        await this.sendFCM(device.token, notification);
      }
    }
  }
  
  async sendFCM(token, notification) {
    // Firebase Cloud Messaging implementation
    console.log(`Sending FCM notification to ${token}:`, notification);
  }
  
  async sendAPNS(token, notification) {
    // Apple Push Notification Service implementation
    console.log(`Sending APNS notification to ${token}:`, notification);
  }
  
  // Helper methods
  getUserById(userId) {
    for (const user of this.users.values()) {
      if (user.id === userId) {
        return user;
      }
    }
    return null;
  }
  
  // Start server
  start() {
    this.server.listen(this.config.port, () => {
      console.log(`Mobile API running on port ${this.config.port}`);
    });
  }
  
  stop() {
    this.server.close();
  }
}

module.exports = MobileAPI;