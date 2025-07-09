// Async I/O optimization for better throughput (Carmack performance focus)
import { pipeline, Transform, Writable } from 'stream';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import { createComponentLogger } from '../logging/logger';

const logger = createComponentLogger('async-io');
const pipelineAsync = promisify(pipeline);

// Async queue with backpressure support
export class AsyncQueue<T> extends EventEmitter {
  private queue: T[] = [];
  private processing = false;
  private paused = false;
  private highWaterMark: number;
  private lowWaterMark: number;
  
  constructor(
    private processor: (item: T) => Promise<void>,
    options: {
      highWaterMark?: number;
      lowWaterMark?: number;
      concurrency?: number;
    } = {}
  ) {
    super();
    this.highWaterMark = options.highWaterMark || 1000;
    this.lowWaterMark = options.lowWaterMark || 100;
  }
  
  // Add item to queue
  push(item: T): boolean {
    if (this.paused) {
      return false;
    }
    
    this.queue.push(item);
    
    // Check high water mark
    if (this.queue.length >= this.highWaterMark) {
      this.pause();
      return false;
    }
    
    // Start processing if not already
    if (!this.processing) {
      this.process();
    }
    
    return true;
  }
  
  // Pause processing
  pause(): void {
    this.paused = true;
    this.emit('pause');
  }
  
  // Resume processing
  resume(): void {
    this.paused = false;
    this.emit('resume');
    
    if (!this.processing && this.queue.length > 0) {
      this.process();
    }
  }
  
  // Process queue
  private async process(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }
    
    this.processing = true;
    
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      
      try {
        await this.processor(item);
      } catch (error) {
        this.emit('error', error);
      }
      
      // Check low water mark
      if (this.paused && this.queue.length <= this.lowWaterMark) {
        this.resume();
      }
      
      // Yield to event loop
      if (this.queue.length % 100 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    
    this.processing = false;
    this.emit('drain');
  }
  
  // Get queue size
  get size(): number {
    return this.queue.length;
  }
  
  // Check if queue is full
  get isFull(): boolean {
    return this.queue.length >= this.highWaterMark;
  }
}

// Batch processor for efficient I/O
export class BatchProcessor<T> {
  private batch: T[] = [];
  private timer: NodeJS.Timeout | null = null;
  
  constructor(
    private processor: (batch: T[]) => Promise<void>,
    private options: {
      batchSize: number;
      flushInterval: number;
    }
  ) {}
  
  // Add item to batch
  async add(item: T): Promise<void> {
    this.batch.push(item);
    
    if (this.batch.length >= this.options.batchSize) {
      await this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.flush().catch(error => {
          logger.error('Batch flush error', error);
        });
      }, this.options.flushInterval);
    }
  }
  
  // Flush current batch
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    
    if (this.batch.length === 0) {
      return;
    }
    
    const items = this.batch;
    this.batch = [];
    
    await this.processor(items);
  }
  
  // Get current batch size
  get size(): number {
    return this.batch.length;
  }
}

// Stream-based share processor
export class StreamShareProcessor extends Transform {
  private buffer: any[] = [];
  private processing = false;
  
  constructor(
    private validator: (share: any) => Promise<boolean>,
    private options: {
      concurrency: number;
      bufferSize: number;
    } = { concurrency: 10, bufferSize: 100 }
  ) {
    super({
      objectMode: true,
      highWaterMark: options.bufferSize
    });
  }
  
  async _transform(share: any, encoding: string, callback: Function): Promise<void> {
    this.buffer.push(share);
    
    if (!this.processing) {
      this.processing = true;
      await this.processBuffer();
      this.processing = false;
    }
    
    callback();
  }
  
  private async processBuffer(): Promise<void> {
    const promises: Promise<void>[] = [];
    
    while (this.buffer.length > 0 && promises.length < this.options.concurrency) {
      const share = this.buffer.shift();
      
      const promise = this.validator(share)
        .then(valid => {
          this.push({ share, valid });
        })
        .catch(error => {
          this.emit('error', error);
        });
      
      promises.push(promise);
    }
    
    await Promise.all(promises);
    
    // Continue processing if more items
    if (this.buffer.length > 0) {
      await this.processBuffer();
    }
  }
  
  async _flush(callback: Function): Promise<void> {
    // Process remaining items
    this.processing = true;
    await this.processBuffer();
    callback();
  }
}

// Optimized file writer with buffering
export class BufferedFileWriter {
  private writeStream: Writable | null = null;
  private buffer: Buffer[] = [];
  private bufferSize = 0;
  private closed = false;
  
  constructor(
    private filename: string,
    private options: {
      bufferSize: number;
      flushInterval: number;
    } = { bufferSize: 65536, flushInterval: 1000 }
  ) {
    this.scheduleFlush();
  }
  
  // Write data
  async write(data: Buffer | string): Promise<void> {
    if (this.closed) {
      throw new Error('Writer is closed');
    }
    
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.buffer.push(buffer);
    this.bufferSize += buffer.length;
    
    if (this.bufferSize >= this.options.bufferSize) {
      await this.flush();
    }
  }
  
  // Flush buffer to file
  private async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }
    
    const data = Buffer.concat(this.buffer);
    this.buffer = [];
    this.bufferSize = 0;
    
    // Write to file using streams
    if (!this.writeStream) {
      const fs = await import('fs');
      this.writeStream = fs.createWriteStream(this.filename, {
        flags: 'a',
        highWaterMark: this.options.bufferSize
      });
    }
    
    return new Promise((resolve, reject) => {
      this.writeStream!.write(data, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  
  // Schedule periodic flush
  private scheduleFlush(): void {
    if (this.closed) return;
    
    setTimeout(() => {
      this.flush().catch(error => {
        logger.error('Flush error', error);
      });
      this.scheduleFlush();
    }, this.options.flushInterval);
  }
  
  // Close writer
  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
    
    if (this.writeStream) {
      return new Promise((resolve) => {
        this.writeStream!.end(resolve);
      });
    }
  }
}

// Parallel file reader
export class ParallelFileReader {
  constructor(
    private options: {
      chunkSize: number;
      concurrency: number;
    } = { chunkSize: 65536, concurrency: 4 }
  ) {}
  
  // Read file in parallel chunks
  async readParallel(
    filename: string,
    processor: (chunk: Buffer, offset: number) => Promise<void>
  ): Promise<void> {
    const fs = await import('fs');
    const { size } = await fs.promises.stat(filename);
    
    const chunks: Array<{ start: number; end: number }> = [];
    
    // Calculate chunks
    for (let i = 0; i < size; i += this.options.chunkSize) {
      chunks.push({
        start: i,
        end: Math.min(i + this.options.chunkSize, size)
      });
    }
    
    // Process chunks in parallel
    const promises: Promise<void>[] = [];
    let activeCount = 0;
    
    for (const chunk of chunks) {
      // Wait if too many active
      while (activeCount >= this.options.concurrency) {
        await new Promise(resolve => setImmediate(resolve));
      }
      
      activeCount++;
      
      const promise = this.readChunk(filename, chunk.start, chunk.end, processor)
        .finally(() => activeCount--);
      
      promises.push(promise);
    }
    
    await Promise.all(promises);
  }
  
  // Read single chunk
  private async readChunk(
    filename: string,
    start: number,
    end: number,
    processor: (chunk: Buffer, offset: number) => Promise<void>
  ): Promise<void> {
    const fs = await import('fs');
    const stream = fs.createReadStream(filename, { start, end: end - 1 });
    
    const chunks: Buffer[] = [];
    
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    
    const buffer = Buffer.concat(chunks);
    await processor(buffer, start);
  }
}

// I/O scheduler for prioritized operations
export class IOScheduler {
  private queues = new Map<number, AsyncQueue<() => Promise<void>>>();
  private activeOperations = 0;
  
  constructor(
    private maxConcurrent: number = 10
  ) {}
  
  // Schedule I/O operation
  async schedule<T>(
    operation: () => Promise<T>,
    priority: number = 0
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const task = async () => {
        this.activeOperations++;
        
        try {
          const result = await operation();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this.activeOperations--;
          this.processQueues();
        }
      };
      
      this.enqueue(task, priority);
    });
  }
  
  // Add task to appropriate queue
  private enqueue(task: () => Promise<void>, priority: number): void {
    if (!this.queues.has(priority)) {
      this.queues.set(priority, new AsyncQueue(
        async (task) => {
          if (this.activeOperations < this.maxConcurrent) {
            await task();
          } else {
            // Re-enqueue if at capacity
            setImmediate(() => this.enqueue(task, priority));
          }
        }
      ));
    }
    
    const queue = this.queues.get(priority)!;
    queue.push(task);
  }
  
  // Process queues by priority
  private processQueues(): void {
    // Sort priorities (higher first)
    const priorities = Array.from(this.queues.keys()).sort((a, b) => b - a);
    
    for (const priority of priorities) {
      const queue = this.queues.get(priority)!;
      if (queue.size > 0 && this.activeOperations < this.maxConcurrent) {
        break; // Let queue process
      }
    }
  }
  
  // Get scheduler statistics
  getStats(): {
    activeOperations: number;
    queueSizes: { [priority: number]: number };
  } {
    const queueSizes: { [priority: number]: number } = {};
    
    for (const [priority, queue] of this.queues) {
      queueSizes[priority] = queue.size;
    }
    
    return {
      activeOperations: this.activeOperations,
      queueSizes
    };
  }
}

// Export singleton scheduler
export const ioScheduler = new IOScheduler();
