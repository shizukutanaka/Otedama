// Dynamic difficulty adjustment (Simple and efficient)
export class DifficultyManager {
  private minerDifficulties = new Map<string, MinerDifficulty>();
  private networkDifficulty = 1;
  private minDifficulty = 1;
  private maxDifficulty = 1000000;
  
  // Variance threshold for retargeting
  private readonly VARIANCE_PERCENT = 30;
  private readonly RETARGET_INTERVAL = 120; // seconds
  
  constructor(
    private targetShareTime = 10 // Target seconds between shares
  ) {}
  
  // Set network difficulty from blockchain
  setNetworkDifficulty(difficulty: number): void {
    this.networkDifficulty = difficulty;
    this.maxDifficulty = Math.min(difficulty / 100, 1000000);
  }
  
  // Get or create miner difficulty
  getMinerDifficulty(minerId: string): number {
    let minerDiff = this.minerDifficulties.get(minerId);
    
    if (!minerDiff) {
      minerDiff = new MinerDifficulty(this.minDifficulty);
      this.minerDifficulties.set(minerId, minerDiff);
    }
    
    return minerDiff.current;
  }
  
  // Update difficulty based on share submission rate
  updateMinerDifficulty(minerId: string): number {
    const minerDiff = this.minerDifficulties.get(minerId);
    if (!minerDiff) return this.minDifficulty;
    
    // Record share submission
    minerDiff.recordShare();
    
    // Check if retarget is needed
    const now = Date.now();
    if (now - minerDiff.lastRetarget < this.RETARGET_INTERVAL * 1000) {
      return minerDiff.current;
    }
    
    // Calculate actual share rate
    const actualRate = minerDiff.getShareRate();
    const targetRate = 1 / this.targetShareTime;
    
    // Check if adjustment needed
    const variance = Math.abs(actualRate - targetRate) / targetRate * 100;
    if (variance > this.VARIANCE_PERCENT) {
      // Calculate new difficulty
      const adjustment = targetRate / actualRate;
      let newDiff = Math.floor(minerDiff.current * adjustment);
      
      // Apply limits
      newDiff = Math.max(this.minDifficulty, Math.min(this.maxDifficulty, newDiff));
      
      // Smooth changes to prevent oscillation
      if (newDiff > minerDiff.current * 4) {
        newDiff = minerDiff.current * 4;
      } else if (newDiff < minerDiff.current / 4) {
        newDiff = minerDiff.current / 4;
      }
      
      minerDiff.adjust(newDiff);
    }
    
    return minerDiff.current;
  }
  
  // Remove inactive miners
  cleanup(inactiveSeconds = 600): void {
    const cutoff = Date.now() - inactiveSeconds * 1000;
    
    for (const [minerId, minerDiff] of this.minerDifficulties.entries()) {
      if (minerDiff.lastShareTime < cutoff) {
        this.minerDifficulties.delete(minerId);
      }
    }
  }
  
  // Get statistics
  getStats(): {
    minerCount: number,
    avgDifficulty: number,
    minDifficulty: number,
    maxDifficulty: number
  } {
    const difficulties = Array.from(this.minerDifficulties.values())
      .map(md => md.current);
    
    if (difficulties.length === 0) {
      return {
        minerCount: 0,
        avgDifficulty: this.minDifficulty,
        minDifficulty: this.minDifficulty,
        maxDifficulty: this.minDifficulty
      };
    }
    
    return {
      minerCount: difficulties.length,
      avgDifficulty: difficulties.reduce((a, b) => a + b) / difficulties.length,
      minDifficulty: Math.min(...difficulties),
      maxDifficulty: Math.max(...difficulties)
    };
  }
}

// Per-miner difficulty tracking
class MinerDifficulty {
  current: number;
  lastRetarget: number;
  lastShareTime: number;
  shareCount: number;
  windowStart: number;
  
  constructor(initialDifficulty: number) {
    this.current = initialDifficulty;
    this.lastRetarget = Date.now();
    this.lastShareTime = Date.now();
    this.shareCount = 0;
    this.windowStart = Date.now();
  }
  
  recordShare(): void {
    this.shareCount++;
    this.lastShareTime = Date.now();
  }
  
  getShareRate(): number {
    const elapsed = (Date.now() - this.windowStart) / 1000;
    return elapsed > 0 ? this.shareCount / elapsed : 0;
  }
  
  adjust(newDifficulty: number): void {
    this.current = newDifficulty;
    this.lastRetarget = Date.now();
    this.shareCount = 0;
    this.windowStart = Date.now();
  }
}

// Difficulty conversion utilities
export class DifficultyUtil {
  // Convert difficulty to target
  static difficultyToTarget(difficulty: number): Buffer {
    // Maximum target (difficulty 1)
    const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
    
    // Calculate actual target
    const target = maxTarget / BigInt(Math.floor(difficulty));
    
    // Convert to buffer
    const buffer = Buffer.alloc(32);
    const hex = target.toString(16).padStart(64, '0');
    buffer.write(hex, 'hex');
    
    return buffer;
  }
  
  // Convert target to difficulty
  static targetToDifficulty(target: Buffer): number {
    const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
    const targetBigInt = BigInt('0x' + target.toString('hex'));
    
    if (targetBigInt === 0n) return 0;
    
    return Number(maxTarget / targetBigInt);
  }
  
  // Convert bits (compact format) to difficulty
  static bitsToifficulty(bits: string): number {
    const bitsNum = parseInt(bits, 16);
    const exponent = bitsNum >> 24;
    const mantissa = bitsNum & 0xFFFFFF;
    
    let target: bigint;
    if (exponent <= 3) {
      target = BigInt(mantissa) >> BigInt(8 * (3 - exponent));
    } else {
      target = BigInt(mantissa) << BigInt(8 * (exponent - 3));
    }
    
    const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
    return Number(maxTarget / target);
  }
  
  // Calculate hashrate from difficulty and time
  static calculateHashrate(difficulty: number, seconds: number): number {
    // Hashes = difficulty * 2^32
    return (difficulty * 4294967296) / seconds;
  }
  
  // Format hashrate for display
  static formatHashrate(hashrate: number): string {
    const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s'];
    let unitIndex = 0;
    
    while (hashrate >= 1000 && unitIndex < units.length - 1) {
      hashrate /= 1000;
      unitIndex++;
    }
    
    return `${hashrate.toFixed(2)} ${units[unitIndex]}`;
  }
}

// Network difficulty tracker
export class NetworkDifficultyTracker {
  private history: Array<{
    height: number,
    difficulty: number,
    timestamp: number
  }> = [];
  
  private maxHistory = 2016; // Bitcoin's retarget interval
  
  // Add new difficulty
  addDifficulty(height: number, difficulty: number): void {
    this.history.push({
      height,
      difficulty,
      timestamp: Date.now()
    });
    
    // Keep only recent history
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }
  
  // Get current difficulty
  getCurrent(): number {
    return this.history.length > 0 
      ? this.history[this.history.length - 1].difficulty 
      : 1;
  }
  
  // Predict next difficulty adjustment
  predictNextAdjustment(): {
    blocksRemaining: number,
    estimatedChange: number
  } | null {
    if (this.history.length < 2) return null;
    
    const current = this.history[this.history.length - 1];
    const retargetBlock = Math.ceil(current.height / 2016) * 2016;
    const blocksRemaining = retargetBlock - current.height;
    
    // Find block at start of current period
    const periodStart = this.history.find(h => 
      h.height >= retargetBlock - 2016
    );
    
    if (!periodStart) return null;
    
    // Calculate time elapsed
    const targetTime = 2016 * 10 * 60 * 1000; // 2 weeks in ms
    const actualTime = current.timestamp - periodStart.timestamp;
    
    // Estimate change
    const estimatedChange = (targetTime / actualTime - 1) * 100;
    
    return {
      blocksRemaining,
      estimatedChange
    };
  }
}
