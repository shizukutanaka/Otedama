/**
 * Lightweight Stratum Server
 * 
 * Pike's Simplicity: Direct TCP handling, minimal abstraction
 * Carmack's Performance: Connection pooling, fast message parsing
 * Uncle Bob's Clean: Single responsibility, testable components
 */

import { createServer, Server, Socket } from 'net';
import { EventEmitter } from 'events';
import { Share, Job, createShare } from './entities';
import { ShareValidator } from './validator';

export interface StratumConfig {
  port: number;
  maxConnections: number;
  difficulty: number;
  timeout: number;
}

export interface StratumMessage {
  id: number | string | null;
  method: string;
  params: any[];
  result?: any;
  error?: any;
}

export interface MinerConnection {
  id: string;
  socket: Socket;
  subscribed: boolean;
  difficulty: number;
  lastActivity: number;
  address?: string;
  worker?: string;
}

/**
 * Pike's approach: Simple message parser without complex abstractions
 */
export class StratumMessageParser {
  static parse(data: string): StratumMessage | null {
    try {
      const message = JSON.parse(data);
      
      // Validate basic structure
      if (typeof message !== 'object' || message === null) {
        return null;
      }

      // Method call format
      if (message.method) {
        return {
          id: message.id || null,
          method: message.method,
          params: message.params || []
        };
      }

      // Response format
      if (message.result !== undefined || message.error !== undefined) {
        return {
          id: message.id || null,
          method: '',
          params: [],
          result: message.result,
          error: message.error
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  static stringify(message: StratumMessage): string {
    const json: any = { id: message.id };
    
    if (message.method) {
      json.method = message.method;
      json.params = message.params;
    }
    
    if (message.result !== undefined) {
      json.result = message.result;
    }
    
    if (message.error !== undefined) {
      json.error = message.error;
    }

    return JSON.stringify(json) + '\n';
  }
}

/**
 * Carmack's performance: Fast connection management
 */
class LegacyStratumServer extends EventEmitter {
  private server: Server;
  private connections = new Map<string, MinerConnection>();
  private currentJob: Job | null = null;
  private validator: ShareValidator;
  private connectionCounter = 0;

  constructor(
    private config: StratumConfig,
    validator?: ShareValidator
  ) {
    super();
    this.server = createServer();
    this.validator = validator || new ShareValidator();
    this.setupServer();
  }

  private setupServer(): void {
    this.server.on('connection', (socket: Socket) => {
      this.handleConnection(socket);
    });

    this.server.on('error', (error: Error) => {
      this.emit('error', error);
    });
  }

  /**
   * Pike's simplicity: Direct connection handling
   */
  private handleConnection(socket: Socket): void {
    // Check connection limit
    if (this.connections.size >= this.config.maxConnections) {
      socket.destroy();
      return;
    }

    const connectionId = `miner_${++this.connectionCounter}`;
    const connection: MinerConnection = {
      id: connectionId,
      socket,
      subscribed: false,
      difficulty: this.config.difficulty,
      lastActivity: Date.now()
    };

    this.connections.set(connectionId, connection);
    this.emit('connection', connection);

    // Set timeout
    socket.setTimeout(this.config.timeout);

    // Handle data
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data.toString();
      
      // Process complete messages (separated by \n)
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          this.handleMessage(connection, line.trim());
        }
      }
    });

    // Handle disconnect
    socket.on('close', () => {
      this.connections.delete(connectionId);
      this.emit('disconnect', connection);
    });

    socket.on('error', (error) => {
      this.emit('connectionError', { connection, error });
      this.connections.delete(connectionId);
    });

    socket.on('timeout', () => {
      socket.destroy();
    });
  }

  /**
   * Carmack's approach: Direct message handling for performance
   */
  private handleMessage(connection: MinerConnection, messageData: string): void {
    connection.lastActivity = Date.now();
    
    const message = StratumMessageParser.parse(messageData);
    if (!message) {
      this.sendError(connection, null, 'Invalid message format');
      return;
    }

    switch (message.method) {
      case 'mining.subscribe':
        this.handleSubscribe(connection, message);
        break;
        
      case 'mining.authorize':
        this.handleAuthorize(connection, message);
        break;
        
      case 'mining.submit':
        this.handleSubmit(connection, message);
        break;
        
      case 'mining.suggest_difficulty':
        this.handleSuggestDifficulty(connection, message);
        break;
        
      default:
        this.sendError(connection, message.id, 'Unknown method');
    }
  }

  private handleSubscribe(connection: MinerConnection, message: StratumMessage): void {
    const subscriptionId = '01000000'; // Simple subscription ID
    const extranonce1 = connection.id.slice(-8).padStart(8, '0'); // Use connection ID as extranonce1
    const extranonce2Size = 4;

    connection.subscribed = true;

    this.sendResult(connection, message.id, [
      subscriptionId,
      extranonce1,
      extranonce2Size
    ]);

    // Send current difficulty
    this.sendDifficulty(connection, connection.difficulty);

    // Send current job if available
    if (this.currentJob) {
      this.sendJob(connection, this.currentJob);
    }
  }

  private handleAuthorize(connection: MinerConnection, message: StratumMessage): void {
    const [username, password] = message.params;
    
    // Parse username (usually address.worker)
    const parts = username.split('.');
    connection.address = parts[0];
    connection.worker = parts[1] || 'default';

    this.sendResult(connection, message.id, true);
    this.emit('minerAuthorized', connection);
  }

  private handleSubmit(connection: MinerConnection, message: StratumMessage): void {
    if (!connection.address || !this.currentJob) {
      this.sendError(connection, message.id, 'Not authorized or no job');
      return;
    }

    const [worker, jobId, extranonce2, ntime, nonce] = message.params;
    
    // Validate job ID
    if (jobId !== this.currentJob.id) {
      this.sendError(connection, message.id, 'Stale job');
      return;
    }

    // Create share object
    const share = createShare(
      connection.id,
      jobId,
      parseInt(nonce, 16),
      connection.difficulty,
      '' // Hash will be calculated in validator
    );

    // Validate share
    const validation = this.validator.validateShare(share, this.currentJob);
    
    if (validation.isValid) {
      this.sendResult(connection, message.id, true);
      
      // Update share with actual difficulty
      const validShare: Share = {
        ...share,
        isValid: true,
        difficulty: validation.difficulty
      };

      this.emit('shareAccepted', { connection, share: validShare });
      
      // Check if it's a block
      if (this.validator.isBlockCandidate(validShare)) {
        this.emit('blockFound', { connection, share: validShare });
      }
    } else {
      this.sendError(connection, message.id, validation.error || 'Invalid share');
      this.emit('shareRejected', { connection, share, error: validation.error });
    }
  }

  private handleSuggestDifficulty(connection: MinerConnection, message: StratumMessage): void {
    const [difficulty] = message.params;
    
    if (typeof difficulty === 'number' && difficulty > 0) {
      connection.difficulty = Math.max(1, Math.min(difficulty, 1000000));
      this.sendDifficulty(connection, connection.difficulty);
    }
  }

  /**
   * Pike's simplicity: Direct message sending
   */
  private sendResult(connection: MinerConnection, id: any, result: any): void {
    const message: StratumMessage = { id, method: '', params: [], result };
    this.sendMessage(connection, message);
  }

  private sendError(connection: MinerConnection, id: any, error: string): void {
    const message: StratumMessage = { 
      id, 
      method: '', 
      params: [], 
      error: [21, error, null] 
    };
    this.sendMessage(connection, message);
  }

  private sendDifficulty(connection: MinerConnection, difficulty: number): void {
    const message: StratumMessage = {
      id: null,
      method: 'mining.set_difficulty',
      params: [difficulty]
    };
    this.sendMessage(connection, message);
  }

  private sendJob(connection: MinerConnection, job: Job): void {
    const message: StratumMessage = {
      id: null,
      method: 'mining.notify',
      params: [
        job.id,
        job.previousBlockHash,
        job.coinbaseHash,
        job.merkleRoot,
        job.timestamp.toString(16),
        job.difficulty.toString(16),
        true // Clean jobs
      ]
    };
    this.sendMessage(connection, message);
  }

  private sendMessage(connection: MinerConnection, message: StratumMessage): void {
    try {
      const data = StratumMessageParser.stringify(message);
      connection.socket.write(data);
    } catch (error) {
      this.emit('sendError', { connection, error });
    }
  }

  /**
   * Public interface
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.config.port, (error?: Error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async stop(): Promise<void> {
    // Close all connections
    for (const connection of this.connections.values()) {
      connection.socket.destroy();
    }
    this.connections.clear();

    // Close server
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  /**
   * Job management
   */
  setJob(job: Job): void {
    this.currentJob = job;
    
    // Broadcast to all subscribed miners
    for (const connection of this.connections.values()) {
      if (connection.subscribed) {
        this.sendJob(connection, job);
      }
    }
  }

  getCurrentJob(): Job | null {
    return this.currentJob;
  }

  /**
   * Connection management
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  getConnections(): MinerConnection[] {
    return Array.from(this.connections.values());
  }

  disconnectMiner(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.socket.destroy();
    }
  }

  /**
   * Statistics
   */
  getStats(): {
    connections: number;
    subscribedMiners: number;
    currentJob: string | null;
    totalHashrate: number;
  } {
    const subscribedMiners = Array.from(this.connections.values())
      .filter(c => c.subscribed).length;

    return {
      connections: this.connections.size,
      subscribedMiners,
      currentJob: this.currentJob?.id || null,
      totalHashrate: 0 // Calculate from difficulty and share rate
    };
  }
}

// DEPRECATED: This file now acts as a thin compatibility shim.
// The canonical Stratum implementation lives in ../../network/stratum.ts.
// New code should import from "../network/stratum".
export * from '../network/stratum';
export { StratumServer } from '../network/stratum';