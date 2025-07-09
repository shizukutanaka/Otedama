// Pike-inspired channels for TypeScript
export class Channel<T> {
  private buffer: T[] = [];
  private waiters: ((value: T) => void)[] = [];
  private closed = false;
  private maxSize: number;
  
  constructor(bufferSize: number = 0) {
    this.maxSize = bufferSize;
  }
  
  async send(value: T): Promise<void> {
    if (this.closed) {
      throw new Error('Channel closed');
    }
    
    // If there's a waiter, deliver directly
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(value);
      return;
    }
    
    // If buffer is full, wait
    if (this.buffer.length >= this.maxSize) {
      return new Promise((resolve) => {
        const tryAgain = () => {
          if (this.buffer.length < this.maxSize) {
            this.buffer.push(value);
            resolve();
          } else {
            setImmediate(tryAgain);
          }
        };
        tryAgain();
      });
    }
    
    // Add to buffer
    this.buffer.push(value);
  }
  
  async receive(): Promise<T> {
    // If buffer has data, return immediately
    if (this.buffer.length > 0) {
      return this.buffer.shift()!;
    }
    
    if (this.closed) {
      throw new Error('Channel closed');
    }
    
    // Wait for data
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
  
  // Non-blocking receive
  tryReceive(): T | undefined {
    return this.buffer.shift();
  }
  
  close(): void {
    this.closed = true;
    // Reject all waiters
    for (const waiter of this.waiters) {
      waiter(undefined as any);
    }
    this.waiters = [];
  }
  
  get size(): number {
    return this.buffer.length;
  }
  
  get isClosed(): boolean {
    return this.closed;
  }
}

// Simple select operation for multiple channels
export async function select<T>(...channels: Channel<T>[]): Promise<[T, number]> {
  return new Promise((resolve) => {
    let resolved = false;
    
    channels.forEach((channel, index) => {
      // Try non-blocking receive first
      const value = channel.tryReceive();
      if (value !== undefined && !resolved) {
        resolved = true;
        resolve([value, index]);
        return;
      }
      
      // Set up blocking receive
      channel.receive().then((value) => {
        if (!resolved) {
          resolved = true;
          resolve([value, index]);
        }
      }).catch(() => {
        // Channel closed
      });
    });
  });
}
