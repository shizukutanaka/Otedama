import { DomainEvent } from '../database/event-store';

// A simple interface for any saga that can handle events
interface IEventHandler {
  handleEvent(event: DomainEvent): Promise<void>;
}

/**
 * A simple event dispatcher to route domain events to registered sagas.
 * In a more complex system, this would be a robust message bus (e.g., RabbitMQ, Kafka).
 */
class EventDispatcher {
  private handlers: IEventHandler[] = [];

  /**
   * Registers a saga or any other event handler.
   * @param handler An object with a handleEvent method.
   */
  public register(handler: IEventHandler): void {
    this.handlers.push(handler);
    console.log(`[EventDispatcher] Registered handler: ${handler.constructor.name}`);
  }

  /**
   * Dispatches an event to all registered handlers.
   * @param event The domain event to dispatch.
   */
  public async dispatch(event: DomainEvent): Promise<void> {
    console.log(`[EventDispatcher] Dispatching event: ${event.eventType} for stream: ${event.streamId}`);
    for (const handler of this.handlers) {
      try {
        // We don't wait for the handler to complete to avoid blocking the main thread.
        // This is a fire-and-forget approach suitable for sagas.
        handler.handleEvent(event);
      } catch (error) {
        console.error(`[EventDispatcher] Error in handler ${handler.constructor.name} for event ${event.eventType}:`, error);
      }
    }
  }
}

// Singleton instance for the EventDispatcher
const eventDispatcher = new EventDispatcher();

export function getEventDispatcher(): EventDispatcher {
  return eventDispatcher;
}
