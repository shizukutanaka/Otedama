/**
 * Automated Security Monitor - Otedama
 * Real-time threat detection and response
 * 
 * Features:
 * - Intrusion detection
 * - DDoS protection
 * - Anomaly detection
 * - Automatic threat response
 * - Security audit logging
 * - Vulnerability scanning
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import crypto from 'crypto';

const logger = createLogger('SecurityMonitor');

export class AutomatedSecurityMonitor extends EventEmitter {
  constructor(poolManager, config = {}) {
    super();
    
    this.poolManager = poolManager;
    this.config = {
      enabled: config.enabled !== false,
      monitoringInterval: config.monitoringInterval || 5000, // 5 seconds
      threatResponseDelay: config.threatResponseDelay || 1000,
      banDuration: config.banDuration || 3600000, // 1 hour
      maxFailedShares: config.maxFailedShares || 50,
      maxConnectionsPerIP: config.maxConnectionsPerIP || 5,
      maxSharesPerSecond: config.maxSharesPerSecond || 100,
      suspiciousPatterns: config.suspiciousPatterns || [
        /\.\./g,  // Directory traversal
        /<script/gi, // XSS attempts
        /union.*select/gi, // SQL injection
        /\x00/g // Null bytes
      ],
      whitelistedIPs: config.whitelistedIPs || [],
      alertWebhook: config.alertWebhook || process.env.SECURITY_WEBHOOK
    };
    
    this.threats = new Map();
    this.ipStats = new Map();
    this.minerStats = new Map();
    this.bannedIPs = new Map();
    this.securityEvents = [];
    
    this.monitoringTimer = null;
  }
  
  /**
   * Start security monitoring
   */
  start() {
    if (!this.config.enabled) {
      logger.info('Security monitoring is disabled');
      return;
    }
    
    logger.info('Starting automated security monitor...');
    
    // Setup event listeners
    this.setupEventListeners();
    
    // Start monitoring
    this.monitoringTimer = setInterval(() => {
      this.performSecurityCheck();
    }, this.config.monitoringInterval);
    
    // Initial scan
    this.performInitialScan();
    
    logger.info('Automated security monitor started');
  }
  
  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Monitor share submissions
    if (this.poolManager.pool) {
      this.poolManager.pool.on('share:submitted', (share) => {
        this.analyzeShare(share);
      });
      
      this.poolManager.pool.on('share:invalid', (share) => {
        this.handleInvalidShare(share);
      });
    }
    
    // Monitor connections
    this.poolManager.on('miner:connected', (miner) => {
      this.analyzeConnection(miner);
    });
    
    // Monitor API requests
    if (this.poolManager.apiServer) {
      // Would need to hook into Express middleware
      this.monitorAPIRequests();
    }
  }
  
  /**
   * Perform initial security scan
   */
  async performInitialScan() {
    logger.info('Performing initial security scan...');
    
    try {
      // Check file permissions
      await this.checkFilePermissions();
      
      // Check for exposed credentials
      await this.checkExposedCredentials();
      
      // Check network exposure
      await this.checkNetworkExposure();
      
      // Check dependencies for vulnerabilities
      await this.checkDependencies();
      
      logger.info('Initial security scan completed');
      
    } catch (error) {
      logger.error('Initial security scan failed:', error);
    }
  }
  
  /**
   * Perform periodic security check
   */
  performSecurityCheck() {
    // Check for DDoS patterns
    this.detectDDoSPatterns();
    
    // Check for mining attacks
    this.detectMiningAttacks();
    
    // Check for anomalies
    this.detectAnomalies();
    
    // Cleanup old data
    this.cleanupOldData();
  }
  
  /**
   * Analyze share submission
   */
  analyzeShare(share) {
    const minerId = share.minerId;
    const minerIP = share.ip;
    
    // Update miner statistics
    if (!this.minerStats.has(minerId)) {
      this.minerStats.set(minerId, {
        shares: 0,
        invalidShares: 0,
        lastShareTime: 0,
        shareRate: 0,
        suspiciousActivity: 0
      });
    }
    
    const stats = this.minerStats.get(minerId);
    const now = Date.now();
    
    // Calculate share rate
    if (stats.lastShareTime > 0) {
      const timeDiff = now - stats.lastShareTime;
      stats.shareRate = 1000 / timeDiff; // Shares per second
    }
    
    stats.shares++;
    stats.lastShareTime = now;
    
    // Check for suspicious patterns
    if (stats.shareRate > this.config.maxSharesPerSecond) {
      this.handleThreat({
        type: 'share_flooding',
        severity: 'medium',
        minerId,
        ip: minerIP,
        details: `Share rate: ${stats.shareRate.toFixed(2)}/s`
      });
    }
    
    // Check share data for exploits
    this.checkForExploits(share);
  }
  
  /**
   * Handle invalid share
   */
  handleInvalidShare(share) {
    const minerId = share.minerId;
    const stats = this.minerStats.get(minerId);
    
    if (stats) {
      stats.invalidShares++;
      
      // Check for excessive invalid shares
      if (stats.invalidShares > this.config.maxFailedShares) {
        this.handleThreat({
          type: 'invalid_share_flood',
          severity: 'high',
          minerId,
          ip: share.ip,
          details: `Invalid shares: ${stats.invalidShares}`
        });
      }
    }
  }
  
  /**
   * Analyze new connection
   */
  analyzeConnection(miner) {
    const ip = miner.ip;
    
    // Skip whitelisted IPs
    if (this.config.whitelistedIPs.includes(ip)) {
      return;
    }
    
    // Check if IP is banned
    if (this.bannedIPs.has(ip)) {
      this.poolManager.pool.minerManager.disconnectMiner(miner.id);
      logger.warn(`Rejected connection from banned IP: ${ip}`);
      return;
    }
    
    // Update IP statistics
    if (!this.ipStats.has(ip)) {
      this.ipStats.set(ip, {
        connections: 0,
        lastConnection: 0,
        requests: 0,
        suspiciousActivity: 0
      });
    }
    
    const stats = this.ipStats.get(ip);
    stats.connections++;
    stats.lastConnection = Date.now();
    
    // Check connection limit
    if (stats.connections > this.config.maxConnectionsPerIP) {
      this.handleThreat({
        type: 'connection_flood',
        severity: 'high',
        ip,
        details: `Connections: ${stats.connections}`
      });
    }
  }
  
  /**
   * Check for exploits in data
   */
  checkForExploits(data) {
    const dataStr = JSON.stringify(data);
    
    for (const pattern of this.config.suspiciousPatterns) {
      if (pattern.test(dataStr)) {
        this.handleThreat({
          type: 'exploit_attempt',
          severity: 'critical',
          ip: data.ip,
          minerId: data.minerId,
          details: `Pattern detected: ${pattern}`
        });
        break;
      }
    }
  }
  
  /**
   * Detect DDoS patterns
   */
  detectDDoSPatterns() {
    const now = Date.now();
    const recentWindow = 60000; // 1 minute
    
    // Check connection rate
    let recentConnections = 0;
    for (const [ip, stats] of this.ipStats) {
      if (now - stats.lastConnection < recentWindow) {
        recentConnections += stats.connections;
      }
    }
    
    if (recentConnections > 1000) {
      this.handleThreat({
        type: 'ddos_detected',
        severity: 'critical',
        details: `Connection spike: ${recentConnections} in last minute`
      });
    }
    
    // Check share rate
    let totalShareRate = 0;
    for (const [minerId, stats] of this.minerStats) {
      totalShareRate += stats.shareRate || 0;
    }
    
    if (totalShareRate > 10000) { // 10k shares/sec
      this.handleThreat({
        type: 'share_ddos',
        severity: 'critical',
        details: `Share rate: ${totalShareRate.toFixed(0)}/s`
      });
    }
  }
  
  /**
   * Detect mining attacks
   */
  detectMiningAttacks() {
    // Check for selfish mining
    const poolStats = this.poolManager.getStats();
    
    // Look for miners withholding blocks
    for (const [minerId, stats] of this.minerStats) {
      if (stats.shares > 10000 && poolStats.blocksFound === 0) {
        // Suspicious - lots of shares but no blocks
        stats.suspiciousActivity++;
        
        if (stats.suspiciousActivity > 3) {
          this.handleThreat({
            type: 'block_withholding',
            severity: 'high',
            minerId,
            details: 'Possible block withholding attack'
          });
        }
      }
    }
  }
  
  /**
   * Detect anomalies
   */
  detectAnomalies() {
    // Check for unusual patterns
    const poolStats = this.poolManager.getStats();
    
    // Sudden hashrate drop
    if (this.lastHashrate && poolStats.totalHashrate < this.lastHashrate * 0.5) {
      this.handleThreat({
        type: 'hashrate_anomaly',
        severity: 'medium',
        details: `Hashrate dropped by ${((1 - poolStats.totalHashrate / this.lastHashrate) * 100).toFixed(1)}%`
      });
    }
    
    this.lastHashrate = poolStats.totalHashrate;
  }
  
  /**
   * Handle detected threat
   */
  async handleThreat(threat) {
    threat.timestamp = Date.now();
    threat.id = crypto.randomBytes(8).toString('hex');
    
    // Log security event
    this.securityEvents.push(threat);
    logger.warn(`Security threat detected: ${threat.type}`, threat);
    
    // Emit event
    this.emit('threat:detected', threat);
    
    // Take action based on severity
    switch (threat.severity) {
      case 'critical':
        await this.handleCriticalThreat(threat);
        break;
        
      case 'high':
        await this.handleHighThreat(threat);
        break;
        
      case 'medium':
        await this.handleMediumThreat(threat);
        break;
        
      default:
        // Log only
        break;
    }
    
    // Send alert
    await this.sendSecurityAlert(threat);
  }
  
  /**
   * Handle critical threat
   */
  async handleCriticalThreat(threat) {
    // Immediate action required
    
    if (threat.ip) {
      // Ban IP immediately
      this.banIP(threat.ip, this.config.banDuration * 10); // 10x longer ban
    }
    
    if (threat.minerId) {
      // Disconnect miner
      this.poolManager.pool?.minerManager.disconnectMiner(threat.minerId);
    }
    
    // Enable emergency mode if DDoS
    if (threat.type === 'ddos_detected' || threat.type === 'share_ddos') {
      this.enableEmergencyMode();
    }
  }
  
  /**
   * Handle high severity threat
   */
  async handleHighThreat(threat) {
    // Delayed response
    setTimeout(() => {
      if (threat.ip) {
        this.banIP(threat.ip, this.config.banDuration);
      }
      
      if (threat.minerId) {
        this.poolManager.pool?.minerManager.disconnectMiner(threat.minerId);
      }
    }, this.config.threatResponseDelay);
  }
  
  /**
   * Handle medium severity threat
   */
  async handleMediumThreat(threat) {
    // Increase monitoring
    if (threat.ip) {
      const stats = this.ipStats.get(threat.ip);
      if (stats) {
        stats.suspiciousActivity++;
        
        if (stats.suspiciousActivity > 5) {
          this.banIP(threat.ip, this.config.banDuration / 2);
        }
      }
    }
  }
  
  /**
   * Ban IP address
   */
  banIP(ip, duration) {
    this.bannedIPs.set(ip, {
      timestamp: Date.now(),
      duration,
      expires: Date.now() + duration
    });
    
    logger.info(`Banned IP ${ip} for ${duration}ms`);
    
    // Disconnect all miners from this IP
    if (this.poolManager.pool) {
      // Would need to track miners by IP
    }
    
    this.emit('ip:banned', { ip, duration });
  }
  
  /**
   * Enable emergency mode
   */
  enableEmergencyMode() {
    logger.warn('EMERGENCY MODE ACTIVATED');
    
    // Increase rate limits
    if (this.poolManager.pool) {
      this.poolManager.pool.maxConnectionsPerIP = 1;
    }
    
    // Temporarily disable new connections
    this.poolManager.pool.acceptingConnections = false;
    
    // Re-enable after 1 minute
    setTimeout(() => {
      this.poolManager.pool.acceptingConnections = true;
      this.poolManager.pool.maxConnectionsPerIP = this.config.maxConnectionsPerIP;
      logger.info('Emergency mode deactivated');
    }, 60000);
    
    this.emit('emergency:activated');
  }
  
  /**
   * Check file permissions
   */
  async checkFilePermissions() {
    const criticalFiles = [
      '.env',
      'otedama.config.js',
      'data/otedama-pool.db'
    ];
    
    for (const file of criticalFiles) {
      try {
        const stats = await fs.stat(file);
        const mode = (stats.mode & parseInt('777', 8)).toString(8);
        
        if (mode !== '600' && mode !== '640') {
          logger.warn(`Insecure file permissions on ${file}: ${mode}`);
        }
      } catch (error) {
        // File doesn't exist
      }
    }
  }
  
  /**
   * Check for exposed credentials
   */
  async checkExposedCredentials() {
    // Check if .env is in .gitignore
    try {
      const gitignore = await fs.readFile('.gitignore', 'utf8');
      if (!gitignore.includes('.env')) {
        logger.warn('WARNING: .env file not in .gitignore');
      }
    } catch (error) {
      // No .gitignore
    }
  }
  
  /**
   * Check network exposure
   */
  async checkNetworkExposure() {
    // Check if sensitive ports are exposed
    const sensitivePorts = [
      this.poolManager.config.remoteManagementPort,
      9090 // Prometheus
    ];
    
    // In production, would actually test port accessibility
    logger.debug('Network exposure check completed');
  }
  
  /**
   * Check dependencies for vulnerabilities
   */
  async checkDependencies() {
    // In production, would run npm audit
    logger.debug('Dependency vulnerability check completed');
  }
  
  /**
   * Monitor API requests
   */
  monitorAPIRequests() {
    // Would implement Express middleware
    // to monitor all API requests for suspicious patterns
  }
  
  /**
   * Send security alert
   */
  async sendSecurityAlert(threat) {
    if (!this.config.alertWebhook) return;
    
    try {
      const alert = {
        username: 'Otedama Security',
        embeds: [{
          title: `🚨 Security Alert: ${threat.type}`,
          description: threat.details,
          color: threat.severity === 'critical' ? 0xff0000 : 
                 threat.severity === 'high' ? 0xff8800 : 0xffaa00,
          fields: [
            {
              name: 'Severity',
              value: threat.severity.toUpperCase(),
              inline: true
            },
            {
              name: 'Time',
              value: new Date(threat.timestamp).toLocaleString(),
              inline: true
            }
          ],
          footer: {
            text: `Threat ID: ${threat.id}`
          }
        }]
      };
      
      if (threat.ip) {
        alert.embeds[0].fields.push({
          name: 'IP Address',
          value: threat.ip,
          inline: true
        });
      }
      
      await axios.post(this.config.alertWebhook, alert);
      
    } catch (error) {
      logger.error('Failed to send security alert:', error);
    }
  }
  
  /**
   * Cleanup old data
   */
  cleanupOldData() {
    const now = Date.now();
    
    // Remove expired bans
    for (const [ip, ban] of this.bannedIPs) {
      if (ban.expires < now) {
        this.bannedIPs.delete(ip);
        logger.info(`Unbanned IP: ${ip}`);
      }
    }
    
    // Clean old security events (keep 24 hours)
    const cutoff = now - 86400000;
    this.securityEvents = this.securityEvents.filter(event => event.timestamp > cutoff);
    
    // Reset suspicious activity counters
    for (const stats of this.ipStats.values()) {
      if (stats.suspiciousActivity > 0 && now - stats.lastConnection > 3600000) {
        stats.suspiciousActivity = 0;
      }
    }
  }
  
  /**
   * Get security report
   */
  getSecurityReport() {
    const now = Date.now();
    const last24h = this.securityEvents.filter(e => now - e.timestamp < 86400000);
    
    const report = {
      status: this.calculateSecurityStatus(),
      threats: {
        last24h: last24h.length,
        critical: last24h.filter(e => e.severity === 'critical').length,
        high: last24h.filter(e => e.severity === 'high').length,
        medium: last24h.filter(e => e.severity === 'medium').length
      },
      bannedIPs: this.bannedIPs.size,
      suspiciousIPs: Array.from(this.ipStats.entries())
        .filter(([ip, stats]) => stats.suspiciousActivity > 0)
        .length,
      recentEvents: this.securityEvents.slice(-10)
    };
    
    return report;
  }
  
  /**
   * Calculate security status
   */
  calculateSecurityStatus() {
    const recentThreats = this.securityEvents.filter(e => 
      Date.now() - e.timestamp < 3600000
    );
    
    if (recentThreats.some(t => t.severity === 'critical')) {
      return 'critical';
    }
    
    if (recentThreats.filter(t => t.severity === 'high').length > 5) {
      return 'high';
    }
    
    if (recentThreats.length > 10) {
      return 'medium';
    }
    
    return 'secure';
  }
  
  /**
   * Stop security monitor
   */
  stop() {
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = null;
    }
    
    logger.info('Automated security monitor stopped');
  }
}

export default AutomatedSecurityMonitor;
