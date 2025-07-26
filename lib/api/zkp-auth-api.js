/**
 * Zero-Knowledge Proof Authentication API - Otedama
 * Privacy-preserving authentication without KYC
 * 
 * Design Principles:
 * - Carmack: Fast cryptographic operations
 * - Martin: Clean API design
 * - Pike: Simple authentication flow
 */

import express from 'express';
import { zkAuth, SchnorrZKP } from '../zkp/zero-knowledge-auth.js';
import { createStructuredLogger } from '../core/structured-logger.js';
import { metrics } from '../monitoring/realtime-metrics.js';
import { RateLimiter } from 'rate-limiter-flexible';

const logger = createStructuredLogger('ZKPAuthAPI');

/**
 * ZKP Authentication middleware
 */
export function zkpAuthMiddleware(req, res, next) {
  const sessionId = req.headers['x-session-id'];
  
  if (!sessionId) {
    return res.status(401).json({
      error: 'No session ID provided'
    });
  }
  
  if (!zkAuth.verifySession(sessionId)) {
    return res.status(401).json({
      error: 'Invalid or expired session'
    });
  }
  
  req.sessionId = sessionId;
  next();
}

/**
 * Create ZKP authentication routes
 */
export function createZKPAuthRoutes() {
  const router = express.Router();
  const zkp = new SchnorrZKP();
  
  // Rate limiting
  const rateLimiter = new RateLimiter({
    points: 10, // 10 requests
    duration: 60, // per minute
    blockDuration: 60 * 5 // block for 5 minutes
  });
  
  /**
   * Generate new identity (public/private key pair)
   * GET /api/zkp/identity/generate
   */
  router.get('/identity/generate', async (req, res) => {
    try {
      const timer = metrics.timer('api.zkp.identity.generate');
      
      const identity = await zkp.generateIdentity();
      
      timer.end();
      
      res.json({
        success: true,
        identity: {
          publicKey: identity.publicKey,
          // Private key is only shown once, user must save it
          privateKey: identity.privateKey,
          warning: 'Save your private key securely. It cannot be recovered.'
        }
      });
      
    } catch (error) {
      logger.error('Failed to generate identity', { error: error.message });
      res.status(500).json({
        error: 'Failed to generate identity'
      });
    }
  });
  
  /**
   * Register miner with ZKP
   * POST /api/zkp/register
   */
  router.post('/register', async (req, res) => {
    try {
      await rateLimiter.consume(req.ip);
      
      const { publicKey, proof } = req.body;
      
      if (!publicKey || !proof) {
        return res.status(400).json({
          error: 'Missing publicKey or proof'
        });
      }
      
      const timer = metrics.timer('api.zkp.register');
      
      // Verify the proof
      const isValid = zkp.verifyProof(publicKey, proof);
      
      if (!isValid) {
        timer.end();
        return res.status(400).json({
          error: 'Invalid zero-knowledge proof'
        });
      }
      
      // Register the miner
      const result = await zkAuth.registerMiner(publicKey);
      
      timer.end();
      metrics.counter('zkp.registrations', 1);
      
      res.json({
        success: true,
        credential: result.credential,
        message: 'Miner registered successfully'
      });
      
    } catch (error) {
      if (error.remainingPoints !== undefined) {
        res.status(429).json({
          error: 'Too many requests'
        });
      } else {
        logger.error('Registration failed', { error: error.message });
        res.status(500).json({
          error: 'Registration failed'
        });
      }
    }
  });
  
  /**
   * Get authentication challenge
   * POST /api/zkp/challenge
   */
  router.post('/challenge', async (req, res) => {
    try {
      await rateLimiter.consume(req.ip);
      
      const { publicKey } = req.body;
      
      if (!publicKey) {
        return res.status(400).json({
          error: 'Missing publicKey'
        });
      }
      
      const challenge = await zkAuth.generateChallenge(publicKey);
      
      res.json({
        success: true,
        challenge: challenge.nonce,
        expiresIn: 300 // 5 minutes
      });
      
    } catch (error) {
      if (error.remainingPoints !== undefined) {
        res.status(429).json({
          error: 'Too many requests'
        });
      } else {
        res.status(500).json({
          error: 'Failed to generate challenge'
        });
      }
    }
  });
  
  /**
   * Authenticate with ZKP
   * POST /api/zkp/authenticate
   */
  router.post('/authenticate', async (req, res) => {
    try {
      await rateLimiter.consume(req.ip);
      
      const { credential, proof } = req.body;
      
      if (!credential || !proof) {
        return res.status(400).json({
          error: 'Missing credential or proof'
        });
      }
      
      const timer = metrics.timer('api.zkp.authenticate');
      
      const result = await zkAuth.authenticateMiner(credential, proof);
      
      timer.end();
      
      if (result.success) {
        metrics.counter('zkp.auth.success', 1);
        
        res.json({
          success: true,
          sessionId: result.sessionId,
          expiresIn: result.expiresIn
        });
      } else {
        metrics.counter('zkp.auth.failed', 1);
        
        res.status(401).json({
          error: result.error || 'Authentication failed'
        });
      }
      
    } catch (error) {
      if (error.remainingPoints !== undefined) {
        res.status(429).json({
          error: 'Too many requests'
        });
      } else {
        logger.error('Authentication error', { error: error.message });
        res.status(500).json({
          error: 'Authentication failed'
        });
      }
    }
  });
  
  /**
   * Create proof for authentication
   * POST /api/zkp/proof/create
   */
  router.post('/proof/create', async (req, res) => {
    try {
      const { privateKey, challenge } = req.body;
      
      if (!privateKey || !challenge) {
        return res.status(400).json({
          error: 'Missing privateKey or challenge'
        });
      }
      
      const timer = metrics.timer('api.zkp.proof.create');
      
      // This should be done client-side in production
      // Server-side implementation for demonstration
      const proof = await zkp.createProof(privateKey, challenge);
      
      timer.end();
      
      res.json({
        success: true,
        proof,
        warning: 'In production, generate proofs client-side'
      });
      
    } catch (error) {
      logger.error('Proof creation failed', { error: error.message });
      res.status(500).json({
        error: 'Failed to create proof'
      });
    }
  });
  
  /**
   * Verify session
   * GET /api/zkp/session/verify
   */
  router.get('/session/verify', zkpAuthMiddleware, (req, res) => {
    res.json({
      success: true,
      sessionId: req.sessionId,
      valid: true
    });
  });
  
  /**
   * Logout
   * POST /api/zkp/logout
   */
  router.post('/logout', zkpAuthMiddleware, (req, res) => {
    zkAuth.sessions.delete(req.sessionId);
    
    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  });
  
  /**
   * Get miner stats (authenticated)
   * GET /api/zkp/stats
   */
  router.get('/stats', zkpAuthMiddleware, async (req, res) => {
    try {
      // Get session data
      const session = zkAuth.sessions.get(req.sessionId);
      
      // In production, fetch actual miner stats
      const stats = {
        hashrate: Math.random() * 1000000000000, // TH/s
        shares: {
          valid: Math.floor(Math.random() * 10000),
          invalid: Math.floor(Math.random() * 100)
        },
        earnings: {
          unpaid: Math.random() * 0.1,
          paid: Math.random() * 10
        },
        workers: Math.floor(Math.random() * 10) + 1
      };
      
      res.json({
        success: true,
        stats
      });
      
    } catch (error) {
      res.status(500).json({
        error: 'Failed to fetch stats'
      });
    }
  });
  
  /**
   * Create anonymous credential
   * POST /api/zkp/credential/issue
   */
  router.post('/credential/issue', zkpAuthMiddleware, async (req, res) => {
    try {
      const { publicKey, attributes } = req.body;
      
      if (!publicKey) {
        return res.status(400).json({
          error: 'Missing publicKey'
        });
      }
      
      // Issue anonymous credential
      const credential = await zkAuth.credentials.issueCredential(
        publicKey,
        attributes || {}
      );
      
      res.json({
        success: true,
        credential
      });
      
    } catch (error) {
      logger.error('Credential issuance failed', { error: error.message });
      res.status(500).json({
        error: 'Failed to issue credential'
      });
    }
  });
  
  /**
   * Health check
   * GET /api/zkp/health
   */
  router.get('/health', (req, res) => {
    res.json({
      success: true,
      status: 'healthy',
      sessions: zkAuth.sessions.size,
      uptime: process.uptime()
    });
  });
  
  return router;
}

/**
 * ZKP Authentication WebSocket handler
 */
export class ZKPAuthWebSocket {
  constructor(io) {
    this.io = io;
    this.zkp = new SchnorrZKP();
    this.logger = createStructuredLogger('ZKPAuthWS');
    
    this.setupHandlers();
  }
  
  setupHandlers() {
    this.io.on('connection', (socket) => {
      this.logger.info('New WebSocket connection', { id: socket.id });
      
      socket.on('zkp:register', async (data) => {
        await this.handleRegister(socket, data);
      });
      
      socket.on('zkp:authenticate', async (data) => {
        await this.handleAuthenticate(socket, data);
      });
      
      socket.on('zkp:challenge', async (data) => {
        await this.handleChallenge(socket, data);
      });
      
      socket.on('disconnect', () => {
        this.logger.info('WebSocket disconnected', { id: socket.id });
      });
    });
  }
  
  async handleRegister(socket, data) {
    try {
      const { publicKey, proof } = data;
      
      if (!this.zkp.verifyProof(publicKey, proof)) {
        socket.emit('zkp:error', { error: 'Invalid proof' });
        return;
      }
      
      const result = await zkAuth.registerMiner(publicKey);
      socket.emit('zkp:registered', result);
      
    } catch (error) {
      socket.emit('zkp:error', { error: error.message });
    }
  }
  
  async handleAuthenticate(socket, data) {
    try {
      const { credential, proof } = data;
      const result = await zkAuth.authenticateMiner(credential, proof);
      
      if (result.success) {
        socket.sessionId = result.sessionId;
        socket.join('authenticated');
        socket.emit('zkp:authenticated', result);
      } else {
        socket.emit('zkp:error', { error: result.error });
      }
      
    } catch (error) {
      socket.emit('zkp:error', { error: error.message });
    }
  }
  
  async handleChallenge(socket, data) {
    try {
      const { publicKey } = data;
      const challenge = await zkAuth.generateChallenge(publicKey);
      socket.emit('zkp:challenge', challenge);
      
    } catch (error) {
      socket.emit('zkp:error', { error: error.message });
    }
  }
}

export default {
  createZKPAuthRoutes,
  zkpAuthMiddleware,
  ZKPAuthWebSocket
};