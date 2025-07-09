import { Command } from './types';
import { logger } from '../../logging/logger';
import { CommandHandler } from './handler';

export class CommandBus {
  private handlers: Map<string, CommandHandler<any>>;

  constructor() {
    this.handlers = new Map();
  }

  public register<T extends Command>(type: string, handler: CommandHandler<T>): void {
    if (this.handlers.has(type)) {
      logger.warn(`Command handler for ${type} already registered`);
      return;
    }

    this.handlers.set(type, handler);
    logger.info(`Registered command handler for ${type}`);
  }

  public async execute<T extends Command>(command: T): Promise<void> {
    const handler = this.handlers.get(command.type);
    
    if (!handler) {
      logger.error(`No handler registered for command type: ${command.type}`);
      throw new Error(`No handler registered for command type: ${command.type}`);
    }

    try {
      await handler.handle(command);
      logger.debug(`Successfully executed command: ${command.type}`);
    } catch (error) {
      logger.error(`Error executing command ${command.type}:`, error);
      throw error;
    }
  }

  public getHandler<T extends Command>(type: string): CommandHandler<T> | undefined {
    return this.handlers.get(type) as CommandHandler<T>;
  }

  public hasHandler(type: string): boolean {
    return this.handlers.has(type);
  }

  public unregister(type: string): void {
    this.handlers.delete(type);
    logger.info(`Unregistered command handler for ${type}`);
  }
}
