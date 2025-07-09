import { EventEmitter } from 'events';
import { logger } from '../logging/logger';
import { PoolEvent, EventData } from './types';

export class EventBus extends EventEmitter {
  private static instance: EventBus;
  private eventHandlers: Map<string, Set<(...args: any[]) => void>>;

  private constructor() {
    super();
    this.eventHandlers = new Map();
  }

  public static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  public on(event: PoolEvent, listener: (...args: any[]) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.add(listener);
      super.on(event, listener);
      logger.debug(`Registered listener for event: ${event}`);
    }
  }

  public off(event: PoolEvent, listener: (...args: any[]) => void): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.delete(listener);
      super.off(event, listener);
      logger.debug(`Removed listener for event: ${event}`);
    }
  }

  public emit(event: PoolEvent, data: EventData): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(data);
        } catch (error) {
          logger.error(`Error in event handler for ${event}:`, error);
        }
      });
    }
    
    super.emit(event, data);
    logger.debug(`Emitted event: ${event}`);
  }

  public getEventListeners(event: PoolEvent): Set<(...args: any[]) => void> {
    return this.eventHandlers.get(event) || new Set();
  }

  public clearEventListeners(event?: PoolEvent): void {
    if (event) {
      this.eventHandlers.delete(event);
      super.removeAllListeners(event);
    } else {
      this.eventHandlers.clear();
      super.removeAllListeners();
    }
  }

  public async broadcastToMiners(event: PoolEvent, data: EventData): Promise<void> {
    const miners = await this.getConnectedMiners();
    
    for (const miner of miners) {
      try {
        await miner.sendEvent(event, data);
      } catch (error) {
        logger.error(`Failed to broadcast to miner ${miner.id}:`, error);
      }
    }
  }

  private async getConnectedMiners(): Promise<any[]> {
    // Implementation depends on your miner connection system
    // This is a placeholder
    return [];
  }
}
