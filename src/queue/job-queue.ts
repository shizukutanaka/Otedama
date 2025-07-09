import { Queue, Worker, Job, QueueScheduler, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { EventEmitter } from 'events';

export interface GenericJobData {
  /**
   * A short identifier for the job type, e.g. "email", "payout", etc.
   */
  type: string;
  /**
   * Arbitrary payload for the job. Should be JSON-serialisable.
   */
  payload: unknown;
}

export interface JobQueueOptions {
  /** Redis connection URI, e.g. "redis://localhost:6379". */
  connectionString?: string;
  /** Queue name (default: "otedama_jobs"). */
  queueName?: string;
  /** Concurrency for workers (default: 4). */
  concurrency?: number;
}

/**
 * Lightweight BullMQ wrapper used by Otedama for off-loading heavy or
 * latency-sensitive work to background workers.
 */
export class JobQueue extends EventEmitter {
  public readonly queue: Queue<GenericJobData>;
  private readonly scheduler: QueueScheduler;
  private readonly worker: Worker<GenericJobData>;
  private readonly events: QueueEvents;

  constructor(opts: JobQueueOptions = {}) {
    super();

    const connection = new IORedis(opts.connectionString || 'redis://127.0.0.1:6379');
    const queueName = opts.queueName || 'otedama_jobs';

    this.queue = new Queue<GenericJobData>(queueName, { connection });
    this.scheduler = new QueueScheduler(queueName, { connection });
    this.events = new QueueEvents(queueName, { connection });

    // Simple inline worker. In production we may want a separate process – this
    // version keeps implementation minimal and avoids IPC complexity.
    this.worker = new Worker<GenericJobData>(
      queueName,
      async (job: Job<GenericJobData>) => {
        this.emit('job:start', job.name, job.data);
        await this.processJob(job);
        this.emit('job:done', job.name);
      },
      {
        connection,
        concurrency: opts.concurrency ?? 4,
      },
    );

    this.worker.on('failed', (job: Job<GenericJobData> | undefined, err: Error) => {
      this.emit('job:failed', job?.name, err);
    });
  }

  /** Enqueue a job for asynchronous execution. */
  async enqueue(type: string, payload: unknown, opts: { delayMs?: number } = {}): Promise<Job<GenericJobData>> {
    return this.queue.add(type, { type, payload }, {
      removeOnComplete: true,
      removeOnFail: false,
      delay: opts.delayMs ?? 0,
    });
  }

  /** Inline job processor. Extend with real task implementations. */
  private async processJob(job: Job<GenericJobData>): Promise<void> {
    switch (job.data.type) {
      case 'payout':
        // TODO: Implement actual payout processing logic.
        break;
      case 'email':
        // TODO: Send email.
        break;
      default:
        // No-op – unknown job type
        break;
    }
  }

  /** Gracefully shut down queue, worker and scheduler. */
  async shutdown(): Promise<void> {
    await this.worker.close();
    await this.scheduler.close();
    await this.queue.close();
    await this.events.close();
  }
}
