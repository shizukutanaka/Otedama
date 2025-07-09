/**
 * Enhanced Load Balancer & Failover System
 * 設計思想: Carmack (効率性), Martin (クリーン), Pike (シンプル)
 * 
 * 機能:
 * - 高度な負荷分散 (ラウンドロビン・重み付け・最小接続)
 * - 自動フェイルオーバー
 * - リアルタイムヘルスチェック
 * - 地理的分散対応
 * - セッション維持
 * - 自動復旧
 */

import { EventEmitter } from 'events';
import { createProxyServer, ServerProxy } from 'http-proxy';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { createServer as createHttpsServer } from 'https';
import * as net from 'net';

// === 型定義 ===
interface ServerNode {
  id: string;
  host: string;
  port: number;
  protocol: 'http' | 'https';
  weight: number;
  maxConnections: number;
  currentConnections: number;
  status: 'healthy' | 'unhealthy' | 'maintenance';
  region: string;
  datacenter: string;
  lastHealthCheck: number;
  responseTime: number;
  errorCount: number;
  totalRequests: number;
  successfulRequests: number;
  lastError?: string;
  metadata: Record<string, any>;
}

interface LoadBalancerConfig {
  algorithm: 'round_robin' | 'weighted_round_robin' | 'least_connections' | 'least_response_time' | 'ip_hash' | 'geolocation';
  healthCheck: {
    enabled: boolean;
    interval: number;
    timeout: number;
    retries: number;
    path: string;
    expectedStatus: number[];
    failureThreshold: number;
    successThreshold: number;
  };
  failover: {
    enabled: boolean;
    autoFailback: boolean;
    failbackDelay: number;
    maxRetries: number;
    retryInterval: number;
  };
  session: {
    enabled: boolean;
    strategy: 'ip_hash' | 'cookie' | 'header';
    cookieName?: string;
    headerName?: string;
    timeout: number;
  };
  proxy: {
    timeout: number;
    keepAlive: boolean;
    retries: number;
    bufferSize: number;
  };
}

interface SessionInfo {
  sessionId: string;
  nodeId: string;
  clientIp: string;
  createdAt: number;
  lastAccess: number;
  requestCount: number;
}

interface HealthCheckResult {
  nodeId: string;
  healthy: boolean;
  responseTime: number;
  statusCode?: number;
  error?: string;
  timestamp: number;
}

interface LoadBalancerStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  nodes: {
    healthy: number;
    unhealthy: number;
    maintenance: number;
    total: number;
  };
  sessions: {
    active: number;
    total: number;
  };
  uptime: number;
}

// === ヘルスチェックマネージャー ===
class HealthCheckManager extends EventEmitter {
  private nodes = new Map<string, ServerNode>();
  private config: LoadBalancerConfig['healthCheck'];
  private intervals = new Map<string, NodeJS.Timeout>();
  private logger: any;

  constructor(config: LoadBalancerConfig['healthCheck'], logger: any) {
    super();
    this.config = config;
    this.logger = logger;
  }

  addNode(node: ServerNode): void {
    this.nodes.set(node.id, node);
    
    if (this.config.enabled) {
      this.startHealthCheck(node);
    }
    
    this.logger.info(`Added node to health check: ${node.id} (${node.host}:${node.port})`);
  }

  removeNode(nodeId: string): void {
    const interval = this.intervals.get(nodeId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(nodeId);
    }
    
    this.nodes.delete(nodeId);
    this.logger.info(`Removed node from health check: ${nodeId}`);
  }

  private startHealthCheck(node: ServerNode): void {
    const interval = setInterval(async () => {
      await this.performHealthCheck(node);
    }, this.config.interval);
    
    this.intervals.set(node.id, interval);
    
    // 初回チェック
    this.performHealthCheck(node);
  }

  private async performHealthCheck(node: ServerNode): Promise<void> {
    const startTime = Date.now();
    
    try {
      const result = await this.checkNodeHealth(node);
      const responseTime = Date.now() - startTime;
      
      node.lastHealthCheck = Date.now();
      node.responseTime = responseTime;
      
      if (result.healthy) {
        this.handleHealthyResponse(node);
      } else {
        this.handleUnhealthyResponse(node, result.error);
      }
      
      this.emit('healthCheckComplete', {
        nodeId: node.id,
        healthy: result.healthy,
        responseTime,
        statusCode: result.statusCode,
        error: result.error,
        timestamp: Date.now()
      });
      
    } catch (error) {
      this.handleUnhealthyResponse(node, error.message);
    }
  }

  private async checkNodeHealth(node: ServerNode): Promise<{ healthy: boolean; statusCode?: number; error?: string }> {
    return new Promise((resolve) => {
      const url = `${node.protocol}://${node.host}:${node.port}${this.config.path}`;
      const module = node.protocol === 'https' ? require('https') : require('http');
      
      const req = module.get(url, { timeout: this.config.timeout }, (res: any) => {
        const healthy = this.config.expectedStatus.includes(res.statusCode);
        resolve({
          healthy,
          statusCode: res.statusCode
        });
      });
      
      req.on('error', (error: Error) => {
        resolve({
          healthy: false,
          error: error.message
        });
      });
      
      req.on('timeout', () => {
        req.destroy();
        resolve({
          healthy: false,
          error: 'Health check timeout'
        });
      });
    });
  }

  private handleHealthyResponse(node: ServerNode): void {
    if (node.status === 'unhealthy') {
      node.errorCount = 0;
      node.status = 'healthy';
      
      this.logger.info(`Node recovered: ${node.id}`);
      this.emit('nodeRecovered', { nodeId: node.id, node });
    }
  }

  private handleUnhealthyResponse(node: ServerNode, error?: string): void {
    node.errorCount++;
    node.lastError = error;
    
    if (node.errorCount >= this.config.failureThreshold && node.status === 'healthy') {
      node.status = 'unhealthy';
      
      this.logger.warn(`Node marked unhealthy: ${node.id} - ${error}`);
      this.emit('nodeUnhealthy', { nodeId: node.id, node, error });
    }
  }

  getHealthyNodes(): ServerNode[] {
    return Array.from(this.nodes.values()).filter(node => node.status === 'healthy');
  }

  getUnhealthyNodes(): ServerNode[] {
    return Array.from(this.nodes.values()).filter(node => node.status === 'unhealthy');
  }

  getAllNodes(): ServerNode[] {
    return Array.from(this.nodes.values());
  }

  forceHealthCheck(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      this.performHealthCheck(node);
    }
  }

  setNodeMaintenance(nodeId: string, maintenance: boolean): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.status = maintenance ? 'maintenance' : 'healthy';
      this.logger.info(`Node ${nodeId} ${maintenance ? 'entered' : 'exited'} maintenance mode`);
    }
  }

  stop(): void {
    for (const interval of this.intervals.values()) {
      clearInterval(interval);
    }
    this.intervals.clear();
  }
}

// === セッション管理 ===
class SessionManager {
  private sessions = new Map<string, SessionInfo>();
  private config: LoadBalancerConfig['session'];
  private logger: any;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(config: LoadBalancerConfig['session'], logger: any) {
    this.config = config;
    this.logger = logger;
    
    if (config.enabled) {
      this.startCleanup();
    }
  }

  createSession(clientIp: string, nodeId: string, req: IncomingMessage): string | null {
    if (!this.config.enabled) {
      return null;
    }

    const sessionId = this.generateSessionId(clientIp, req);
    
    const session: SessionInfo = {
      sessionId,
      nodeId,
      clientIp,
      createdAt: Date.now(),
      lastAccess: Date.now(),
      requestCount: 1
    };

    this.sessions.set(sessionId, session);
    return sessionId;
  }

  getSessionNode(req: IncomingMessage): string | null {
    if (!this.config.enabled) {
      return null;
    }

    const sessionId = this.extractSessionId(req);
    if (!sessionId) {
      return null;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    // セッション更新
    session.lastAccess = Date.now();
    session.requestCount++;

    return session.nodeId;
  }

  private generateSessionId(clientIp: string, req: IncomingMessage): string {
    switch (this.config.strategy) {
      case 'ip_hash':
        return this.hashIP(clientIp);
      
      case 'cookie':
        const existingCookie = this.extractCookieValue(req, this.config.cookieName!);
        return existingCookie || this.createNewSessionId();
      
      case 'header':
        const existingHeader = req.headers[this.config.headerName!] as string;
        return existingHeader || this.createNewSessionId();
      
      default:
        return this.createNewSessionId();
    }
  }

  private extractSessionId(req: IncomingMessage): string | null {
    switch (this.config.strategy) {
      case 'ip_hash':
        return this.hashIP(this.getClientIP(req));
      
      case 'cookie':
        return this.extractCookieValue(req, this.config.cookieName!);
      
      case 'header':
        return req.headers[this.config.headerName!] as string || null;
      
      default:
        return null;
    }
  }

  private hashIP(ip: string): string {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(ip).digest('hex');
  }

  private getClientIP(req: IncomingMessage): string {
    return (req.headers['x-forwarded-for'] as string)?.split(',')[0] ||
           req.socket.remoteAddress ||
           '127.0.0.1';
  }

  private extractCookieValue(req: IncomingMessage, cookieName: string): string | null {
    const cookies = req.headers.cookie;
    if (!cookies) return null;

    const match = cookies.match(new RegExp(`${cookieName}=([^;]+)`));
    return match ? match[1] : null;
  }

  private createNewSessionId(): string {
    const crypto = require('crypto');
    return crypto.randomBytes(16).toString('hex');
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const expired = [];

      for (const [sessionId, session] of this.sessions) {
        if (now - session.lastAccess > this.config.timeout) {
          expired.push(sessionId);
        }
      }

      for (const sessionId of expired) {
        this.sessions.delete(sessionId);
      }

      if (expired.length > 0) {
        this.logger.debug(`Cleaned up ${expired.length} expired sessions`);
      }
    }, 60000); // 1分間隔
  }

  getActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  getSessionStats(): any {
    const sessions = Array.from(this.sessions.values());
    return {
      active: sessions.length,
      total: sessions.length,
      byNode: this.groupSessionsByNode(sessions)
    };
  }

  private groupSessionsByNode(sessions: SessionInfo[]): Record<string, number> {
    return sessions.reduce((acc, session) => {
      acc[session.nodeId] = (acc[session.nodeId] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

// === 負荷分散アルゴリズム ===
class LoadBalancingAlgorithms {
  private roundRobinIndex = 0;
  private weightedRoundRobinState = new Map<string, number>();

  roundRobin(nodes: ServerNode[]): ServerNode | null {
    if (nodes.length === 0) return null;
    
    const node = nodes[this.roundRobinIndex % nodes.length];
    this.roundRobinIndex = (this.roundRobinIndex + 1) % nodes.length;
    
    return node;
  }

  weightedRoundRobin(nodes: ServerNode[]): ServerNode | null {
    if (nodes.length === 0) return null;

    // 重み付きラウンドロビン実装
    let selectedNode: ServerNode | null = null;
    let maxWeight = 0;

    for (const node of nodes) {
      const currentWeight = this.weightedRoundRobinState.get(node.id) || 0;
      const newWeight = currentWeight + node.weight;
      this.weightedRoundRobinState.set(node.id, newWeight);

      if (newWeight > maxWeight) {
        maxWeight = newWeight;
        selectedNode = node;
      }
    }

    if (selectedNode) {
      const totalWeight = nodes.reduce((sum, node) => sum + node.weight, 0);
      const currentWeight = this.weightedRoundRobinState.get(selectedNode.id)! - totalWeight;
      this.weightedRoundRobinState.set(selectedNode.id, currentWeight);
    }

    return selectedNode;
  }

  leastConnections(nodes: ServerNode[]): ServerNode | null {
    if (nodes.length === 0) return null;

    return nodes.reduce((least, current) => {
      return current.currentConnections < least.currentConnections ? current : least;
    });
  }

  leastResponseTime(nodes: ServerNode[]): ServerNode | null {
    if (nodes.length === 0) return null;

    return nodes.reduce((fastest, current) => {
      const fastestScore = fastest.responseTime * (fastest.currentConnections + 1);
      const currentScore = current.responseTime * (current.currentConnections + 1);
      return currentScore < fastestScore ? current : fastest;
    });
  }

  ipHash(nodes: ServerNode[], clientIp: string): ServerNode | null {
    if (nodes.length === 0) return null;

    const crypto = require('crypto');
    const hash = crypto.createHash('md5').update(clientIp).digest('hex');
    const index = parseInt(hash.substr(0, 8), 16) % nodes.length;
    
    return nodes[index];
  }

  geolocation(nodes: ServerNode[], clientRegion: string): ServerNode | null {
    if (nodes.length === 0) return null;

    // 同じリージョンのノードを優先
    const regionalNodes = nodes.filter(node => node.region === clientRegion);
    if (regionalNodes.length > 0) {
      return this.leastConnections(regionalNodes);
    }

    // フォールバック: 最小接続数
    return this.leastConnections(nodes);
  }
}

// === フェイルオーバーマネージャー ===
class FailoverManager extends EventEmitter {
  private config: LoadBalancerConfig['failover'];
  private logger: any;
  private retryTimeouts = new Map<string, NodeJS.Timeout>();

  constructor(config: LoadBalancerConfig['failover'], logger: any) {
    super();
    this.config = config;
    this.logger = logger;
  }

  handleNodeFailure(node: ServerNode, healthCheckManager: HealthCheckManager): void {
    if (!this.config.enabled) return;

    this.logger.warn(`Initiating failover for node: ${node.id}`);
    
    // リトライスケジュール
    if (this.config.autoFailback) {
      this.scheduleRetry(node, healthCheckManager);
    }

    this.emit('failoverInitiated', { nodeId: node.id, node });
  }

  private scheduleRetry(node: ServerNode, healthCheckManager: HealthCheckManager): void {
    const existingTimeout = this.retryTimeouts.get(node.id);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    const timeout = setTimeout(() => {
      this.logger.info(`Attempting automatic failback for node: ${node.id}`);
      healthCheckManager.forceHealthCheck(node.id);
      
      // 次のリトライをスケジュール
      if (node.status === 'unhealthy') {
        this.scheduleRetry(node, healthCheckManager);
      }
    }, this.config.failbackDelay);

    this.retryTimeouts.set(node.id, timeout);
  }

  handleNodeRecovery(node: ServerNode): void {
    if (!this.config.enabled) return;

    // リトライタイムアウトをクリア
    const timeout = this.retryTimeouts.get(node.id);
    if (timeout) {
      clearTimeout(timeout);
      this.retryTimeouts.delete(node.id);
    }

    this.logger.info(`Node recovered and back in service: ${node.id}`);
    this.emit('failbackCompleted', { nodeId: node.id, node });
  }

  stop(): void {
    for (const timeout of this.retryTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.retryTimeouts.clear();
  }
}

// === メイン負荷分散システム ===
export class EnhancedLoadBalancer extends EventEmitter {
  private config: LoadBalancerConfig;
  private logger: any;
  
  private nodes = new Map<string, ServerNode>();
  private healthCheckManager: HealthCheckManager;
  private sessionManager: SessionManager;
  private failoverManager: FailoverManager;
  private algorithms: LoadBalancingAlgorithms;
  
  private proxy: ServerProxy;
  private server?: Server;
  private stats: LoadBalancerStats;
  private startTime: number;

  constructor(config: LoadBalancerConfig, logger: any) {
    super();
    this.config = config;
    this.logger = logger;
    this.startTime = Date.now();

    // コンポーネント初期化
    this.healthCheckManager = new HealthCheckManager(config.healthCheck, logger);
    this.sessionManager = new SessionManager(config.session, logger);
    this.failoverManager = new FailoverManager(config.failover, logger);
    this.algorithms = new LoadBalancingAlgorithms();

    // プロキシサーバー作成
    this.proxy = createProxyServer({
      timeout: config.proxy.timeout,
      proxyTimeout: config.proxy.timeout,
      agent: config.proxy.keepAlive ? new require('http').Agent({ keepAlive: true }) : undefined
    });

    // 統計初期化
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
      nodes: { healthy: 0, unhealthy: 0, maintenance: 0, total: 0 },
      sessions: { active: 0, total: 0 },
      uptime: 0
    };

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // ヘルスチェックイベント
    this.healthCheckManager.on('nodeUnhealthy', (data) => {
      this.logger.warn(`Node became unhealthy: ${data.nodeId}`);
      this.failoverManager.handleNodeFailure(data.node, this.healthCheckManager);
      this.updateNodeStats();
    });

    this.healthCheckManager.on('nodeRecovered', (data) => {
      this.logger.info(`Node recovered: ${data.nodeId}`);
      this.failoverManager.handleNodeRecovery(data.node);
      this.updateNodeStats();
    });

    // プロキシイベント
    this.proxy.on('proxyReq', (proxyReq, req, res) => {
      this.stats.totalRequests++;
      const node = this.findNodeByRequest(req);
      if (node) {
        node.totalRequests++;
        node.currentConnections++;
      }
    });

    this.proxy.on('proxyRes', (proxyRes, req, res) => {
      if (proxyRes.statusCode && proxyRes.statusCode < 400) {
        this.stats.successfulRequests++;
        const node = this.findNodeByRequest(req);
        if (node) {
          node.successfulRequests++;
        }
      } else {
        this.stats.failedRequests++;
      }
    });

    this.proxy.on('close', (res, socket, head) => {
      const req = socket as any; // 型変換
      const node = this.findNodeByRequest(req);
      if (node) {
        node.currentConnections = Math.max(0, node.currentConnections - 1);
      }
    });

    this.proxy.on('error', (err, req, res) => {
      this.logger.error('Proxy error:', err);
      this.stats.failedRequests++;
      
      const node = this.findNodeByRequest(req);
      if (node) {
        node.errorCount++;
        node.currentConnections = Math.max(0, node.currentConnections - 1);
      }

      if (res && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad Gateway' }));
      }
    });
  }

  private findNodeByRequest(req: IncomingMessage): ServerNode | null {
    // リクエストから対応するノードを見つける（簡易実装）
    const target = (req as any).target;
    if (!target) return null;

    for (const node of this.nodes.values()) {
      if (target.includes(`${node.host}:${node.port}`)) {
        return node;
      }
    }
    return null;
  }

  addNode(nodeConfig: Partial<ServerNode> & { host: string; port: number }): void {
    const node: ServerNode = {
      id: nodeConfig.id || `node_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`,
      host: nodeConfig.host,
      port: nodeConfig.port,
      protocol: nodeConfig.protocol || 'http',
      weight: nodeConfig.weight || 1,
      maxConnections: nodeConfig.maxConnections || 1000,
      currentConnections: 0,
      status: 'healthy',
      region: nodeConfig.region || 'default',
      datacenter: nodeConfig.datacenter || 'default',
      lastHealthCheck: 0,
      responseTime: 0,
      errorCount: 0,
      totalRequests: 0,
      successfulRequests: 0,
      metadata: nodeConfig.metadata || {}
    };

    this.nodes.set(node.id, node);
    this.healthCheckManager.addNode(node);
    this.updateNodeStats();

    this.logger.info(`Added node: ${node.id} (${node.host}:${node.port})`);
    this.emit('nodeAdded', { nodeId: node.id, node });
  }

  removeNode(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      this.healthCheckManager.removeNode(nodeId);
      this.nodes.delete(nodeId);
      this.updateNodeStats();

      this.logger.info(`Removed node: ${nodeId}`);
      this.emit('nodeRemoved', { nodeId, node });
    }
  }

  private selectNode(req: IncomingMessage): ServerNode | null {
    // セッション管理チェック
    const sessionNodeId = this.sessionManager.getSessionNode(req);
    if (sessionNodeId) {
      const sessionNode = this.nodes.get(sessionNodeId);
      if (sessionNode && sessionNode.status === 'healthy') {
        return sessionNode;
      }
    }

    // 健康なノードのみ取得
    const healthyNodes = this.healthCheckManager.getHealthyNodes()
      .filter(node => node.currentConnections < node.maxConnections);

    if (healthyNodes.length === 0) {
      return null;
    }

    // アルゴリズムに基づいてノード選択
    const clientIp = this.getClientIP(req);
    const clientRegion = this.getClientRegion(req);

    switch (this.config.algorithm) {
      case 'round_robin':
        return this.algorithms.roundRobin(healthyNodes);
      
      case 'weighted_round_robin':
        return this.algorithms.weightedRoundRobin(healthyNodes);
      
      case 'least_connections':
        return this.algorithms.leastConnections(healthyNodes);
      
      case 'least_response_time':
        return this.algorithms.leastResponseTime(healthyNodes);
      
      case 'ip_hash':
        return this.algorithms.ipHash(healthyNodes, clientIp);
      
      case 'geolocation':
        return this.algorithms.geolocation(healthyNodes, clientRegion);
      
      default:
        return this.algorithms.roundRobin(healthyNodes);
    }
  }

  private getClientIP(req: IncomingMessage): string {
    return (req.headers['x-forwarded-for'] as string)?.split(',')[0] ||
           req.socket.remoteAddress ||
           '127.0.0.1';
  }

  private getClientRegion(req: IncomingMessage): string {
    return req.headers['x-client-region'] as string || 'default';
  }

  createRequestHandler() {
    return (req: IncomingMessage, res: ServerResponse) => {
      const selectedNode = this.selectNode(req);
      
      if (!selectedNode) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Service Unavailable' }));
        return;
      }

      // セッション作成
      const clientIp = this.getClientIP(req);
      const sessionId = this.sessionManager.createSession(clientIp, selectedNode.id, req);

      // セッションヘッダー設定
      if (sessionId && this.config.session.strategy === 'cookie') {
        res.setHeader('Set-Cookie', 
          `${this.config.session.cookieName}=${sessionId}; Path=/; HttpOnly`);
      }

      // プロキシ実行
      const target = `${selectedNode.protocol}://${selectedNode.host}:${selectedNode.port}`;
      (req as any).target = target; // ノード特定用

      this.proxy.web(req, res, { 
        target,
        changeOrigin: true,
        headers: {
          'X-Forwarded-For': clientIp,
          'X-Forwarded-Proto': req.headers['x-forwarded-proto'] || 'http',
          'X-Load-Balancer': 'otedama-enhanced'
        }
      });
    };
  }

  async start(port: number, host: string = '0.0.0.0'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer(this.createRequestHandler());
      
      this.server.on('error', (error: Error) => {
        this.logger.error('Load balancer server error:', error);
        reject(error);
      });

      this.server.listen(port, host, () => {
        this.logger.success(`Load balancer listening on ${host}:${port}`);
        this.startStatsCollection();
        resolve();
      });
    });
  }

  private startStatsCollection(): void {
    setInterval(() => {
      this.updateStats();
    }, 10000); // 10秒間隔
  }

  private updateStats(): void {
    this.updateNodeStats();
    this.stats.sessions = this.sessionManager.getSessionStats();
    this.stats.uptime = Date.now() - this.startTime;

    // 平均応答時間計算
    const healthyNodes = this.healthCheckManager.getHealthyNodes();
    if (healthyNodes.length > 0) {
      this.stats.averageResponseTime = healthyNodes.reduce((sum, node) => sum + node.responseTime, 0) / healthyNodes.length;
    }
  }

  private updateNodeStats(): void {
    const allNodes = this.healthCheckManager.getAllNodes();
    this.stats.nodes = {
      total: allNodes.length,
      healthy: allNodes.filter(n => n.status === 'healthy').length,
      unhealthy: allNodes.filter(n => n.status === 'unhealthy').length,
      maintenance: allNodes.filter(n => n.status === 'maintenance').length
    };
  }

  setNodeMaintenance(nodeId: string, maintenance: boolean): void {
    this.healthCheckManager.setNodeMaintenance(nodeId, maintenance);
    this.logger.info(`Node ${nodeId} ${maintenance ? 'entered' : 'exited'} maintenance mode`);
  }

  getStats(): LoadBalancerStats {
    this.updateStats();
    return { ...this.stats };
  }

  getNodes(): ServerNode[] {
    return this.healthCheckManager.getAllNodes();
  }

  getHealthyNodes(): ServerNode[] {
    return this.healthCheckManager.getHealthyNodes();
  }

  getUnhealthyNodes(): ServerNode[] {
    return this.healthCheckManager.getUnhealthyNodes();
  }

  getActiveSessions(): SessionInfo[] {
    return this.sessionManager.getActiveSessions();
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping load balancer...');
    
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.healthCheckManager.stop();
          this.sessionManager.stop();
          this.failoverManager.stop();
          this.proxy.close();
          
          this.logger.success('Load balancer stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

// === デフォルト設定 ===
export const DefaultLoadBalancerConfig: LoadBalancerConfig = {
  algorithm: 'least_connections',
  healthCheck: {
    enabled: true,
    interval: 30000, // 30秒
    timeout: 5000,   // 5秒
    retries: 3,
    path: '/health',
    expectedStatus: [200, 201, 202],
    failureThreshold: 3,
    successThreshold: 2
  },
  failover: {
    enabled: true,
    autoFailback: true,
    failbackDelay: 60000, // 1分
    maxRetries: 5,
    retryInterval: 30000  // 30秒
  },
  session: {
    enabled: true,
    strategy: 'ip_hash',
    timeout: 30 * 60 * 1000 // 30分
  },
  proxy: {
    timeout: 30000, // 30秒
    keepAlive: true,
    retries: 3,
    bufferSize: 64 * 1024 // 64KB
  }
};

export { LoadBalancerConfig, ServerNode, SessionInfo, LoadBalancerStats, HealthCheckResult };
