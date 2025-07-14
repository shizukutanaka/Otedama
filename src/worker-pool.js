import { Worker } from 'worker_threads';
import os from 'os';

/**
 * @class WorkerPool
 * @description Manages a pool of worker threads to execute tasks concurrently.
 */
export class WorkerPool {
  constructor(maxWorkers = os.cpus().length) {
    this.maxWorkers = maxWorkers;
    this.workers = [];
    this.queue = [];
    this.activeJobs = new Map();
    this.idleWorkers = [];
  }

  /**
   * Executes a job in a worker thread.
   * @param {string} code - The code to execute in the worker.
   * @param {any} workerData - Data to pass to the worker.
   * @returns {Promise<any>} A promise that resolves with the result of the job.
   */
  execute(code, workerData) {
    return new Promise((resolve, reject) => {
      const job = { code, workerData, resolve, reject };
      const idleWorker = this.idleWorkers.pop();

      if (idleWorker) {
        this.runJob(idleWorker, job);
      } else if (this.workers.length < this.maxWorkers) {
        const worker = this.createWorker();
        this.runJob(worker, job);
      } else {
        this.queue.push(job);
      }
    });
  }

  /**
   * Creates a new worker thread.
   * @returns {Worker} The new worker instance.
   */
  createWorker() {
    // Note: Using eval: true for dynamic code execution. Be cautious in production.
    const worker = new Worker(`
      const { parentPort } = require('worker_threads');
      parentPort.on('message', async ({ id, code, workerData }) => {
        try {
          const fn = new Function('workerData', code);
          const result = await fn(workerData);
          parentPort.postMessage({ id, result });
        } catch (error) {
          parentPort.postMessage({ id, error: error.message });
        }
      });
    `, { eval: true });

    this.workers.push(worker);
    return worker;
  }

  /**
   * Runs a job on a given worker.
   * @param {Worker} worker - The worker to run the job on.
   * @param {object} job - The job to run.
   */
  runJob(worker, job) {
    const id = Math.random().toString(36).substring(2, 11);
    this.activeJobs.set(id, job);

    const messageHandler = (msg) => {
      if (msg.id === id) {
        worker.off('message', messageHandler);
        const completedJob = this.activeJobs.get(id);
        this.activeJobs.delete(id);

        if (msg.error) {
          completedJob.reject(new Error(msg.error));
        } else {
          completedJob.resolve(msg.result);
        }

        const nextJob = this.queue.shift();
        if (nextJob) {
          this.runJob(worker, nextJob);
        } else {
          this.idleWorkers.push(worker);
        }
      }
    };

    worker.on('message', messageHandler);
    worker.postMessage({ id, code: job.code, workerData: job.workerData });
  }

  /**
   * Terminates all workers in the pool.
   * @returns {Promise<void>}
   */
  async terminate() {
    await Promise.all(this.workers.map(w => w.terminate()));
    this.workers = [];
    this.idleWorkers = [];
    this.queue = [];
    this.activeJobs.clear();
  }
}
