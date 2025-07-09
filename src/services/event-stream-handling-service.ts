// Event stream handling service
// Manages event publishing and consumption for the pool

import { Container } from '../di/container';
import { Logger } from '../logging/logger';
import { EnhancedMiningPoolCore } from '../core/enhanced-pool';
import { EventStreamingManager } from '../streaming/event-streaming';
import { AlertManager } from '../alerts/alert-manager';
import { AnomalyDetector } from '../monitoring/anomaly-detector';

export class EventStreamHandlingService {
  private container: Container;
  private logger: Logger;
  private producer?: any;
  private alertConsumer?: any;
  private isRunning = false;
  
  constructor(container: Container) {
    this.container = container;
    this.logger = new Logger('EventStreamHandler');
  }
  
  /**
   * Start the event stream handling service
   */
  async start(): Promise<void> {
    const eventStreaming = this.container.get<EventStreamingManager>('eventStreaming');
    if (!eventStreaming) {
      this.logger.info('Event streaming not enabled');
      return;
    }
    
    this.logger.info('Starting event stream handler...');
    this.isRunning = true;
    
    try {
      // Setup producer
      await this.setupProducer(eventStreaming);
      
      // Setup consumers
      await this.setupConsumers(eventStreaming);
      
      // Setup event listeners
      this.setupEventListeners();
      
      this.logger.info('Event stream handler started successfully');
    } catch (error) {
      this.logger.error('Failed to start event stream handler:', error as Error);
      this.isRunning = false;
      throw error;
    }
  }
  
  /**
   * Stop the event stream handling service
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    
    this.logger.info('Stopping event stream handler...');
    this.isRunning = false;
    
    try {
      // Disconnect producer
      if (this.producer && typeof this.producer.disconnect === 'function') {
        await this.producer.disconnect();
      }
      
      // Disconnect consumers
      if (this.alertConsumer && typeof this.alertConsumer.disconnect === 'function') {
        await this.alertConsumer.disconnect();
      }
      
      this.logger.info('Event stream handler stopped');
    } catch (error) {
      this.logger.error('Error stopping event stream handler:', error as Error);
    }
  }
  
  /**
   * Setup event producer
   */
  private async setupProducer(eventStreaming: EventStreamingManager): Promise<void> {
    this.producer = eventStreaming.createProducer('pool-core');
    await this.producer.connect();
    this.logger.info('Event producer connected');
  }
  
  /**
   * Setup event consumers
   */
  private async setupConsumers(eventStreaming: EventStreamingManager): Promise<void> {
    // Alert consumer
    this.alertConsumer = eventStreaming.createConsumer('alert-processor', ['alert-events']);
    await this.alertConsumer.connect();
    await this.alertConsumer.subscribe(['alert-events']);
    
    // Run alert consumer
    this.alertConsumer.run(async (event: any) => {
      if (!this.isRunning) return;
      
      try {
        await this.handleAlertEvent(event);
      } catch (error) {
        this.logger.error('Error handling alert event:', error as Error);
      }
    });
    
    this.logger.info('Event consumers setup complete');
  }
  
  /**
   * Setup event listeners on pool core
   */
  private setupEventListeners(): void {
    const core = this.container.get<EnhancedMiningPoolCore>('core');
    const anomalyDetector = this.container.get<AnomalyDetector>('anomalyDetector');
    
    if (!core) {
      throw new Error('Core not available for event listeners');
    }
    
    // Share submitted event
    core.on('share', async (share, miner) => {
      if (!this.isRunning || !this.producer) return;
      
      try {
        await this.producer.send('share-events', share.minerId, {
          type: 'share.submitted',
          data: share
        });
        
        // Process share for anomaly detection
        if (anomalyDetector) {
          await anomalyDetector.processShare(share, miner);
        }
      } catch (error) {
        this.logger.error('Error publishing share event:', error as Error);
      }
    });
    
    // Block found event
    core.on('block', async (block) => {
      if (!this.isRunning || !this.producer) return;
      
      try {
        await this.producer.send('pool-events', null, {
          type: 'block.found',
          data: block
        });
      } catch (error) {
        this.logger.error('Error publishing block event:', error as Error);
      }
    });
    
    // Miner connected event
    core.on('miner:connected', async (miner) => {
      if (!this.isRunning || !this.producer) return;
      
      try {
        await this.producer.send('pool-events', miner.id, {
          type: 'miner.connected',
          data: { minerId: miner.id, address: miner.address }
        });
      } catch (error) {
        this.logger.error('Error publishing miner connected event:', error as Error);
      }
    });
    
    // Miner disconnected event
    core.on('miner:disconnected', async (minerId) => {
      if (!this.isRunning || !this.producer) return;
      
      try {
        await this.producer.send('pool-events', minerId, {
          type: 'miner.disconnected',
          data: { minerId }
        });
      } catch (error) {
        this.logger.error('Error publishing miner disconnected event:', error as Error);
      }
    });
    
    // Anomaly detection events
    if (anomalyDetector) {
      anomalyDetector.on('anomaly', async (anomaly) => {
        if (!this.isRunning || !this.producer) return;
        
        try {
          await this.producer.send('alert-events', null, {
            type: 'alert.triggered',
            data: {
              title: `Anomaly: ${anomaly.type}`,
              message: anomaly.description,
              severity: anomaly.severity
            }
          });
        } catch (error) {
          this.logger.error('Error publishing anomaly event:', error as Error);
        }
      });
    }
    
    this.logger.info('Event listeners setup complete');
  }
  
  /**
   * Handle alert events from the stream
   */
  private async handleAlertEvent(event: any): Promise<void> {
    if (event.value.type === 'alert.triggered') {
      const alertManager = this.container.get<AlertManager>('alertManager');
      if (alertManager) {
        await alertManager.sendAlert(
          event.value.data.title,
          event.value.data.message
        );
      }
    }
  }
}
