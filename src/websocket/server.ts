import { WebSocketServer } from 'ws';
import { Server } from 'http';
import { PoolEvents, WebSocketMessage, WebSocketMessageType } from './types';
import { logger } from '../logging/logger';
import { PoolService } from '../services/pool';

export class WebSocketServer {
  private wss: WebSocketServer;
  private poolService: PoolService;
  private subscriptionHandlers: Map<string, (...args: any[]) => void>;

  constructor(server: Server, poolService: PoolService) {
    this.poolService = poolService;
    this.subscriptionHandlers = new Map();
    this.wss = new WebSocketServer({ server });
    
    // Initialize event handlers
    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    this.wss.on('connection', (ws) => {
      logger.info('New WebSocket connection established');
      
      ws.on('message', (message: string) => this.handleMessage(ws, message));
      
      ws.on('close', () => {
        logger.info('WebSocket connection closed');
      });
    });

    // Subscribe to pool events
    this.poolService.on('minerConnected', this.handleMinerConnected);
    this.poolService.on('minerDisconnected', this.handleMinerDisconnected);
    this.poolService.on('newBlock', this.handleNewBlock);
    this.poolService.on('paymentProcessed', this.handlePaymentProcessed);
  }

  private handleMessage(ws: any, message: string) {
    try {
      const data: WebSocketMessage = JSON.parse(message);
      
      switch (data.type) {
        case WebSocketMessageType.Subscribe:
          this.handleSubscription(ws, data.payload);
          break;
        case WebSocketMessageType.Unsubscribe:
          this.handleUnsubscription(ws, data.payload);
          break;
        default:
          logger.warn(`Unknown message type: ${data.type}`);
      }
    } catch (error) {
      logger.error('Error processing WebSocket message:', error);
      ws.send(JSON.stringify({
        type: WebSocketMessageType.Error,
        payload: 'Invalid message format'
      }));
    }
  }

  private handleSubscription(ws: any, subscription: string) {
    if (!PoolEvents.includes(subscription)) {
      ws.send(JSON.stringify({
        type: WebSocketMessageType.Error,
        payload: `Invalid subscription: ${subscription}`
      }));
      return;
    }

    // Store subscription handler
    const handler = (data: any) => {
      ws.send(JSON.stringify({
        type: subscription,
        payload: data
      }));
    };
    
    this.subscriptionHandlers.set(ws, handler);
    
    // Send initial data
    switch (subscription) {
      case 'minerStatus':
        ws.send(JSON.stringify({
          type: 'minerStatus',
          payload: this.poolService.getMinerStatus()
        }));
        break;
      case 'poolStats':
        ws.send(JSON.stringify({
          type: 'poolStats',
          payload: this.poolService.getPoolStats()
        }));
        break;
    }
  }

  private handleUnsubscription(ws: any, subscription: string) {
    const handler = this.subscriptionHandlers.get(ws);
    if (handler) {
      this.subscriptionHandlers.delete(ws);
    }
  }

  private handleMinerConnected = (miner: any) => {
    this.broadcast('minerConnected', miner);
  };

  private handleMinerDisconnected = (miner: any) => {
    this.broadcast('minerDisconnected', miner);
  };

  private handleNewBlock = (block: any) => {
    this.broadcast('newBlock', block);
  };

  private handlePaymentProcessed = (payment: any) => {
    this.broadcast('paymentProcessed', payment);
  };

  private broadcast(event: string, data: any) {
    this.wss.clients.forEach((client: any) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: event,
          payload: data
        }));
      }
    });
  }

  public close() {
    this.wss.close();
  }
}
