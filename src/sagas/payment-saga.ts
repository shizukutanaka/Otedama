import { DomainEvent, getEventStore } from '../database/event-store';
import { PoolDatabase, getPoolDatabase } from '../database/pool-database';
// In a real app, you'd have a dedicated client for blockchain interactions.
// We'll simulate it for now.
import { BlockchainClient } from '../services/blockchain-client'; 

/**
 * Manages the long-running process for handling cryptocurrency payments.
 * This is an implementation of the Saga pattern.
 */
export class PaymentSaga {
  private eventStore = getEventStore();
  private poolDatabase = getPoolDatabase();
  private blockchainClient: BlockchainClient;

  constructor() {
    // In a real DI system, this would be injected.
    this.blockchainClient = new BlockchainClient();
  }

  /**
   * Handles an incoming domain event and routes it to the appropriate logic.
   * This acts as the entry point for the saga.
   * @param event The domain event that might trigger a saga step.
   */
  public async handleEvent(event: DomainEvent): Promise<void> {
    if (event.eventType === 'PaymentCreated') {
      await this.onPaymentCreated(event);
    }
    // Other events, like 'BlockchainTxConfirmed', would be handled here.
  }

  /**
   * Step 1: Triggered when a payment is first created.
   * This step initiates the process of sending the payment on the blockchain.
   */
  private async onPaymentCreated(event: DomainEvent): Promise<void> {
    const payment = event.payload;
    const paymentId = payment.id;
    const streamId = `payment-${paymentId}`;

    console.log(`[PaymentSaga] Starting payment process for ID: ${paymentId}`);

    try {
      // 1. Mark payment as 'processing' in the read model
      await this.poolDatabase.updatePayment(paymentId, { status: 'processing' });

      // 2. Call the external blockchain service to send the funds
      const txHash = await this.blockchainClient.sendPayment(payment.minerAddress, payment.amount);
      console.log(`[PaymentSaga] Payment ${paymentId} sent, TxHash: ${txHash}`);

      // 3. Record the successful transaction hash and mark as 'completed'
      // In a real-world scenario, you'd wait for confirmations.
      // For simplicity, we'll mark as completed immediately.
      await this.poolDatabase.updatePayment(paymentId, { 
        status: 'completed',
        txHash: txHash,
        processedAt: Date.now()
      });

      console.log(`[PaymentSaga] Payment ${paymentId} completed successfully.`);

    } catch (error: any) {
      console.error(`[PaymentSaga] Failed to process payment ${paymentId}:`, error);

      // 4. This is the 'compensating transaction'.
      // If anything fails, mark the payment as 'failed' in the read model.
      await this.poolDatabase.updatePayment(paymentId, { 
        status: 'failed',
        error: error.message,
        processedAt: Date.now()
      });
    }
  }
}

// Singleton instance for the PaymentSaga
let paymentSaga: PaymentSaga | null = null;

export function getPaymentSaga(): PaymentSaga {
  if (!paymentSaga) {
    paymentSaga = new PaymentSaga();
  }
  return paymentSaga;
}
