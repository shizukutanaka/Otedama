// Simple PPLNS implementation (Uncle Bob's clean architecture)
import { Share } from '../domain/share';

export interface Payout {
  minerId: string;
  amount: number;
}

export interface PayoutCalculator {
  calculate(shares: Share[], blockReward: number): Payout[];
}

// Pay Per Last N Shares - simple and fair
export class PPLNSCalculator implements PayoutCalculator {
  private readonly N: number;
  
  constructor(n: number = 1000000) { // Default to last 1M shares
    this.N = n;
  }
  
  calculate(shares: Share[], blockReward: number): Payout[] {
    // Take last N shares
    const recentShares = shares.slice(-this.N);
    
    if (recentShares.length === 0) {
      return [];
    }
    
    // Calculate total difficulty
    const totalDifficulty = recentShares.reduce(
      (sum, share) => sum + share.difficulty,
      0
    );
    
    // Group shares by miner
    const minerShares = new Map<string, number>();
    for (const share of recentShares) {
      const current = minerShares.get(share.minerId) || 0;
      minerShares.set(share.minerId, current + share.difficulty);
    }
    
    // Calculate payouts
    const payouts: Payout[] = [];
    for (const [minerId, difficulty] of minerShares) {
      const amount = (difficulty / totalDifficulty) * blockReward;
      if (amount > 0) {
        payouts.push({ minerId, amount });
      }
    }
    
    return payouts;
  }
}

// Simple payout tracking
export class PayoutTracker {
  private pendingPayouts = new Map<string, number>();
  private paidPayouts = new Map<string, number>();
  
  addPending(payouts: Payout[]): void {
    for (const payout of payouts) {
      const current = this.pendingPayouts.get(payout.minerId) || 0;
      this.pendingPayouts.set(payout.minerId, current + payout.amount);
    }
  }
  
  getPending(minerId: string): number {
    return this.pendingPayouts.get(minerId) || 0;
  }
  
  markPaid(minerId: string, amount: number): void {
    const pending = this.pendingPayouts.get(minerId) || 0;
    const newPending = Math.max(0, pending - amount);
    
    if (newPending > 0) {
      this.pendingPayouts.set(minerId, newPending);
    } else {
      this.pendingPayouts.delete(minerId);
    }
    
    const totalPaid = this.paidPayouts.get(minerId) || 0;
    this.paidPayouts.set(minerId, totalPaid + amount);
  }
  
  getTotalPaid(minerId: string): number {
    return this.paidPayouts.get(minerId) || 0;
  }
  
  // Get miners with pending payouts above threshold
  getPayableMiners(threshold: number): Array<{minerId: string, amount: number}> {
    const payable: Array<{minerId: string, amount: number}> = [];
    
    for (const [minerId, amount] of this.pendingPayouts) {
      if (amount >= threshold) {
        payable.push({ minerId, amount });
      }
    }
    
    return payable;
  }
}
