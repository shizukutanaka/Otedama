import { EventEmitter } from 'events';
import net from 'net';
import { Logger } from './logger.js';
import { SecurityManager } from './security-manager.js';

/**
 * @class StratumServer
 * @description Handles Stratum protocol connections from mining clients.
 */
export class StratumServer extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.logger = new Logger('Stratum');
    this.security = new SecurityManager();
    this.clients = new Map();
    this.bannedIPs = new Set();
    this.server = null;
  }

  start() {
    this.server = net.createServer(socket => this.handleConnection(socket));
    this.server.on('error', err => {
      this.logger.error(`Server error: ${err.message}`);
    });
    this.server.listen(this.config.port, this.config.host, () => {
      this.logger.info(`Stratum server listening on ${this.config.host}:${this.config.port}`);
    });
  }

  handleConnection(socket) {
    const ip = socket.remoteAddress;
    if (this.security.isBanned(ip)) {
      this.logger.warn(`Rejected connection from banned IP: ${ip}`);
      socket.destroy();
      return;
    }

    if (!this.security.addConnection(ip)) {
      this.logger.warn(`Rate limit exceeded for IP: ${ip}`);
      socket.destroy();
      return;
    }

    const clientId = `${ip}:${socket.remotePort}`;
    this.clients.set(clientId, { socket, lastSeen: Date.now() });
    this.logger.info(`Client connected: ${clientId}`);

    socket.on('data', data => this.handleData(clientId, data));
    socket.on('close', () => this.handleDisconnect(clientId));
    socket.on('error', err => this.logger.debug(`Socket error for ${clientId}: ${err.message}`));
  }

  handleData(clientId, data) {
    const client = this.clients.get(clientId);
    if (!client) return;

    client.lastSeen = Date.now();
    const messages = data.toString().split('\n');
    for (const message of messages) {
      if (!message) continue;
      try {
        const request = JSON.parse(message);
        this.handleStratumRequest(clientId, request);
      } catch (e) {
        this.logger.debug(`Invalid JSON from ${clientId}: ${message}`);
      }
    }
  }

  handleStratumRequest(clientId, request) {
    switch (request.method) {
      case 'mining.subscribe':
        this.handleSubscribe(clientId, request);
        break;
      case 'mining.authorize':
        this.handleAuthorize(clientId, request);
        break;
      case 'mining.submit':
        this.handleSubmit(clientId, request);
        break;
      default:
        this.sendError(clientId, request.id, 20, 'Not supported');
    }
  }

  handleSubscribe(clientId, request) {
    const client = this.clients.get(clientId);
    client.subscriptionId = 'sub1';
    this.send(clientId, {
      id: request.id,
      result: [client.subscriptionId, '0x' + '0'.repeat(64)],
      error: null
    });
  }

  handleAuthorize(clientId, request) {
    const [workerName, password] = request.params;
    const client = this.clients.get(clientId);
    client.workerName = workerName;
    client.authorized = true;
    this.logger.info(`Worker authorized: ${workerName}`);
    this.send(clientId, { id: request.id, result: true, error: null });
    this.sendJob(clientId);
  }

  handleSubmit(clientId, request) {
    const client = this.clients.get(clientId);
    if (!client || !client.authorized) {
      this.sendError(clientId, request.id, 24, 'Unauthorized');
      return;
    }
    const [workerName, jobId, nonce, hash] = request.params;
    this.emit('share', { workerName, jobId, nonce, hash, clientId });
    this.send(clientId, { id: request.id, result: true, error: null });
  }

  sendJob(clientId, job) {
    const client = this.clients.get(clientId);
    if (!client || !client.authorized) return;

    const newJob = job || this.createJob();
    client.currentJob = newJob.jobId;
    this.send(clientId, {
      id: null,
      method: 'mining.notify',
      params: [newJob.jobId, newJob.prevHash, newJob.coinb1, newJob.coinb2, newJob.merkleBranches, newJob.version, newJob.nbits, newJob.ntime, true]
    });
  }

  broadcastJob(job) {
    this.logger.info('Broadcasting new job to all clients');
    for (const clientId of this.clients.keys()) {
      this.sendJob(clientId, job);
    }
  }

  createJob() {
    // Placeholder for actual job creation logic
    return {
      jobId: 'j' + Math.random().toString(36).substr(2, 9),
      prevHash: '0'.repeat(64),
      coinb1: '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff',
      coinb2: '0000000000000000000000000000000000000000000000000000000000000000',
      merkleBranches: [],
      version: '20000000',
      nbits: '1d00ffff',
      ntime: Math.floor(Date.now() / 1000).toString(16),
    };
  }

  send(clientId, data) {
    const client = this.clients.get(clientId);
    if (client && client.socket.writable) {
      client.socket.write(JSON.stringify(data) + '\n');
    }
  }

  sendError(clientId, id, code, message) {
    this.send(clientId, { id, result: null, error: [code, message, null] });
  }

  handleDisconnect(clientId) {
    if (this.clients.has(clientId)) {
      const client = this.clients.get(clientId);
      this.security.removeConnection(client.socket.remoteAddress);
      this.clients.delete(clientId);
      this.logger.info(`Client disconnected: ${clientId}`);
    }
  }

  stop() {
    return new Promise(resolve => {
      this.server.close(() => {
        this.logger.info('Stratum server stopped');
        resolve();
      });
      for (const client of this.clients.values()) {
        client.socket.destroy();
      }
      this.clients.clear();
    });
  }
}
