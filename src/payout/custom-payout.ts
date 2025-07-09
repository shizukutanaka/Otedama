// Custom payout schemes for flexible payment options (Martin clean architecture)
import { EventEmitter } from 'events';
import { createComponentLogger } from '../logging/logger';

const logger = createComponentLogger('custom-payout');

// Payout scheme types
export enum PayoutScheme {
  PPLNS = 'pplns',           // Pay Per Last N Shares
  PPS = 'pps',               // Pay Per Share
  PROP = 'prop',             // Proportional
  SOLO = 'solo',             // Solo mining
  SCORE = 'score',           // Score based
  PPLNST = 'pplnst',         // PPLNS with time decay
  RSMPPS = 'rsmpps',         // Recent Shared Maximum PPS
  CPPSRB = 'cppsrb',         // Capped PPS with Recent Backpay
  CUSTOM = 'custom'          // Custom scheme
}

// Share window configuration
export interface ShareWindow {
  type: 'count' | 'time' | 'blocks';
  value: number;
  decay?: {
    enabled: boolean;
    halfLife: number; // seconds
  };
}

// Payout configuration
export interface PayoutConfig {
  scheme: PayoutScheme;
  window: ShareWindow;
  minPayout: number;
  maxPayout?: number;
  fee: number; // percentage
  bonus?: {
    blockFinder: number; // percentage of block reward
    loyalty: number; // percentage bonus per day
  };
  penalties?: {
    hopperPenalty: number; // percentage
    inactivityThreshold: number; // seconds
  };
}

// Share with metadata
export interface ShareData {
  minerId: string;
  difficulty: number;
  timestamp: number;
  blockHeight?: number;
  score?: number;
  valid: boolean;
}

// Payout calculation result
export interface PayoutResult {
  minerId: string;
  amount: number;
  shares: number;
  score?: number;
  bonus?: number;
  penalty?: number;
  details?: any;
}

// Base payout calculator
export abstract class PayoutCalculator {
  protected config: PayoutConfig;
  
  constructor(config: PayoutConfig) {
    this.config = config;
  }
  
  // Calculate payouts for miners
  abstract calculate(
    shares: ShareData[],
    blockReward: number,
    blockFinder?: string
  ): PayoutResult[];
  
  // Get scheme info
  abstract getInfo(): {
    name: string;
    description: string;
    advantages: string[];
    disadvantages: string[];
  };
  
  // Apply fees
  protected applyFees(amount: number): number {
    return amount * (1 - this.config.fee / 100);
  }
  
  // Apply bonuses
  protected applyBonuses(
    result: PayoutResult,
    isBlockFinder: boolean,
    loyaltyDays: number
  ): void {
    if (!this.config.bonus) return;
    
    // Block finder bonus
    if (isBlockFinder && this.config.bonus.blockFinder > 0) {
      result.bonus = (result.bonus || 0) + 
        result.amount * (this.config.bonus.blockFinder / 100);
    }
    
    // Loyalty bonus
    if (loyaltyDays > 0 && this.config.bonus.loyalty > 0) {
      const loyaltyBonus = Math.min(
        loyaltyDays * this.config.bonus.loyalty,
        50 // Max 50% bonus
      );
      result.bonus = (result.bonus || 0) + 
        result.amount * (loyaltyBonus / 100);
    }
  }
  
  // Apply penalties
  protected applyPenalties(
    result: PayoutResult,
    inactiveSeconds: number
  ): void {
    if (!this.config.penalties) return;
    
    // Inactivity penalty
    if (inactiveSeconds > this.config.penalties.inactivityThreshold) {
      const penaltyRate = Math.min(
        this.config.penalties.hopperPenalty,
        50 // Max 50% penalty
      );
      result.penalty = (result.penalty || 0) + 
        result.amount * (penaltyRate / 100);
    }
  }
}

// PPLNS calculator
export class PPLNSCalculator extends PayoutCalculator {
  calculate(
    shares: ShareData[],
    blockReward: number,
    blockFinder?: string
  ): PayoutResult[] {
    // Get shares in window
    const windowShares = this.getSharesInWindow(shares);
    if (windowShares.length === 0) return [];
    
    // Calculate total difficulty
    const totalDifficulty = windowShares.reduce(
      (sum, share) => sum + share.difficulty,
      0
    );
    
    // Group by miner
    const minerShares = new Map<string, {
      difficulty: number;
      count: number;
      lastShare: number;
    }>();
    
    for (const share of windowShares) {
      const miner = minerShares.get(share.minerId) || {
        difficulty: 0,
        count: 0,
        lastShare: 0
      };
      
      miner.difficulty += share.difficulty;
      miner.count++;
      miner.lastShare = Math.max(miner.lastShare, share.timestamp);
      
      minerShares.set(share.minerId, miner);
    }
    
    // Calculate payouts
    const results: PayoutResult[] = [];
    const netReward = this.applyFees(blockReward);
    
    for (const [minerId, data] of minerShares) {
      const shareRatio = data.difficulty / totalDifficulty;
      const amount = netReward * shareRatio;
      
      const result: PayoutResult = {
        minerId,
        amount,
        shares: data.count,
        score: data.difficulty
      };
      
      // Apply bonuses
      this.applyBonuses(
        result,
        minerId === blockFinder,
        0 // Would calculate from miner history
      );
      
      // Apply penalties
      const inactiveTime = Date.now() - data.lastShare;
      this.applyPenalties(result, inactiveTime / 1000);
      
      // Final amount
      result.amount += (result.bonus || 0) - (result.penalty || 0);
      
      if (result.amount >= this.config.minPayout) {
        results.push(result);
      }
    }
    
    return results;
  }
  
  private getSharesInWindow(shares: ShareData[]): ShareData[] {
    const { type, value, decay } = this.config.window;
    
    switch (type) {
      case 'count':
        // Last N shares
        return shares.slice(-value);
        
      case 'time':
        // Shares in last N seconds
        const cutoff = Date.now() - (value * 1000);
        return shares.filter(s => s.timestamp > cutoff);
        
      case 'blocks':
        // Shares since last N blocks
        const minHeight = Math.max(...shares.map(s => s.blockHeight || 0)) - value;
        return shares.filter(s => (s.blockHeight || 0) > minHeight);
        
      default:
        return shares;
    }
  }
  
  getInfo() {
    return {
      name: 'Pay Per Last N Shares',
      description: 'Rewards miners based on shares submitted in a rolling window',
      advantages: [
        'Hop-proof - discourages pool hopping',
        'Fair distribution based on recent contributions',
        'Predictable payouts'
      ],
      disadvantages: [
        'Variance in payouts',
        'New miners need to build up shares',
        'Complex to understand'
      ]
    };
  }
}

// PPS calculator
export class PPSCalculator extends PayoutCalculator {
  private ppsRate: number;
  
  constructor(config: PayoutConfig, networkDifficulty: number, blockReward: number) {
    super(config);
    // Calculate PPS rate based on network difficulty
    this.ppsRate = blockReward / networkDifficulty;
  }
  
  calculate(
    shares: ShareData[],
    blockReward: number,
    blockFinder?: string
  ): PayoutResult[] {
    // Group by miner
    const minerData = new Map<string, {
      difficulty: number;
      shares: number;
    }>();
    
    for (const share of shares) {
      if (!share.valid) continue;
      
      const data = minerData.get(share.minerId) || {
        difficulty: 0,
        shares: 0
      };
      
      data.difficulty += share.difficulty;
      data.shares++;
      
      minerData.set(share.minerId, data);
    }
    
    // Calculate payouts
    const results: PayoutResult[] = [];
    
    for (const [minerId, data] of minerData) {
      const amount = this.applyFees(data.difficulty * this.ppsRate);
      
      const result: PayoutResult = {
        minerId,
        amount,
        shares: data.shares,
        details: {
          ppsRate: this.ppsRate,
          totalDifficulty: data.difficulty
        }
      };
      
      if (result.amount >= this.config.minPayout) {
        results.push(result);
      }
    }
    
    return results;
  }
  
  getInfo() {
    return {
      name: 'Pay Per Share',
      description: 'Fixed payment for each valid share regardless of blocks found',
      advantages: [
        'Predictable income',
        'No variance',
        'Instant payments possible',
        'Easy to understand'
      ],
      disadvantages: [
        'Pool takes all the risk',
        'Higher fees typically',
        'No block finding bonus'
      ]
    };
  }
}

// Proportional calculator
export class ProportionalCalculator extends PayoutCalculator {
  calculate(
    shares: ShareData[],
    blockReward: number,
    blockFinder?: string
  ): PayoutResult[] {
    // Only count shares in current round
    const roundShares = this.getCurrentRoundShares(shares);
    
    // Calculate total difficulty
    const totalDifficulty = roundShares.reduce(
      (sum, share) => sum + share.difficulty,
      0
    );
    
    // Group by miner
    const minerShares = new Map<string, number>();
    
    for (const share of roundShares) {
      const current = minerShares.get(share.minerId) || 0;
      minerShares.set(share.minerId, current + share.difficulty);
    }
    
    // Calculate payouts
    const results: PayoutResult[] = [];
    const netReward = this.applyFees(blockReward);
    
    for (const [minerId, difficulty] of minerShares) {
      const amount = netReward * (difficulty / totalDifficulty);
      
      if (amount >= this.config.minPayout) {
        results.push({
          minerId,
          amount,
          shares: roundShares.filter(s => s.minerId === minerId).length
        });
      }
    }
    
    return results;
  }
  
  private getCurrentRoundShares(shares: ShareData[]): ShareData[] {
    // Find last block height
    const lastBlockHeight = Math.max(...shares.map(s => s.blockHeight || 0));
    
    // Return shares since last block
    return shares.filter(s => 
      !s.blockHeight || s.blockHeight === lastBlockHeight
    );
  }
  
  getInfo() {
    return {
      name: 'Proportional',
      description: 'Rewards based on shares in current round',
      advantages: [
        'Simple to understand',
        'Fair for consistent miners',
        'Low pool risk'
      ],
      disadvantages: [
        'Vulnerable to pool hopping',
        'High variance',
        'Unfair to late joiners in long rounds'
      ]
    };
  }
}

// Score-based calculator
export class ScoreCalculator extends PayoutCalculator {
  calculate(
    shares: ShareData[],
    blockReward: number,
    blockFinder?: string
  ): PayoutResult[] {
    const now = Date.now();
    
    // Calculate scores with time decay
    const scoredShares = shares.map(share => {
      const age = (now - share.timestamp) / 1000; // seconds
      const decayFactor = this.config.window.decay?.enabled
        ? Math.exp(-age / (this.config.window.decay.halfLife || 3600))
        : 1;
      
      return {
        ...share,
        score: share.difficulty * decayFactor
      };
    });
    
    // Group by miner
    const minerScores = new Map<string, {
      score: number;
      shares: number;
    }>();
    
    for (const share of scoredShares) {
      const data = minerScores.get(share.minerId) || {
        score: 0,
        shares: 0
      };
      
      data.score += share.score || 0;
      data.shares++;
      
      minerScores.set(share.minerId, data);
    }
    
    // Calculate total score
    const totalScore = Array.from(minerScores.values())
      .reduce((sum, data) => sum + data.score, 0);
    
    // Calculate payouts
    const results: PayoutResult[] = [];
    const netReward = this.applyFees(blockReward);
    
    for (const [minerId, data] of minerScores) {
      const amount = netReward * (data.score / totalScore);
      
      if (amount >= this.config.minPayout) {
        results.push({
          minerId,
          amount,
          shares: data.shares,
          score: data.score
        });
      }
    }
    
    return results;
  }
  
  getInfo() {
    return {
      name: 'Score-based',
      description: 'Rewards based on score with time decay',
      advantages: [
        'Encourages consistent mining',
        'Reduces pool hopping incentive',
        'Flexible scoring system'
      ],
      disadvantages: [
        'Complex to understand',
        'Requires tuning parameters',
        'May penalize intermittent miners'
      ]
    };
  }
}

// Custom payout scheme builder
export class CustomPayoutBuilder {
  private rules: Array<(shares: ShareData[], context: any) => void> = [];
  private scoringFunction?: (share: ShareData) => number;
  private distributionFunction?: (scores: Map<string, number>, reward: number) => PayoutResult[];
  
  // Add scoring rule
  addScoringRule(
    name: string,
    scorer: (share: ShareData) => number
  ): this {
    this.scoringFunction = scorer;
    return this;
  }
  
  // Add distribution rule
  addDistributionRule(
    name: string,
    distributor: (scores: Map<string, number>, reward: number) => PayoutResult[]
  ): this {
    this.distributionFunction = distributor;
    return this;
  }
  
  // Add custom rule
  addRule(
    name: string,
    rule: (shares: ShareData[], context: any) => void
  ): this {
    this.rules.push(rule);
    return this;
  }
  
  // Build calculator
  build(config: PayoutConfig): PayoutCalculator {
    const scorer = this.scoringFunction || ((share) => share.difficulty);
    const distributor = this.distributionFunction || this.defaultDistribution;
    
    return new (class extends PayoutCalculator {
      calculate(
        shares: ShareData[],
        blockReward: number,
        blockFinder?: string
      ): PayoutResult[] {
        // Apply custom rules
        const context = { blockReward, blockFinder };
        for (const rule of this.rules) {
          rule(shares, context);
        }
        
        // Calculate scores
        const scores = new Map<string, number>();
        for (const share of shares) {
          const score = scores.get(share.minerId) || 0;
          scores.set(share.minerId, score + scorer(share));
        }
        
        // Distribute rewards
        return distributor(scores, this.applyFees(blockReward));
      }
      
      getInfo() {
        return {
          name: 'Custom Payout Scheme',
          description: 'Custom-built payout scheme with specific rules',
          advantages: ['Fully customizable', 'Can optimize for specific goals'],
          disadvantages: ['Complex to configure', 'May need extensive testing']
        };
      }
    })(config);
  }
  
  // Default distribution function
  private defaultDistribution(
    scores: Map<string, number>,
    reward: number
  ): PayoutResult[] {
    const totalScore = Array.from(scores.values()).reduce((a, b) => a + b, 0);
    const results: PayoutResult[] = [];
    
    for (const [minerId, score] of scores) {
      const amount = reward * (score / totalScore);
      results.push({
        minerId,
        amount,
        shares: 0,
        score
      });
    }
    
    return results;
  }
}

// Payout scheme factory
export class PayoutSchemeFactory {
  private static schemes = new Map<PayoutScheme, typeof PayoutCalculator>();
  
  static {
    this.register(PayoutScheme.PPLNS, PPLNSCalculator);
    this.register(PayoutScheme.PPS, PPSCalculator);
    this.register(PayoutScheme.PROP, ProportionalCalculator);
    this.register(PayoutScheme.SCORE, ScoreCalculator);
  }
  
  // Register scheme
  static register(scheme: PayoutScheme, calculator: typeof PayoutCalculator): void {
    this.schemes.set(scheme, calculator);
  }
  
  // Create calculator
  static create(config: PayoutConfig, ...args: any[]): PayoutCalculator {
    const Calculator = this.schemes.get(config.scheme);
    if (!Calculator) {
      throw new Error(`Unknown payout scheme: ${config.scheme}`);
    }
    
    return new Calculator(config, ...args);
  }
  
  // Get available schemes
  static getAvailableSchemes(): PayoutScheme[] {
    return Array.from(this.schemes.keys());
  }
}

// Payout simulator for testing
export class PayoutSimulator {
  // Simulate payouts
  static simulate(
    calculator: PayoutCalculator,
    scenarios: Array<{
      name: string;
      shares: ShareData[];
      blockReward: number;
      blockFinder?: string;
    }>
  ): Array<{
    scenario: string;
    payouts: PayoutResult[];
    summary: {
      totalPaid: number;
      minerCount: number;
      avgPayout: number;
      maxPayout: number;
      minPayout: number;
    };
  }> {
    const results = [];
    
    for (const scenario of scenarios) {
      const payouts = calculator.calculate(
        scenario.shares,
        scenario.blockReward,
        scenario.blockFinder
      );
      
      const totalPaid = payouts.reduce((sum, p) => sum + p.amount, 0);
      const amounts = payouts.map(p => p.amount);
      
      results.push({
        scenario: scenario.name,
        payouts,
        summary: {
          totalPaid,
          minerCount: payouts.length,
          avgPayout: totalPaid / payouts.length || 0,
          maxPayout: Math.max(...amounts, 0),
          minPayout: Math.min(...amounts, Infinity)
        }
      });
    }
    
    return results;
  }
  
  // Generate test shares
  static generateTestShares(
    minerCount: number,
    shareCount: number,
    options?: {
      distribution?: 'uniform' | 'pareto' | 'normal';
      hoppers?: number; // percentage
      variance?: number;
    }
  ): ShareData[] {
    const shares: ShareData[] = [];
    const miners = Array.from({ length: minerCount }, (_, i) => `miner-${i}`);
    
    for (let i = 0; i < shareCount; i++) {
      const minerId = this.selectMiner(miners, options?.distribution);
      
      shares.push({
        minerId,
        difficulty: this.generateDifficulty(options?.variance),
        timestamp: Date.now() - (shareCount - i) * 10000,
        valid: true
      });
    }
    
    return shares;
  }
  
  private static selectMiner(
    miners: string[],
    distribution?: string
  ): string {
    switch (distribution) {
      case 'pareto':
        // 80/20 rule
        const rand = Math.random();
        const index = Math.floor(
          miners.length * (1 - Math.pow(rand, 5))
        );
        return miners[index];
        
      case 'normal':
        // Normal distribution
        const u1 = Math.random();
        const u2 = Math.random();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        const idx = Math.abs(Math.floor((z + 3) / 6 * miners.length));
        return miners[Math.min(idx, miners.length - 1)];
        
      default:
        // Uniform
        return miners[Math.floor(Math.random() * miners.length)];
    }
  }
  
  private static generateDifficulty(variance: number = 0.2): number {
    const base = 1000;
    const variation = base * variance * (Math.random() - 0.5) * 2;
    return Math.max(1, base + variation);
  }
}
