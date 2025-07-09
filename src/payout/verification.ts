// Payout verification system (Uncle Bob's clean architecture)
import { Share } from '../domain/share';
import { Payout, PPLNSCalculator } from './pplns';

export interface PayoutVerificationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  totalPayout: number;
  minerCount: number;
}

export class PayoutVerifier {
  constructor(
    private calculator: PPLNSCalculator,
    private tolerancePercent: number = 0.001 // 0.1% tolerance for rounding
  ) {}
  
  // Verify payout calculation
  verify(
    shares: Share[],
    payouts: Payout[],
    blockReward: number,
    poolFee: number
  ): PayoutVerificationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // Check 1: Total payout amount
    const expectedTotal = blockReward * (1 - poolFee / 100);
    const actualTotal = payouts.reduce((sum, p) => sum + p.amount, 0);
    const difference = Math.abs(expectedTotal - actualTotal);
    const tolerance = expectedTotal * this.tolerancePercent;
    
    if (difference > tolerance) {
      errors.push(
        `Total payout mismatch: expected ${expectedTotal.toFixed(8)}, ` +
        `got ${actualTotal.toFixed(8)} (diff: ${difference.toFixed(8)})`
      );
    }
    
    // Check 2: No negative payouts
    const negativePayouts = payouts.filter(p => p.amount < 0);
    if (negativePayouts.length > 0) {
      errors.push(
        `Found ${negativePayouts.length} negative payouts: ` +
        negativePayouts.map(p => `${p.minerId}: ${p.amount}`).join(', ')
      );
    }
    
    // Check 3: All miners with shares get paid
    const minerShares = new Map<string, number>();
    for (const share of shares) {
      minerShares.set(
        share.minerId,
        (minerShares.get(share.minerId) || 0) + share.difficulty
      );
    }
    
    const paidMiners = new Set(payouts.map(p => p.minerId));
    const unpaidMiners: string[] = [];
    
    for (const [minerId, difficulty] of minerShares) {
      if (!paidMiners.has(minerId) && difficulty > 0) {
        unpaidMiners.push(minerId);
      }
    }
    
    if (unpaidMiners.length > 0) {
      warnings.push(
        `${unpaidMiners.length} miners with shares but no payout: ` +
        unpaidMiners.slice(0, 5).join(', ') +
        (unpaidMiners.length > 5 ? '...' : '')
      );
    }
    
    // Check 4: No duplicate payouts
    const duplicateCheck = new Set<string>();
    const duplicates: string[] = [];
    
    for (const payout of payouts) {
      if (duplicateCheck.has(payout.minerId)) {
        duplicates.push(payout.minerId);
      }
      duplicateCheck.add(payout.minerId);
    }
    
    if (duplicates.length > 0) {
      errors.push(
        `Found duplicate payouts for miners: ${duplicates.join(', ')}`
      );
    }
    
    // Check 5: Recalculate and compare
    const recalculated = this.calculator.calculate(shares, blockReward);
    const recalcMap = new Map(recalculated.map(p => [p.minerId, p.amount]));
    
    for (const payout of payouts) {
      const expected = recalcMap.get(payout.minerId) || 0;
      const diff = Math.abs(expected - payout.amount);
      
      if (diff > expected * this.tolerancePercent) {
        errors.push(
          `Payout mismatch for ${payout.minerId}: ` +
          `expected ${expected.toFixed(8)}, got ${payout.amount.toFixed(8)}`
        );
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      totalPayout: actualTotal,
      minerCount: payouts.length
    };
  }
  
  // Verify individual miner's payout
  verifyMinerPayout(
    minerId: string,
    shares: Share[],
    payout: number,
    blockReward: number
  ): { valid: boolean; expected: number; difference: number } {
    // Filter miner's shares
    const minerShares = shares.filter(s => s.minerId === minerId);
    const minerDifficulty = minerShares.reduce((sum, s) => sum + s.difficulty, 0);
    
    // Calculate total difficulty
    const totalDifficulty = shares.reduce((sum, s) => sum + s.difficulty, 0);
    
    // Calculate expected payout
    const expected = totalDifficulty > 0
      ? (minerDifficulty / totalDifficulty) * blockReward
      : 0;
    
    const difference = Math.abs(expected - payout);
    const valid = difference <= expected * this.tolerancePercent;
    
    return { valid, expected, difference };
  }
  
  // Audit trail for payouts
  generateAuditReport(
    shares: Share[],
    payouts: Payout[],
    blockReward: number,
    blockHeight: number
  ): string {
    const report: string[] = [];
    const timestamp = new Date().toISOString();
    
    report.push('=== PAYOUT AUDIT REPORT ===');
    report.push(`Generated: ${timestamp}`);
    report.push(`Block Height: ${blockHeight}`);
    report.push(`Block Reward: ${blockReward} BTC`);
    report.push('');
    
    // Share statistics
    report.push('Share Statistics:');
    report.push(`Total Shares: ${shares.length}`);
    
    const minerStats = new Map<string, { shares: number; difficulty: number }>();
    for (const share of shares) {
      const stats = minerStats.get(share.minerId) || { shares: 0, difficulty: 0 };
      stats.shares++;
      stats.difficulty += share.difficulty;
      minerStats.set(share.minerId, stats);
    }
    
    report.push(`Unique Miners: ${minerStats.size}`);
    report.push('');
    
    // Payout details
    report.push('Payout Details:');
    report.push(`Total Payouts: ${payouts.length}`);
    report.push(`Total Amount: ${payouts.reduce((sum, p) => sum + p.amount, 0).toFixed(8)} BTC`);
    report.push('');
    
    // Top miners
    const sortedPayouts = [...payouts].sort((a, b) => b.amount - a.amount);
    report.push('Top 10 Miners:');
    for (let i = 0; i < Math.min(10, sortedPayouts.length); i++) {
      const payout = sortedPayouts[i];
      const stats = minerStats.get(payout.minerId);
      const percentage = (payout.amount / blockReward) * 100;
      
      report.push(
        `${i + 1}. ${payout.minerId}: ${payout.amount.toFixed(8)} BTC ` +
        `(${percentage.toFixed(2)}%) - ${stats?.shares || 0} shares`
      );
    }
    
    report.push('');
    report.push('=== END OF REPORT ===');
    
    return report.join('\n');
  }
}

// Double-entry bookkeeping for payouts
export class PayoutLedger {
  private entries: Array<{
    timestamp: Date;
    type: 'credit' | 'debit';
    account: string;
    amount: number;
    reference: string;
    balance: number;
  }> = [];
  
  private balances = new Map<string, number>();
  
  // Record block reward credit
  creditBlockReward(amount: number, blockHeight: number): void {
    this.addEntry('credit', 'pool', amount, `block:${blockHeight}`);
  }
  
  // Record pool fee debit
  debitPoolFee(amount: number, blockHeight: number): void {
    this.addEntry('debit', 'pool', amount, `fee:${blockHeight}`);
    this.addEntry('credit', 'pool_fees', amount, `fee:${blockHeight}`);
  }
  
  // Record miner payout debit
  debitMinerPayout(minerId: string, amount: number, blockHeight: number): void {
    this.addEntry('debit', 'pool', amount, `payout:${blockHeight}:${minerId}`);
    this.addEntry('credit', minerId, amount, `payout:${blockHeight}`);
  }
  
  private addEntry(
    type: 'credit' | 'debit',
    account: string,
    amount: number,
    reference: string
  ): void {
    const currentBalance = this.balances.get(account) || 0;
    const newBalance = type === 'credit'
      ? currentBalance + amount
      : currentBalance - amount;
    
    this.balances.set(account, newBalance);
    
    this.entries.push({
      timestamp: new Date(),
      type,
      account,
      amount,
      reference,
      balance: newBalance
    });
  }
  
  // Check if books balance
  isBalanced(): boolean {
    let totalDebits = 0;
    let totalCredits = 0;
    
    for (const entry of this.entries) {
      if (entry.type === 'debit') {
        totalDebits += entry.amount;
      } else {
        totalCredits += entry.amount;
      }
    }
    
    // Should be balanced to within rounding error
    return Math.abs(totalDebits - totalCredits) < 0.00000001;
  }
  
  getBalance(account: string): number {
    return this.balances.get(account) || 0;
  }
  
  getEntries(account?: string): typeof this.entries {
    if (account) {
      return this.entries.filter(e => e.account === account);
    }
    return [...this.entries];
  }
}
