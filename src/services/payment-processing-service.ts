// Payment processing service
// Handles scheduled payment processing with proper error handling

import { Container } from '../di/container';
import { Logger } from '../logging/logger';
import { ICompletePoolConfig } from '../config/pool/config-loader';
import { EnhancedMiningPoolCore } from '../core/enhanced-pool';
import { FeeCalculator } from '../payments/fee-calculator';
import { BatchProcessor } from '../payments/batch-processor';
import { PaymentHistory } from '../payments/payment-history';
import { EventStreamingManager } from '../streaming/event-streaming';
import { AlertManager } from '../alerts/alert-manager';

export class PaymentProcessingService {
  private container: Container;
  private logger: Logger;
  private config: ICompletePoolConfig;
  private intervalId?: NodeJS.Timeout;
  
  constructor(container: Container, config: ICompletePoolConfig) {
    this.container = container;
    this.config = config;
    this.logger = new Logger('PaymentProcessor');
  }
  
  /**
   * Start the payment processing service
   */
  start(): void {
    this.logger.info(`Starting payment processor (interval: ${this.config.paymentInterval}s)`);
    
    // Process payments at configured interval
    this.intervalId = setInterval(
      () => this.processPayments(),
      this.config.paymentInterval * 1000
    );
    
    // Process initial payment after a short delay
    setTimeout(() => this.processPayments(), 10000);
  }
  
  /**
   * Stop the payment processing service
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.logger.info('Payment processor stopped');
  }
  
  /**
   * Process payments
   */
  private async processPayments(): Promise<void> {
    try {
      this.logger.info('Processing payments...');
      
      const core = this.container.get<EnhancedMiningPoolCore>('core');
      const feeCalculator = this.container.get<FeeCalculator>('feeCalculator');
      const batchProcessor = this.container.get<BatchProcessor>('batchProcessor');
      const paymentHistory = this.container.get<PaymentHistory>('paymentHistory');
      const eventStreaming = this.container.get<EventStreamingManager>('eventStreaming');
      
      if (!core || !feeCalculator || !batchProcessor || !paymentHistory) {
        throw new Error('Required services not available');
      }
      
      // Get unpaid shares
      const shares = await core.getUnpaidShares();
      if (shares.length === 0) {
        this.logger.info('No unpaid shares to process');
        return;
      }
      
      // Calculate rewards
      const rewards = core.calculateRewards(shares);
      
      // Apply fees and filter by minimum payout
      const payments: Array<{ address: string; amount: number }> = [];
      const processedAddresses = new Map<string, number>();
      
      for (const [address, amount] of rewards) {
        const fee = feeCalculator.calculateFee(amount);
        const netAmount = amount - fee;
        
        if (netAmount >= this.config.minPayout) {
          payments.push({ address, amount: netAmount });
          processedAddresses.set(address, netAmount);
        }
      }
      
      if (payments.length === 0) {
        this.logger.info('No payments meet minimum payout threshold');
        return;
      }
      
      // Create batch payment
      const txid = await batchProcessor.processBatch(payments);
      
      // Record payment history
      for (const [address, amount] of processedAddresses) {
        const addressShares = shares.filter(s => s.address === address);
        await paymentHistory.recordPayment({
          address,
          amount,
          txid,
          timestamp: Date.now(),
          shares: addressShares.length
        });
      }
      
      // Mark shares as paid
      const shareIds = shares
        .filter(s => processedAddresses.has(s.address))
        .map(s => s.id);
      await core.markSharesPaid(shareIds);
      
      const totalAmount = Array.from(processedAddresses.values())
        .reduce((a, b) => a + b, 0);
      
      this.logger.info(`Payment processed: ${txid}, recipients: ${payments.length}, total: ${totalAmount}`);
      
      // Publish payment event
      if (eventStreaming) {
        await this.publishPaymentEvent(eventStreaming, {
          txid,
          recipients: payments.length,
          totalAmount
        });
      }
      
    } catch (error) {
      this.logger.error('Payment processing error:', error as Error);
      this.sendAlert('Payment Processing Error', (error as Error).message);
    }
  }
  
  /**
   * Publish payment event to streaming service
   */
  private async publishPaymentEvent(
    eventStreaming: EventStreamingManager,
    data: any
  ): Promise<void> {
    try {
      await eventStreaming.publishEvent('payment-events', {
        type: 'payment.processed',
        data
      });
    } catch (error) {
      this.logger.error('Failed to publish payment event:', error as Error);
    }
  }
  
  /**
   * Send alert if alert manager is available
   */
  private sendAlert(title: string, message: string): void {
    const alertManager = this.container.get<AlertManager>('alertManager');
    if (alertManager) {
      alertManager.sendAlert(title, message).catch(error => {
        this.logger.error('Failed to send alert:', error);
      });
    }
  }
}
