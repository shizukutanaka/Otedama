// Simple Stratum handler with channels (Pike style)
import * as net from 'net';
import { Channel } from './channels';
import { Share } from '../domain/share';
import { Miner, MinerRegistry } from '../domain/miner';
import { DDoSProtection, ShareThrottler, SynFloodProtection } from '../security/ddos';
import { AuthSystem } from '../security/auth';
import { Database } from '../database/database';
import { DDoSProtectionConfig, ShareThrottlerConfig, SynFloodConfig } from '../config/security';
import { 
  ProtocolNegotiator, 
  ProtocolFeature, 
  MessageVersioning,
  CURRENT_VERSION_STRING
} from '../protocol/versioning';
import { createOptimizedServer, optimizeSocket } from '../performance/network-optimization';

interface StratumMessage {
  id: number;
  method?: string;
  params?: any[];
  result?: any;
  error?: any;
}

export class StratumHandler {
  private connections = new Map<string, MinerConnection>();
  private shareChannel: Channel<Share>;
  private ddosProtection: DDoSProtection;
  private shareThrottler: ShareThrottler;
  private authSystem: AuthSystem | null = null;
  private minerRegistry: MinerRegistry;
  private protocolNegotiator: ProtocolNegotiator;
  
  constructor(
    shareChannel: Channel<Share>,
    securityConfig?: {
      ddosProtection: DDoSProtectionConfig;
      shareThrottler: ShareThrottlerConfig;
    }
  ) {
    this.shareChannel = shareChannel;
    
    // Use provided security config or default values
    this.ddosProtection = new DDoSProtection(
      securityConfig?.ddosProtection || {
        maxConnectionsPerIP: 10,
        maxTotalConnections: 10000,
        maxRequestsPerMinute: 1200,
        maxRequestBurst: 100,
        blockDuration: 3600000,
        autoBlockThreshold: 5,
        ipReputationEnabled: false,
        geographicFilteringEnabled: false,
        whitelistedIPs: ['127.0.0.1']
      }
    );
    
    this.shareThrottler = new ShareThrottler(
      securityConfig?.shareThrottler || {
        maxSharesPerSecond: 100,
        burstSize: 200,
        penaltyDuration: 300000
      }
    );
    
    // Initialize with a dummy AuthSystem that will be replaced once DB is available
    this.authSystem = null;
    
    // Get database instance asynchronously and then initialize AuthSystem
    Database.getInstance().then(db => {
      this.authSystem = new AuthSystem(db);
      console.log('AuthSystem initialized successfully');
    }).catch(err => {
      console.error('Failed to initialize AuthSystem:', err);
    });
    
    this.minerRegistry = new MinerRegistry();
    this.protocolNegotiator = new ProtocolNegotiator();
  }
  
  async handleConnection(socket: net.Socket): Promise<void> {
    const ip = socket.remoteAddress || '';
    
    // DDoS protection check
    if (!this.ddosProtection.canConnect(socket)) {
      socket.destroy();
      return;
    }
    
    // Track connection
    this.ddosProtection.addConnection(socket);
    
    const miner = new MinerConnection(socket);
    this.connections.set(miner.id, miner);
    
    socket.on('data', (data) => {
      // Rate limit check
      if (!this.ddosProtection.checkRateLimit(ip)) {
        socket.destroy();
        return;
      }
      
      const messages = this.parseMessages(data);
      for (const message of messages) {
        this.handleMessage(miner, message);
      }
    });
    
    socket.on('close', () => {
      this.connections.delete(miner.id);
      if (miner.minerId) {
        this.minerRegistry.remove(miner.minerId);
      }
      // Clean up protocol negotiation
      this.protocolNegotiator.removeClient(miner.id);
    });
    
    socket.on('error', (error) => {
      console.error(`Socket error for ${miner.id}:`, error);
      this.connections.delete(miner.id);
    });
  }
  
  private parseMessages(data: Buffer): StratumMessage[] {
    const messages: StratumMessage[] = [];
    const lines = data.toString().split('\n');
    
    for (const line of lines) {
      if (line.trim()) {
        try {
          messages.push(JSON.parse(line));
        } catch (error) {
          console.error('Failed to parse message:', line);
        }
      }
    }
    
    return messages;
  }
  
  private async handleMessage(miner: MinerConnection, message: StratumMessage): Promise<void> {
    // Simple switch for minimal methods only
    switch (message.method) {
      case 'mining.subscribe':
        await this.handleSubscribe(miner, message);
        break;
        
      case 'mining.authorize':
        await this.handleAuthorize(miner, message);
        break;
        
      case 'mining.submit':
        await this.handleSubmit(miner, message);
        break;
        
      default:
        // Unknown method
        miner.sendError(message.id || 0, 'Unknown method');
    }
  }
  
  private async handleSubscribe(miner: MinerConnection, message: StratumMessage): Promise<void> {
    // Handle version negotiation
    const params = message.params || [];
    const userAgent = params[0] || 'unknown/1.0.0';
    const version = params[1] || '1.0.0';
    const supportedFeatures = params[2] || [];
    
    // Negotiate protocol version
    const negotiation = this.protocolNegotiator.negotiate(
      miner.id,
      version,
      supportedFeatures
    );
    
    if (!negotiation.success) {
      miner.sendError(message.id || 0, negotiation.error || 'Protocol version not supported');
      return;
    }
    
    // Store negotiated version
    miner.protocolVersion = negotiation.version;
    miner.supportedFeatures = negotiation.features;
    
    // Simple subscription
    const subscriptionId = Math.random().toString(36).substr(2, 9);
    const extraNonce1 = Math.floor(Math.random() * 0xFFFFFFFF).toString(16);
    const extraNonce2Size = 4;
    
    miner.subscriptionId = subscriptionId;
    miner.extraNonce1 = extraNonce1;
    
    // Include server version and supported features in response
    const response = [
      [['mining.notify', subscriptionId]],
      extraNonce1,
      extraNonce2Size
    ];
    
    // Add version info if client supports it
    if (negotiation.features?.has(ProtocolFeature.HASHRATE_REPORTING)) {
      response.push({
        version: CURRENT_VERSION_STRING,
        features: Array.from(negotiation.features)
      } as any);
    }
    
    miner.sendResult(message.id || 0, response);
  }
  
  private async handleAuthorize(miner: MinerConnection, message: StratumMessage): Promise<void> {
    const [usernameParam, passwordParam] = message.params || [];
    
    // Simple auth check (can be expanded later)
    if (!usernameParam) {
      miner.sendError(message.id || 0, 'Username required');
      return;
    }
    
    // Check if auth system is initialized
    if (!this.authSystem) {
      miner.sendError(message.id || 0, 'Authentication system not available');
      return;
    }
    
    // Authenticate with auth system
    try {
      const authResult = await this.authSystem.authenticate({
        username: usernameParam,
        password: passwordParam || usernameParam, // Use username as password if not provided
        workerName: miner.workerName
      });
      
      if (authResult.success && authResult.minerId) {
        const minerId = authResult.minerId;
        const username = usernameParam;
        
        // Set miner properties
        miner.minerId = minerId;
        miner.username = username;
        miner.authorized = true;
        
        // Register miner
        const minerEntity = new Miner(minerId, username, miner.workerName);
        this.minerRegistry.register(minerEntity);
        
        miner.sendResult(message.id || 0, true);
        
        // Send initial job
        this.sendJob(miner);
      } else {
        miner.sendResult(message.id || 0, false);
        miner.sendError(message.id || 0, authResult.message || 'Authentication failed');
      }
    } catch (error) {
      console.error('Authentication error:', error);
      miner.sendError(message.id || 0, 'Authentication failed');
    }
  }
  
  private async handleSubmit(miner: MinerConnection, message: StratumMessage): Promise<void> {
    const [username, jobId, extraNonce2, nTime, nonce] = message.params || [];
    
    if (!miner.authorized || !miner.minerId) {
      miner.sendError(message.id || 0, 'Not authorized');
      return;
    }
    
    // Check share throttling
    if (!this.shareThrottler.canSubmitShare(miner.minerId)) {
      miner.sendError(message.id || 0, 'Share submission rate exceeded');
      return;
    }
    
    // Create share
    const share = new Share();
    share.minerId = miner.minerId;
    share.jobId = jobId;
    share.nonce = parseInt(nonce, 16);
    share.data = Buffer.from(extraNonce2 + nTime + nonce, 'hex');
    share.difficulty = miner.difficulty;
    
    // Submit to channel
    await this.shareChannel.send(share);
    
    // Simple response
    miner.sendResult(message.id || 0, true);
  }
  
  private sendJob(miner: MinerConnection): void {
    // Simplified job - real implementation would get from blockchain
    const job = {
      jobId: Math.random().toString(36).substr(2, 9),
      prevHash: '0000000000000000000000000000000000000000000000000000000000000000',
      coinbase1: '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff',
      coinbase2: 'ffffffff',
      merkleBranch: [],
      version: '20000000',
      nBits: '1a00ffff',
      nTime: Math.floor(Date.now() / 1000).toString(16),
      cleanJobs: true
    };
    
    miner.sendNotification('mining.notify', [
      job.jobId,
      job.prevHash,
      job.coinbase1,
      job.coinbase2,
      job.merkleBranch,
      job.version,
      job.nBits,
      job.nTime,
      job.cleanJobs
    ]);
  }
  
  broadcast(method: string, params: any[]): void {
    for (const miner of this.connections.values()) {
      if (miner.authorized) {
        // Use version-appropriate message format
        if (miner.protocolVersion) {
          const message = MessageVersioning.formatMessage(
            miner.protocolVersion,
            method,
            params
          );
          miner.sendRaw(message);
        } else {
          miner.sendNotification(method, params);
        }
      }
    }
  }
  
  // Get connection statistics
  getStats() {
    return {
      connections: this.connections.size,
      authorized: Array.from(this.connections.values()).filter(c => c.authorized).length,
      ddosStats: this.ddosProtection.getStats(),
      protocolStats: this.protocolNegotiator.getStatistics()
    };
  }
  
  // Shutdown
  shutdown(): void {
    this.ddosProtection.shutdown();
    for (const [id, connection] of this.connections) {
      connection.socket.destroy();
    }
    this.connections.clear();
  }
}

class MinerConnection {
  public id: string;
  public subscriptionId?: string;
  public extraNonce1?: string;
  public username?: string;
  public minerId?: string;
  public workerName: string = 'default';
  public authorized = false;
  public difficulty = 1;
  public protocolVersion?: any;
  public supportedFeatures?: Set<string>;
  
  constructor(public socket: net.Socket) {
    this.id = `${socket.remoteAddress}:${socket.remotePort}`;
  }
  
  sendResult(id: number, result: any): void {
    // Use the id parameter explicitly to avoid unused variable warning
    const messageId = id;
    this.send({
      id: messageId,
      result,
      error: null
    });
  }
  
  sendError(id: number, error: string): void {
    this.send({ id, error: [20, error, null] });
  }
  
  sendNotification(method: string, params: any[]): void {
    this.send({ id: null, method, params });
  }
  
  private send(message: any): void {
    try {
      this.socket.write(JSON.stringify(message) + '\n');
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  }
  
  sendRaw(message: any): void {
    this.send(message);
  }
}

// Simple Stratum server
export class StratumServer {
  private server: net.Server;
  private handler: StratumHandler;
  // SYN flood protection instance for TCP connection protection
  private synFloodProtection?: SynFloodProtection;
  
  constructor(
    shareChannel: Channel<Share>,
    securityConfig?: {
      ddosProtection: DDoSProtectionConfig;
      shareThrottler: ShareThrottlerConfig;
      synFlood: SynFloodConfig;
    }
  ) {
    this.handler = new StratumHandler(shareChannel, securityConfig);
    
    // Create optimized TCP server
    this.server = createOptimizedServer({
      sendBufferSize: 128 * 1024,     // 128KB for mining data
      receiveBufferSize: 64 * 1024,   // 64KB for share submissions
      noDelay: true,                  // Low latency for shares
      keepAlive: true,
      keepAliveInitialDelay: 30000,
      timeout: 300000,                // 5 minutes
      backlog: 1000                   // Support many miners
    });
    
    // Initialize SYN flood protection if config provided
    if (securityConfig?.synFlood) {
      this.synFloodProtection = new SynFloodProtection(securityConfig.synFlood);
    }
  }
  
  async listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // Apply SYN flood protection if available
      if (this.synFloodProtection) {
        console.log('SYN flood protection enabled');
        this.server.on('connection', (socket) => {
          const ip = socket.remoteAddress || '';
          if (this.synFloodProtection?.checkSyn(ip)) {
            this.handler.handleConnection(socket).catch(err => {
              console.error('Connection error:', err);
            });
            // Mark SYN as completed when connection is established
            this.synFloodProtection.completeSyn(ip);
          } else {
            console.warn(`SYN flood protection blocked connection from ${ip}`);
            socket.destroy();
          }
        });
      } else {
        this.server.on('connection', (socket) => {
          this.handler.handleConnection(socket).catch(err => {
            console.error('Connection error:', err);
          });
        });
      }
      
      this.server.listen(port, () => {
        console.log(`Stratum server listening on port ${port}`);
        resolve();
      }).on('error', (err) => {
        reject(err);
      });
    });
  }
  
  getStats() {
    return this.handler.getStats();
  }
  
  // Notify all miners of new block
  notifyNewBlock(block: any): void {
    // Create new job based on the new block
    const job = {
      jobId: Math.random().toString(36).substr(2, 9),
      prevHash: block.hash,
      coinbase1: '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff',
      coinbase2: 'ffffffff',
      merkleBranch: [],
      version: block.version.toString(16).padStart(8, '0'),
      nBits: block.bits,
      nTime: Math.floor(Date.now() / 1000).toString(16),
      cleanJobs: true // Clean jobs since it's a new block
    };
    
    // Broadcast to all connected miners
    this.handler.broadcast('mining.notify', [
      job.jobId,
      job.prevHash,
      job.coinbase1,
      job.coinbase2,
      job.merkleBranch,
      job.version,
      job.nBits,
      job.nTime,
      job.cleanJobs
    ]);
  }
  
  close(): void {
    this.handler.shutdown();
    this.server.close();
  }
}
