/**
 * Payment Scheduler - Automated Payment Management
 * Following Carmack/Martin/Pike principles:
 * - Reliable scheduled payments
 * - Flexible scheduling options
 * - Efficient batch processing
 */

import { EventEmitter } from 'events';
import * as cron from 'node-cron';
import { logger } from '../utils/logger';

interface SchedulerConfig {
  // Schedule types
  schedules: PaymentSchedule[];
  
  // Batch settings
  batch: {
    enabled: boolean;
    maxSize: number;
    maxValue: number;
    groupByCurrency: boolean;
  };
  
  // Timing settings
  timing: {
    timezone: string;
    retryAttempts: number;
    retryDelay: number; // seconds
    timeout: number; // seconds
  };
  
  // Safety settings
  safety: {
    maxDailyPayments: number;
    maxDailyValue: number;
    requireConfirmation: boolean;
    confirmationThreshold: number;
  };
}

interface PaymentSchedule {
  id: string;
  name: string;
  type: 'fixed' | 'interval' | 'custom';
  
  // Schedule settings
  schedule: {
    cron?: string; // Cron expression
    interval?: number; // Seconds
    times?: string[]; // Fixed times (HH:MM)
    daysOfWeek?: number[]; // 0-6 (Sunday-Saturday)
    daysOfMonth?: number[]; // 1-31
  };
  
  // Payment criteria
  criteria: {
    minBalance?: number;
    currencies?: string[];
    userGroups?: string[];
    priority?: number;
  };
  
  enabled: boolean;
  lastRun?: Date;
  nextRun?: Date;
}

interface ScheduledPayment {
  id: string;
  scheduleId: string;
  userId: string;
  currency: string;
  amount: number;
  
  // Status
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  attempts: number;
  
  // Timestamps
  scheduledFor: Date;
  processedAt?: Date;
  completedAt?: Date;
  
  // Transaction details
  txId?: string;
  error?: string;
  
  // Batch info
  batchId?: string;
}

interface PaymentBatch {
  id: string;
  scheduleId: string;
  currency: string;
  
  // Payments
  payments: ScheduledPayment[];
  totalAmount: number;
  
  // Status
  status: 'pending' | 'processing' | 'completed' | 'failed';
  
  // Timestamps
  createdAt: Date;
  processedAt?: Date;
  completedAt?: Date;
  
  // Transaction
  txId?: string;
  fee?: number;
}

interface PaymentQueue {
  pending: ScheduledPayment[];
  processing: ScheduledPayment[];
  completed: ScheduledPayment[];
  failed: ScheduledPayment[];
}

interface ScheduleStats {
  scheduleId: string;
  totalPayments: number;
  successfulPayments: number;
  failedPayments: number;
  totalAmount: number;
  avgAmount: number;
  lastRun?: Date;
  nextRun?: Date;
}

export class PaymentScheduler extends EventEmitter {
  private config: SchedulerConfig;
  private schedules: Map<string, PaymentSchedule> = new Map();
  private cronJobs: Map<string, cron.ScheduledTask> = new Map();
  private paymentQueue: PaymentQueue = {
    pending: [],
    processing: [],
    completed: [],
    failed: []
  };
  private batches: Map<string, PaymentBatch> = new Map();
  private dailyStats = {
    payments: 0,
    value: 0,
    date: new Date().toDateString()
  };
  
  private isProcessing: boolean = false;
  private processInterval?: NodeJS.Timer;

  constructor(config: SchedulerConfig) {
    super();
    this.config = config;
  }

  /**
   * Initialize payment scheduler
   */
  async initialize(): Promise<void> {
    logger.info('Initializing payment scheduler', {
      schedules: this.config.schedules.length,
      timezone: this.config.timing.timezone
    });

    // Load schedules
    for (const schedule of this.config.schedules) {
      this.addSchedule(schedule);
    }

    // Start processing loop
    this.startProcessingLoop();

    // Load pending payments
    await this.loadPendingPayments();

    this.emit('initialized');
  }

  /**
   * Add payment schedule
   */
  addSchedule(schedule: PaymentSchedule): void {
    this.schedules.set(schedule.id, schedule);

    if (schedule.enabled) {
      this.activateSchedule(schedule);
    }

    logger.info('Added payment schedule', {
      id: schedule.id,
      name: schedule.name,
      type: schedule.type
    });

    this.emit('schedule:added', schedule);
  }

  /**
   * Update schedule
   */
  updateSchedule(scheduleId: string, updates: Partial<PaymentSchedule>): void {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) {
      throw new Error(`Schedule ${scheduleId} not found`);
    }

    // Deactivate old schedule
    this.deactivateSchedule(scheduleId);

    // Apply updates
    Object.assign(schedule, updates);

    // Reactivate if enabled
    if (schedule.enabled) {
      this.activateSchedule(schedule);
    }

    logger.info('Updated payment schedule', { scheduleId, updates });
    this.emit('schedule:updated', schedule);
  }

  /**
   * Activate schedule
   */
  private activateSchedule(schedule: PaymentSchedule): void {
    switch (schedule.type) {
      case 'fixed':
        this.activateFixedSchedule(schedule);
        break;
      case 'interval':
        this.activateIntervalSchedule(schedule);
        break;
      case 'custom':
        this.activateCustomSchedule(schedule);
        break;
    }

    // Calculate next run
    schedule.nextRun = this.calculateNextRun(schedule);
  }

  /**
   * Activate fixed schedule
   */
  private activateFixedSchedule(schedule: PaymentSchedule): void {
    if (!schedule.schedule.times || schedule.schedule.times.length === 0) {
      logger.warn('Fixed schedule has no times', { scheduleId: schedule.id });
      return;
    }

    // Create cron expression from times
    const cronExpressions = schedule.schedule.times.map(time => {
      const [hour, minute] = time.split(':').map(Number);
      return `${minute} ${hour} * * *`;
    });

    // Create combined cron job
    const cronExpression = cronExpressions.join(',');
    const job = cron.schedule(cronExpression, () => {
      this.executeSchedule(schedule);
    }, {
      scheduled: true,
      timezone: this.config.timing.timezone
    });

    this.cronJobs.set(schedule.id, job);
  }

  /**
   * Activate interval schedule
   */
  private activateIntervalSchedule(schedule: PaymentSchedule): void {
    if (!schedule.schedule.interval) {
      logger.warn('Interval schedule has no interval', { scheduleId: schedule.id });
      return;
    }

    // Use simple interval
    const intervalId = setInterval(() => {
      this.executeSchedule(schedule);
    }, schedule.schedule.interval * 1000);

    // Store as pseudo-cron job
    this.cronJobs.set(schedule.id, intervalId as any);
  }

  /**
   * Activate custom schedule
   */
  private activateCustomSchedule(schedule: PaymentSchedule): void {
    if (!schedule.schedule.cron) {
      logger.warn('Custom schedule has no cron expression', { scheduleId: schedule.id });
      return;
    }

    const job = cron.schedule(schedule.schedule.cron, () => {
      this.executeSchedule(schedule);
    }, {
      scheduled: true,
      timezone: this.config.timing.timezone
    });

    this.cronJobs.set(schedule.id, job);
  }

  /**
   * Deactivate schedule
   */
  private deactivateSchedule(scheduleId: string): void {
    const job = this.cronJobs.get(scheduleId);
    if (job) {
      if (typeof job.stop === 'function') {
        job.stop();
      } else {
        clearInterval(job as any);
      }
      this.cronJobs.delete(scheduleId);
    }
  }

  /**
   * Execute schedule
   */
  private async executeSchedule(schedule: PaymentSchedule): Promise<void> {
    logger.info('Executing payment schedule', {
      scheduleId: schedule.id,
      name: schedule.name
    });

    schedule.lastRun = new Date();
    schedule.nextRun = this.calculateNextRun(schedule);

    try {
      // Get eligible payments
      const payments = await this.getEligiblePayments(schedule);
      
      if (payments.length === 0) {
        logger.info('No eligible payments for schedule', { scheduleId: schedule.id });
        return;
      }

      logger.info('Found eligible payments', {
        scheduleId: schedule.id,
        count: payments.length
      });

      // Check safety limits
      if (!this.checkSafetyLimits(payments)) {
        logger.warn('Safety limits exceeded', {
          scheduleId: schedule.id,
          payments: payments.length
        });
        this.emit('schedule:safety-limit', { schedule, payments });
        return;
      }

      // Queue payments
      await this.queuePayments(payments, schedule.id);

      this.emit('schedule:executed', {
        schedule,
        payments: payments.length
      });

    } catch (err) {
      logger.error('Schedule execution failed', {
        scheduleId: schedule.id,
        error: err
      });
      this.emit('schedule:error', { schedule, error: err });
    }
  }

  /**
   * Get eligible payments for schedule
   */
  private async getEligiblePayments(schedule: PaymentSchedule): Promise<ScheduledPayment[]> {
    // This would query actual payment system
    // For now, return mock data
    const mockPayments: ScheduledPayment[] = [];
    
    // Simulate getting users with balances above threshold
    const eligibleUsers = await this.getEligibleUsers(schedule.criteria);
    
    for (const user of eligibleUsers) {
      mockPayments.push({
        id: `payment-${Date.now()}-${user.id}`,
        scheduleId: schedule.id,
        userId: user.id,
        currency: user.currency,
        amount: user.balance,
        status: 'pending',
        attempts: 0,
        scheduledFor: new Date()
      });
    }

    return mockPayments;
  }

  /**
   * Get eligible users based on criteria
   */
  private async getEligibleUsers(criteria: PaymentSchedule['criteria']): Promise<any[]> {
    // This would query actual user balances
    // Mock implementation
    return [
      { id: 'user1', currency: 'BTC', balance: 0.01 },
      { id: 'user2', currency: 'ETH', balance: 0.5 }
    ].filter(user => {
      if (criteria.minBalance && user.balance < criteria.minBalance) {
        return false;
      }
      if (criteria.currencies && !criteria.currencies.includes(user.currency)) {
        return false;
      }
      return true;
    });
  }

  /**
   * Queue payments for processing
   */
  private async queuePayments(payments: ScheduledPayment[], scheduleId: string): Promise<void> {
    // Group into batches if enabled
    if (this.config.batch.enabled) {
      const batches = this.createBatches(payments, scheduleId);
      
      for (const batch of batches) {
        this.batches.set(batch.id, batch);
        this.paymentQueue.pending.push(...batch.payments);
      }
    } else {
      this.paymentQueue.pending.push(...payments);
    }

    logger.info('Payments queued', {
      scheduleId,
      count: payments.length,
      batches: this.config.batch.enabled ? Math.ceil(payments.length / this.config.batch.maxSize) : 0
    });
  }

  /**
   * Create payment batches
   */
  private createBatches(payments: ScheduledPayment[], scheduleId: string): PaymentBatch[] {
    const batches: PaymentBatch[] = [];
    
    // Group by currency if enabled
    const groups = this.config.batch.groupByCurrency
      ? this.groupByCurrency(payments)
      : [payments];

    for (const group of groups) {
      // Split into size-limited batches
      for (let i = 0; i < group.length; i += this.config.batch.maxSize) {
        const batchPayments = group.slice(i, i + this.config.batch.maxSize);
        const totalAmount = batchPayments.reduce((sum, p) => sum + p.amount, 0);
        
        // Check value limit
        if (totalAmount > this.config.batch.maxValue) {
          // Split further by value
          const valueBatches = this.splitByValue(batchPayments, this.config.batch.maxValue);
          batches.push(...valueBatches.map(vb => this.createBatch(vb, scheduleId)));
        } else {
          batches.push(this.createBatch(batchPayments, scheduleId));
        }
      }
    }

    return batches;
  }

  /**
   * Group payments by currency
   */
  private groupByCurrency(payments: ScheduledPayment[]): ScheduledPayment[][] {
    const groups = new Map<string, ScheduledPayment[]>();
    
    for (const payment of payments) {
      const group = groups.get(payment.currency) || [];
      group.push(payment);
      groups.set(payment.currency, group);
    }
    
    return Array.from(groups.values());
  }

  /**
   * Split payments by value limit
   */
  private splitByValue(payments: ScheduledPayment[], maxValue: number): ScheduledPayment[][] {
    const batches: ScheduledPayment[][] = [];
    let currentBatch: ScheduledPayment[] = [];
    let currentValue = 0;
    
    for (const payment of payments) {
      if (currentValue + payment.amount > maxValue && currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentValue = 0;
      }
      
      currentBatch.push(payment);
      currentValue += payment.amount;
    }
    
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }
    
    return batches;
  }

  /**
   * Create batch object
   */
  private createBatch(payments: ScheduledPayment[], scheduleId: string): PaymentBatch {
    const batchId = `batch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // Set batch ID on payments
    for (const payment of payments) {
      payment.batchId = batchId;
    }
    
    return {
      id: batchId,
      scheduleId,
      currency: payments[0].currency,
      payments,
      totalAmount: payments.reduce((sum, p) => sum + p.amount, 0),
      status: 'pending',
      createdAt: new Date()
    };
  }

  /**
   * Check safety limits
   */
  private checkSafetyLimits(payments: ScheduledPayment[]): boolean {
    // Update daily stats if new day
    const today = new Date().toDateString();
    if (this.dailyStats.date !== today) {
      this.dailyStats = {
        payments: 0,
        value: 0,
        date: today
      };
    }

    const totalValue = payments.reduce((sum, p) => sum + p.amount, 0);
    
    // Check payment count
    if (this.dailyStats.payments + payments.length > this.config.safety.maxDailyPayments) {
      return false;
    }
    
    // Check value limit
    if (this.dailyStats.value + totalValue > this.config.safety.maxDailyValue) {
      return false;
    }
    
    // Check confirmation requirement
    if (this.config.safety.requireConfirmation && totalValue > this.config.safety.confirmationThreshold) {
      this.emit('confirmation:required', { payments, totalValue });
      return false;
    }
    
    return true;
  }

  /**
   * Start processing loop
   */
  private startProcessingLoop(): void {
    this.processInterval = setInterval(() => {
      this.processQueue();
    }, 1000); // Check every second
  }

  /**
   * Process payment queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.paymentQueue.pending.length === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      // Move payments to processing
      const toProcess = this.paymentQueue.pending.splice(0, 10); // Process up to 10 at a time
      this.paymentQueue.processing.push(...toProcess);

      // Process each payment
      for (const payment of toProcess) {
        await this.processPayment(payment);
      }

    } catch (err) {
      logger.error('Queue processing error', { error: err });
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process individual payment
   */
  private async processPayment(payment: ScheduledPayment): Promise<void> {
    payment.status = 'processing';
    payment.processedAt = new Date();
    payment.attempts++;

    try {
      // Execute payment (mock)
      const txId = await this.executePayment(payment);
      
      payment.status = 'completed';
      payment.completedAt = new Date();
      payment.txId = txId;
      
      // Move to completed
      this.paymentQueue.processing = this.paymentQueue.processing.filter(p => p.id !== payment.id);
      this.paymentQueue.completed.push(payment);
      
      // Update daily stats
      this.dailyStats.payments++;
      this.dailyStats.value += payment.amount;
      
      // Update batch if part of one
      if (payment.batchId) {
        this.updateBatchStatus(payment.batchId);
      }
      
      logger.info('Payment completed', {
        paymentId: payment.id,
        userId: payment.userId,
        amount: payment.amount,
        txId
      });
      
      this.emit('payment:completed', payment);
      
    } catch (err) {
      payment.status = 'failed';
      payment.error = err.message;
      
      // Move to failed or retry
      this.paymentQueue.processing = this.paymentQueue.processing.filter(p => p.id !== payment.id);
      
      if (payment.attempts < this.config.timing.retryAttempts) {
        // Schedule retry
        setTimeout(() => {
          payment.status = 'pending';
          this.paymentQueue.pending.push(payment);
        }, this.config.timing.retryDelay * 1000);
      } else {
        this.paymentQueue.failed.push(payment);
        this.emit('payment:failed', payment);
      }
      
      logger.error('Payment failed', {
        paymentId: payment.id,
        attempt: payment.attempts,
        error: err
      });
    }
  }

  /**
   * Execute payment (mock)
   */
  private async executePayment(payment: ScheduledPayment): Promise<string> {
    // This would integrate with actual payment system
    return `tx-${payment.id}`;
  }

  /**
   * Update batch status
   */
  private updateBatchStatus(batchId: string): void {
    const batch = this.batches.get(batchId);
    if (!batch) return;

    const completed = batch.payments.filter(p => p.status === 'completed').length;
    const failed = batch.payments.filter(p => p.status === 'failed').length;
    
    if (completed + failed === batch.payments.length) {
      batch.status = failed === 0 ? 'completed' : 'failed';
      batch.completedAt = new Date();
      
      this.emit('batch:completed', batch);
    }
  }

  /**
   * Calculate next run time
   */
  private calculateNextRun(schedule: PaymentSchedule): Date | undefined {
    const job = this.cronJobs.get(schedule.id);
    if (!job || typeof job.nextDate !== 'function') {
      return undefined;
    }

    try {
      return job.nextDate().toDate();
    } catch {
      return undefined;
    }
  }

  /**
   * Load pending payments
   */
  private async loadPendingPayments(): Promise<void> {
    // TODO: Load from persistent storage
    logger.info('Loading pending payments');
  }

  /**
   * Get schedule statistics
   */
  getScheduleStats(scheduleId: string): ScheduleStats | null {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) return null;

    const payments = [
      ...this.paymentQueue.completed,
      ...this.paymentQueue.failed
    ].filter(p => p.scheduleId === scheduleId);

    const successful = payments.filter(p => p.status === 'completed');
    const totalAmount = successful.reduce((sum, p) => sum + p.amount, 0);

    return {
      scheduleId,
      totalPayments: payments.length,
      successfulPayments: successful.length,
      failedPayments: payments.filter(p => p.status === 'failed').length,
      totalAmount,
      avgAmount: successful.length > 0 ? totalAmount / successful.length : 0,
      lastRun: schedule.lastRun,
      nextRun: schedule.nextRun
    };
  }

  /**
   * Get queue status
   */
  getQueueStatus(): any {
    return {
      pending: this.paymentQueue.pending.length,
      processing: this.paymentQueue.processing.length,
      completed: this.paymentQueue.completed.length,
      failed: this.paymentQueue.failed.length,
      batches: {
        total: this.batches.size,
        pending: Array.from(this.batches.values()).filter(b => b.status === 'pending').length,
        completed: Array.from(this.batches.values()).filter(b => b.status === 'completed').length
      },
      daily: {
        payments: this.dailyStats.payments,
        value: this.dailyStats.value,
        limit: {
          payments: this.config.safety.maxDailyPayments,
          value: this.config.safety.maxDailyValue
        }
      }
    };
  }

  /**
   * Confirm pending payments
   */
  confirmPayments(paymentIds: string[]): void {
    const confirmed = this.paymentQueue.pending.filter(p => paymentIds.includes(p.id));
    
    for (const payment of confirmed) {
      payment.status = 'pending'; // Re-queue for processing
    }
    
    logger.info('Payments confirmed', { count: confirmed.length });
    this.emit('payments:confirmed', confirmed);
  }

  /**
   * Cancel payments
   */
  cancelPayments(paymentIds: string[]): void {
    this.paymentQueue.pending = this.paymentQueue.pending.filter(
      p => !paymentIds.includes(p.id)
    );
    
    logger.info('Payments cancelled', { count: paymentIds.length });
    this.emit('payments:cancelled', paymentIds);
  }

  /**
   * Shutdown scheduler
   */
  shutdown(): void {
    // Stop all cron jobs
    for (const [scheduleId, job] of this.cronJobs) {
      this.deactivateSchedule(scheduleId);
    }

    // Stop processing
    if (this.processInterval) {
      clearInterval(this.processInterval);
    }

    // Save pending payments
    this.savePendingPayments();

    logger.info('Payment scheduler shutdown');
  }

  /**
   * Save pending payments
   */
  private savePendingPayments(): void {
    // TODO: Save to persistent storage
    const pending = this.paymentQueue.pending.length;
    if (pending > 0) {
      logger.info('Saving pending payments', { count: pending });
    }
  }
}

// Export types
export {
  SchedulerConfig,
  PaymentSchedule,
  ScheduledPayment,
  PaymentBatch,
  PaymentQueue,
  ScheduleStats
};
