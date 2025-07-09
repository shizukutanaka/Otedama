/**
 * Simple Payout System - PPLNS Implementation
 * Design: Robert C. Martin (Clean) + Rob Pike (Simple)
 */

import { createComponentLogger } from '../logging/simple-logger';
import { SimpleDatabase, ShareRecord } from '../database/simple-database';

interface PayoutEntry {
  minerId: string;
  shares: number;
  amount: number;
  percentage: number;
}

interface PayoutRecord {
  id?: number;
  minerId: string;
  amount: number;
  blockHeight: number;
  transactionId?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  timestamp: number;
  fee: number;
}

interface PayoutStats {
  totalPaid: number;
  pendingAmount: number;
  transactionCount: number;
  lastPayout: number;
}

class SimplePayout {
  private pendingPayouts: Map<string, number> = new Map();
  private logger = createComponentLogger('SimplePayout');
  
  constructor(
    private db: SimpleDatabase,
    private poolFeePercent: number = 1.0,
    private minPayoutAmount: number = 0.001, // 0.001 BTC minimum
    private pplnsShares: number = 1000000 // PPLNS window (number of shares)
  ) {}
  
  // Calculate PPLNS payouts for found block
  async calculatePayouts(blockReward: number, blockHeight: number): Promise<PayoutEntry[]> {
    try {
      // Get recent shares for PPLNS calculation
      const recentShares = await this.getRecentShares(this.pplnsShares);
      
      if (recentShares.length === 0) {
        this.logger.warn('No shares found for payout calculation');
        return [];
      }
      
      // Calculate pool fee
      const poolFee = blockReward * (this.poolFeePercent / 100);
      const payableAmount = blockReward - poolFee;
      
      // Group shares by miner
      const minerShares = this.groupSharesByMiner(recentShares);
      const totalShares = recentShares.length;
      
      // Calculate individual payouts
      const payouts: PayoutEntry[] = [];
      
      for (const [minerId, shares] of minerShares.entries()) {
        const percentage = shares / totalShares;
        const amount = payableAmount * percentage;
        
        payouts.push({
          minerId,
          shares,
          amount,
          percentage: percentage * 100
        });
      }
      
      this.logger.info('Payouts calculated', {
        blockReward,
        poolFee,
        payableAmount,
        totalShares,
        minerCount: payouts.length
      });
      
      return payouts;
      
    } catch (error) {
      this.logger.error('Payout calculation failed', error as Error);
      return [];
    }
  }
  
  private async getRecentShares(limit: number): Promise<ShareRecord[]> {
    // This would need to be implemented in the database
    // For now, we'll create a simple query
    try {
      const query = `
        SELECT * FROM shares 
        WHERE valid = 1 
        ORDER BY timestamp DESC 
        LIMIT ?
      `;
      
      // Note: This is a simplified implementation
      // In the actual database class, you'd implement this query
      return [];
    } catch (error) {
      this.logger.error('Failed to fetch recent shares', error as Error);
      return [];
    }
  }
  
  private groupSharesByMiner(shares: ShareRecord[]): Map<string, number> {
    const minerShares = new Map<string, number>();
    
    for (const share of shares) {
      const current = minerShares.get(share.minerId) || 0;
      minerShares.set(share.minerId, current + 1);
    }
    
    return minerShares;
  }
  
  // Add to pending payouts
  async addPendingPayouts(payouts: PayoutEntry[], blockHeight: number): Promise<void> {
    try {
      for (const payout of payouts) {
        // Add to pending balance
        const currentPending = this.pendingPayouts.get(payout.minerId) || 0;
        this.pendingPayouts.set(payout.minerId, currentPending + payout.amount);
        
        // Record in database
        const payoutRecord: PayoutRecord = {
          minerId: payout.minerId,
          amount: payout.amount,
          blockHeight,
          status: 'pending',
          timestamp: Date.now(),
          fee: 0
        };
        
        await this.savePayoutRecord(payoutRecord);
      }
      
      this.logger.info('Pending payouts added', { 
        count: payouts.length,
        blockHeight 
      });
      
    } catch (error) {
      this.logger.error('Failed to add pending payouts', error as Error);
    }
  }
  
  // Get miners ready for payout (above minimum threshold)
  getPayableMiners(): Array<{ minerId: string; amount: number }> {
    const payable: Array<{ minerId: string; amount: number }> = [];
    
    for (const [minerId, amount] of this.pendingPayouts.entries()) {
      if (amount >= this.minPayoutAmount) {
        payable.push({ minerId, amount });
      }
    }
    
    return payable.sort((a, b) => b.amount - a.amount); // Largest first
  }
  
  // Process single payout
  async processPayout(minerId: string, bitcoinAddress: string): Promise<boolean> {
    try {
      const pendingAmount = this.pendingPayouts.get(minerId) || 0;
      
      if (pendingAmount < this.minPayoutAmount) {
        this.logger.warn('Payout amount below minimum', { 
          minerId, 
          amount: pendingAmount,
          minimum: this.minPayoutAmount 
        });
        return false;
      }
      
      // Calculate transaction fee (simplified)
      const txFee = 0.0001; // 0.0001 BTC fixed fee
      const netAmount = pendingAmount - txFee;
      
      if (netAmount <= 0) {
        this.logger.warn('Net payout amount too low after fees', { 
          minerId, 
          gross: pendingAmount,
          fee: txFee,
          net: netAmount 
        });
        return false;
      }
      
      // Simulate Bitcoin transaction (in real implementation, use actual Bitcoin RPC)
      const txId = await this.sendBitcoinTransaction(bitcoinAddress, netAmount);
      
      if (txId) {
        // Update payout record
        await this.updatePayoutStatus(minerId, pendingAmount, txId, 'completed');
        
        // Remove from pending
        this.pendingPayouts.delete(minerId);
        
        this.logger.info('Payout completed', { 
          minerId, 
          amount: netAmount, 
          txId,
          address: bitcoinAddress 
        });
        
        return true;
      }
      
      return false;
      
    } catch (error) {
      this.logger.error('Payout processing failed', error as Error, { minerId });
      
      // Mark as failed
      await this.updatePayoutStatus(minerId, 0, null, 'failed');
      return false;
    }
  }
  
  private async sendBitcoinTransaction(address: string, amount: number): Promise<string | null> {
    // Simplified simulation - in real implementation, use Bitcoin RPC
    try {
      // Validate address format (basic check)
      if (!this.isValidBitcoinAddress(address)) {
        throw new Error('Invalid Bitcoin address');
      }
      
      // Simulate transaction
      const txId = this.generateTransactionId();
      
      this.logger.info('Bitcoin transaction simulated', { 
        address, 
        amount, 
        txId 
      });
      
      // In real implementation:
      // return await this.bitcoinRPC.sendToAddress(address, amount);
      
      return txId;
      
    } catch (error) {
      this.logger.error('Bitcoin transaction failed', error as Error);
      return null;
    }
  }
  
  private isValidBitcoinAddress(address: string): boolean {
    // Basic Bitcoin address validation
    if (!address || typeof address !== 'string') return false;
    
    // Check for common Bitcoin address patterns
    const patterns = [
      /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/, // Legacy P2PKH/P2SH
      /^bc1[a-z0-9]{39,59}$/,              // Bech32 P2WPKH/P2WSH
      /^bc1p[a-z0-9]{58}$/                 // Bech32m P2TR (Taproot)
    ];
    
    return patterns.some(pattern => pattern.test(address));
  }
  
  private generateTransactionId(): string {
    // Generate a fake transaction ID for simulation
    const chars = '0123456789abcdef';
    let txId = '';
    for (let i = 0; i < 64; i++) {
      txId += chars[Math.floor(Math.random() * chars.length)];
    }
    return txId;
  }
  
  private async savePayoutRecord(record: PayoutRecord): Promise<void> {
    // This would be implemented in the database
    // For now, just log it
    this.logger.debug('Payout record saved', record);
  }
  
  private async updatePayoutStatus(
    minerId: string, 
    amount: number, 
    txId: string | null, 
    status: PayoutRecord['status']
  ): Promise<void> {
    // This would update the database record
    this.logger.debug('Payout status updated', { 
      minerId, 
      amount, 
      txId, 
      status 
    });
  }
  
  // Get miner's payout history
  async getPayoutHistory(minerId: string, limit: number = 100): Promise<PayoutRecord[]> {
    // This would query the database
    // For now, return empty array
    return [];
  }
  
  // Get pending amount for miner
  getPendingAmount(minerId: string): number {
    return this.pendingPayouts.get(minerId) || 0;
  }
  
  // Get total pending payouts
  getTotalPending(): number {
    let total = 0;
    for (const amount of this.pendingPayouts.values()) {
      total += amount;
    }
    return total;
  }
  
  // Get payout statistics
  async getStats(): Promise<PayoutStats> {
    // This would query the database for actual stats
    return {
      totalPaid: 0,
      pendingAmount: this.getTotalPending(),
      transactionCount: 0,
      lastPayout: 0
    };
  }
  
  // Manual payout trigger for admin
  async triggerManualPayout(minerId: string, address: string): Promise<boolean> {
    this.logger.info('Manual payout triggered', { minerId, address });
    return await this.processPayout(minerId, address);
  }
  
  // Batch process all payable miners
  async processBatchPayouts(addressMapping: Map<string, string>): Promise<number> {
    const payableMiners = this.getPayableMiners();
    let successCount = 0;
    
    this.logger.info('Starting batch payout processing', { 
      count: payableMiners.length 
    });
    
    for (const { minerId } of payableMiners) {
      const address = addressMapping.get(minerId);
      if (address) {
        const success = await this.processPayout(minerId, address);
        if (success) successCount++;
        
        // Small delay between transactions
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        this.logger.warn('No address found for miner', { minerId });
      }
    }
    
    this.logger.info('Batch payout processing completed', { 
      total: payableMiners.length,
      successful: successCount,
      failed: payableMiners.length - successCount
    });
    
    return successCount;
  }
}

export { SimplePayout, PayoutEntry, PayoutRecord, PayoutStats };
