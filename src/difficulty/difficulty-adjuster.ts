// Dynamic Difficulty Adjustment System
import { DifficultyConfig, loadDifficultyConfig } from '../config/difficulty';
import { Logger } from '../logging/logger';
import { AlertSystem } from '../alerts/alert-system';
import { MiningPoolCore } from '../core/pool';

export class DifficultyAdjuster {
  private config: DifficultyConfig;
  private logger: Logger;
  private alertSystem: AlertSystem;
  private pool: MiningPoolCore;
  private adjustmentInterval: NodeJS.Timeout | null = null;
  private shareHistory: { timestamp: number; difficulty: number; hashrate: number }[] = [];
  private minerStats: Map<string, { hashrate: number; lastShare: number; validShares: number }> = new Map();

  constructor(pool: MiningPoolCore) {
    this.config = loadDifficultyConfig();
    this.logger = Logger.getInstance();
    this.alertSystem = new AlertSystem(pool);
    this.pool = pool;
    
    // Initialize with initial difficulty
    this.pool.setDifficulty(this.config.initialDifficulty);
    
    // Start adjustment timer
    this.startAdjustmentTimer();
  }

  private startAdjustmentTimer(): void {
    this.adjustmentInterval = setInterval(() => {
      this.adjustDifficulty();
    }, this.config.adjustmentInterval * 1000);
  }

  private async adjustDifficulty(): Promise<void> {
    try {
      // Get current pool state
      const currentDifficulty = this.pool.getDifficulty();
      const currentMiners = this.pool.getMinerCount();
      const currentHashrate = this.pool.getHashrate();
      
      // Collect share statistics
      this.collectShareStatistics();
      
      // Calculate ideal difficulty
      const idealDifficulty = this.calculateIdealDifficulty();
      
      // Calculate adjustment amount
      const adjustment = this.calculateAdjustment(currentDifficulty, idealDifficulty);
      
      // Apply adjustment with safety checks
      const newDifficulty = this.applySafetyChecks(currentDifficulty, adjustment);
      
      // Update difficulty
      this.pool.setDifficulty(newDifficulty);
      
      // Log adjustment
      this.logger.info('Difficulty adjusted', {
        current: currentDifficulty,
        new: newDifficulty,
        adjustment: adjustment,
        hashrate: currentHashrate,
        miners: currentMiners
      });
      
      // Send alert if significant change
      if (Math.abs(adjustment) > this.config.safety.maxAdjustment) {
        this.alertSystem.checkPerformanceMetric('difficulty_change', Math.abs(adjustment), {
          current: currentDifficulty,
          new: newDifficulty,
          reason: 'Significant difficulty adjustment'
        });
      }
      
    } catch (error) {
      this.logger.error('Difficulty adjustment failed:', error);
      this.alertSystem.checkSecurityMetric('adjustment_error', 1, {
        error: error.message,
        timestamp: new Date()
      });
    }
  }

  private collectShareStatistics(): void {
    // Get recent shares
    const recentShares = this.pool.getRecentShares(this.config.timeWindow);
    
    // Update miner stats
    for (const share of recentShares) {
      const minerId = share.minerId;
      const minerStat = this.minerStats.get(minerId) || {
        hashrate: 0,
        lastShare: 0,
        validShares: 0
      };
      
      // Calculate hashrate
      const timeDiff = Date.now() - minerStat.lastShare;
      minerStat.hashrate = (minerStat.hashrate * 0.9 + share.difficulty / timeDiff * 0.1) || share.difficulty;
      
      // Update stats
      minerStat.lastShare = Date.now();
      minerStat.validShares++;
      
      this.minerStats.set(minerId, minerStat);
    }
    
    // Add to share history
    this.shareHistory.push({
      timestamp: Date.now(),
      difficulty: this.pool.getDifficulty(),
      hashrate: this.pool.getHashrate()
    });
    
    // Keep history within window
    const cutoff = Date.now() - this.config.timeWindow * 1000;
    this.shareHistory = this.shareHistory.filter(s => s.timestamp >= cutoff);
  }

  private calculateIdealDifficulty(): number {
    // Calculate average hashrate
    const totalHashrate = Array.from(this.minerStats.values())
      .reduce((sum, stat) => sum + stat.hashrate, 0);
    
    // Calculate target difficulty
    const targetDifficulty = totalHashrate * this.config.targetTime;
    
    // Apply exponential smoothing if enabled
    if (this.config.advanced.useExponentialSmoothing) {
      const currentDifficulty = this.pool.getDifficulty();
      return currentDifficulty * (1 - this.config.advanced.smoothingFactor) +
             targetDifficulty * this.config.advanced.smoothingFactor;
    }
    
    return targetDifficulty;
  }

  private calculateAdjustment(current: number, ideal: number): number {
    // Calculate raw adjustment
    const rawAdjustment = (ideal - current) / current;
    
    // Apply adjustment factor
    const adjusted = rawAdjustment * this.config.adjustmentFactor;
    
    // Apply safety limits
    return Math.max(
      this.config.safety.minAdjustment,
      Math.min(
        this.config.safety.maxAdjustment,
        adjusted
      )
    );
  }

  private applySafetyChecks(current: number, adjustment: number): number {
    // Calculate new difficulty
    const newDifficulty = current * (1 + adjustment);
    
    // Apply min/max limits
    const bounded = Math.max(
      this.config.minDifficulty,
      Math.min(
        this.config.maxDifficulty,
        newDifficulty
      )
    );
    
    // Check miner stability
    const activeMiners = Array.from(this.minerStats.values()).filter(
      stat => stat.lastShare > Date.now() - this.config.miner.adjustmentGracePeriod * 1000
    ).length;
    
    if (activeMiners < this.config.network.minMiners) {
      this.logger.warn('Not enough miners for adjustment', { miners: activeMiners });
      return current;
    }
    
    return bounded;
  }

  public async shutdown(): Promise<void> {
    if (this.adjustmentInterval) {
      clearInterval(this.adjustmentInterval);
    }
    this.minerStats.clear();
    this.shareHistory = [];
    await this.alertSystem.shutdown();
  }
}
