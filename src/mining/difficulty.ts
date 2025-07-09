// Dynamic difficulty adjustment (Carmack style - performance focused)
import { Miner } from '../domain/miner';
import { logger } from '../logging/logger';

export interface DifficultyConfig {
  minDifficulty: number;
  maxDifficulty: number;
  targetShareTime: number; // seconds between shares
  retargetInterval: number; // seconds
  variancePercent: number; // allowed variance
}

export class DifficultyManager {
  private minerDifficulties = new Map<string, {
    difficulty: number;
    shares: number[];
    lastRetarget: number;
    targetShares: number;
  }>();
  
  constructor(
    private config: DifficultyConfig = {
      minDifficulty: 1,
      maxDifficulty: 1000000,
      targetShareTime: 10, // 10 seconds per share
      retargetInterval: 120, // retarget every 2 minutes
      variancePercent: 50 // 50% variance allowed
    }
  ) {}
  
  // Get current difficulty for miner
  getDifficulty(minerId: string): number {
    const data = this.minerDifficulties.get(minerId);
    return data?.difficulty || this.config.minDifficulty;
  }
  
  // Record share submission
  recordShare(minerId: string): void {
    const now = Date.now();
    let data = this.minerDifficulties.get(minerId);
    
    if (!data) {
      data = {
        difficulty: this.config.minDifficulty,
        shares: [],
        lastRetarget: now,
        targetShares: Math.floor(this.config.retargetInterval / this.config.targetShareTime)
      };
      this.minerDifficulties.set(minerId, data);
    }
    
    // Add share timestamp
    data.shares.push(now);
    
    // Remove old shares outside retarget window
    const cutoff = now - (this.config.retargetInterval * 1000);
    data.shares = data.shares.filter(t => t > cutoff);
    
    // Check if retarget needed
    if (now - data.lastRetarget >= this.config.retargetInterval * 1000) {
      this.retargetDifficulty(minerId, data);
    }
  }
  
  // Retarget difficulty for miner
  private retargetDifficulty(
    minerId: string,
    data: {
      difficulty: number;
      shares: number[];
      lastRetarget: number;
      targetShares: number;
    }
  ): void {
    const now = Date.now();
    const actualTime = (now - data.lastRetarget) / 1000;
    const actualShares = data.shares.length;
    
    // Calculate actual vs expected shares
    const expectedShares = actualTime / this.config.targetShareTime;
    const ratio = actualShares / expectedShares;
    
    logger.debug('difficulty', `Retargeting ${minerId}`, {
      currentDifficulty: data.difficulty,
      actualShares,
      expectedShares,
      ratio
    });
    
    // Calculate new difficulty
    let newDifficulty = data.difficulty;
    
    if (ratio > 1 + this.config.variancePercent / 100) {
      // Too many shares, increase difficulty
      newDifficulty = data.difficulty * ratio;
    } else if (ratio < 1 - this.config.variancePercent / 100) {
      // Too few shares, decrease difficulty
      newDifficulty = data.difficulty * ratio;
    }
    
    // Apply bounds
    newDifficulty = Math.max(this.config.minDifficulty, newDifficulty);
    newDifficulty = Math.min(this.config.maxDifficulty, newDifficulty);
    
    // Smooth adjustment - don't change too rapidly
    const maxChange = 4; // Maximum 4x change per retarget
    if (newDifficulty > data.difficulty * maxChange) {
      newDifficulty = data.difficulty * maxChange;
    } else if (newDifficulty < data.difficulty / maxChange) {
      newDifficulty = data.difficulty / maxChange;
    }
    
    // Round to nice number
    newDifficulty = this.roundDifficulty(newDifficulty);
    
    if (newDifficulty !== data.difficulty) {
      logger.info('difficulty', `Adjusted difficulty for ${minerId}`, {
        oldDifficulty: data.difficulty,
        newDifficulty,
        changePercent: ((newDifficulty / data.difficulty - 1) * 100).toFixed(1)
      });
    }
    
    // Update
    data.difficulty = newDifficulty;
    data.lastRetarget = now;
    data.shares = []; // Reset shares after retarget
  }
  
  // Round difficulty to nice number
  private roundDifficulty(difficulty: number): number {
    if (difficulty < 10) {
      return Math.round(difficulty);
    } else if (difficulty < 100) {
      return Math.round(difficulty / 10) * 10;
    } else if (difficulty < 1000) {
      return Math.round(difficulty / 100) * 100;
    } else {
      // Round to 3 significant figures
      const order = Math.pow(10, Math.floor(Math.log10(difficulty)) - 2);
      return Math.round(difficulty / order) * order;
    }
  }
  
  // Get vardiff stats for miner
  getStats(minerId: string): {
    difficulty: number;
    sharesPerMinute: number;
    nextRetarget: number;
  } | null {
    const data = this.minerDifficulties.get(minerId);
    if (!data) {
      return null;
    }
    
    const now = Date.now();
    const recentShares = data.shares.filter(t => t > now - 60000).length;
    
    return {
      difficulty: data.difficulty,
      sharesPerMinute: recentShares,
      nextRetarget: data.lastRetarget + this.config.retargetInterval * 1000
    };
  }
  
  // Cleanup inactive miners
  cleanup(inactiveThreshold: number = 3600000): void { // 1 hour
    const now = Date.now();
    const toRemove: string[] = [];
    
    for (const [minerId, data] of this.minerDifficulties) {
      const lastShare = data.shares[data.shares.length - 1] || 0;
      if (now - lastShare > inactiveThreshold) {
        toRemove.push(minerId);
      }
    }
    
    for (const minerId of toRemove) {
      this.minerDifficulties.delete(minerId);
    }
    
    if (toRemove.length > 0) {
      logger.info('difficulty', `Cleaned up ${toRemove.length} inactive miners`);
    }
  }
  
  // Port difficulty for pool
  getPortDifficulty(port: number): number {
    // Different ports can have different starting difficulties
    const portDifficulties: { [port: number]: number } = {
      3333: 1000,     // Low difficulty
      3334: 10000,    // Medium difficulty  
      3335: 100000,   // High difficulty
      3336: 1000000   // Very high difficulty
    };
    
    return portDifficulties[port] || this.config.minDifficulty;
  }
}

// Difficulty target calculator for different coins
export class DifficultyCalculator {
  // Convert bits to difficulty
  static bitsTodifficulty(bits: string): number {
    const bitsBigInt = BigInt('0x' + bits);
    const exp = bitsBigInt >> 24n;
    const mant = bitsBigInt & 0xffffffn;
    const target = mant * (1n << (8n * (exp - 3n)));
    const maxTarget = 1n << 256n;
    return Number(maxTarget / target);
  }
  
  // Convert difficulty to target
  static difficultyToTarget(difficulty: number): string {
    const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
    const target = maxTarget / BigInt(Math.floor(difficulty));
    return target.toString(16).padStart(64, '0');
  }
  
  // Calculate share difficulty from hash
  static calculateShareDifficulty(hash: Buffer): number {
    // Count leading zeros
    let zeros = 0;
    for (const byte of hash) {
      if (byte === 0) {
        zeros += 8;
      } else {
        // Count leading zeros in byte
        let b = byte;
        while ((b & 0x80) === 0) {
          zeros++;
          b <<= 1;
        }
        break;
      }
    }
    
    // Approximate difficulty from leading zeros
    return Math.pow(2, zeros);
  }
}
