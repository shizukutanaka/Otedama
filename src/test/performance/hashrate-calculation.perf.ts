// Hashrate calculation performance tests
// Rob Pike: "Measure. Don't tune for speed until you've measured."

import { perfTest } from './performance-test-framework';

interface ShareTimestamp {
  minerId: string;
  timestamp: number;
  difficulty: number;
}

/**
 * Hashrate calculation performance tests
 */
export class HashrateCalculationPerformance {
  private shareHistory: Map<string, ShareTimestamp[]> = new Map();
  private minerIds: string[] = [];
  
  constructor() {
    this.generateTestData();
  }

  /**
   * Generate test data
   */
  private generateTestData(): void {
    // Generate 1000 miners
    for (let i = 0; i < 1000; i++) {
      const minerId = `miner-${i}`;
      this.minerIds.push(minerId);
      
      // Generate share history for each miner (last 5 minutes)
      const shares: ShareTimestamp[] = [];
      const now = Date.now();
      const shareCount = 50 + Math.floor(Math.random() * 100); // 50-150 shares
      
      for (let j = 0; j < shareCount; j++) {
        shares.push({
          minerId,
          timestamp: now - Math.random() * 300000, // Last 5 minutes
          difficulty: Math.pow(2, 10 + Math.random() * 5) // 2^10 to 2^15
        });
      }
      
      // Sort by timestamp
      shares.sort((a, b) => a.timestamp - b.timestamp);
      this.shareHistory.set(minerId, shares);
    }
  }

  /**
   * Test simple moving average hashrate
   */
  async testMovingAverageHashrate(): Promise<void> {
    let minerIndex = 0;
    
    await perfTest.run(() => {
      const minerId = this.minerIds[minerIndex % this.minerIds.length];
      minerIndex++;
      
      const shares = this.shareHistory.get(minerId) || [];
      const now = Date.now();
      const windowSize = 300000; // 5 minutes
      
      // Filter shares within window
      const recentShares = shares.filter(s => now - s.timestamp <= windowSize);
      
      if (recentShares.length === 0) return 0;
      
      // Calculate total difficulty
      const totalDifficulty = recentShares.reduce((sum, share) => sum + share.difficulty, 0);
      
      // Calculate time span
      const timeSpan = (now - recentShares[0].timestamp) / 1000; // seconds
      
      // Hashrate = (total difficulty * 2^32) / time
      const hashrate = (totalDifficulty * 4294967296) / timeSpan;
      
      return hashrate;
    }, {
      name: 'Moving Average Hashrate',
      iterations: 10000,
      warmupIterations: 100
    });
  }

  /**
   * Test exponential weighted moving average
   */
  async testEWMAHashrate(): Promise<void> {
    let minerIndex = 0;
    
    await perfTest.run(() => {
      const minerId = this.minerIds[minerIndex % this.minerIds.length];
      minerIndex++;
      
      const shares = this.shareHistory.get(minerId) || [];
      const now = Date.now();
      const alpha = 0.1; // Smoothing factor
      
      let ewma = 0;
      let lastTimestamp = shares[0]?.timestamp || now;
      
      for (const share of shares) {
        const timeDiff = (share.timestamp - lastTimestamp) / 1000;
        if (timeDiff > 0) {
          const instantHashrate = (share.difficulty * 4294967296) / timeDiff;
          ewma = alpha * instantHashrate + (1 - alpha) * ewma;
        }
        lastTimestamp = share.timestamp;
      }
      
      return ewma;
    }, {
      name: 'EWMA Hashrate',
      iterations: 10000,
      warmupIterations: 100
    });
  }

  /**
   * Test pool-wide hashrate calculation
   */
  async testPoolHashrate(): Promise<void> {
    await perfTest.run(() => {
      const now = Date.now();
      const windowSize = 300000; // 5 minutes
      let totalHashrate = 0;
      
      for (const [minerId, shares] of this.shareHistory) {
        const recentShares = shares.filter(s => now - s.timestamp <= windowSize);
        
        if (recentShares.length > 0) {
          const totalDifficulty = recentShares.reduce((sum, share) => sum + share.difficulty, 0);
          const timeSpan = (now - recentShares[0].timestamp) / 1000;
          const minerHashrate = (totalDifficulty * 4294967296) / timeSpan;
          totalHashrate += minerHashrate;
        }
      }
      
      return totalHashrate;
    }, {
      name: 'Pool-wide Hashrate',
      iterations: 100,
      warmupIterations: 10
    });
  }

  /**
   * Compare different calculation methods
   */
  async compareCalculationMethods(): Promise<void> {
    // Method A: Array-based calculation
    const arrayMethod = () => {
      const shares = this.shareHistory.get(this.minerIds[0]) || [];
      const now = Date.now();
      const windowSize = 300000;
      
      const recentShares = [];
      for (let i = shares.length - 1; i >= 0; i--) {
        if (now - shares[i].timestamp <= windowSize) {
          recentShares.push(shares[i]);
        } else {
          break; // Shares are sorted, so we can exit early
        }
      }
      
      if (recentShares.length === 0) return 0;
      
      const totalDifficulty = recentShares.reduce((sum, share) => sum + share.difficulty, 0);
      const timeSpan = (now - recentShares[recentShares.length - 1].timestamp) / 1000;
      
      return (totalDifficulty * 4294967296) / timeSpan;
    };
    
    // Method B: Optimized with early exit
    const optimizedMethod = () => {
      const shares = this.shareHistory.get(this.minerIds[0]) || [];
      const now = Date.now();
      const windowSize = 300000;
      const cutoff = now - windowSize;
      
      let totalDifficulty = 0;
      let oldestTimestamp = now;
      let count = 0;
      
      // Iterate from newest to oldest
      for (let i = shares.length - 1; i >= 0; i--) {
        const share = shares[i];
        if (share.timestamp < cutoff) break;
        
        totalDifficulty += share.difficulty;
        oldestTimestamp = share.timestamp;
        count++;
      }
      
      if (count === 0) return 0;
      
      const timeSpan = (now - oldestTimestamp) / 1000;
      return (totalDifficulty * 4294967296) / timeSpan;
    };
    
    const result = await perfTest.compare(
      'Hashrate Calculation Methods',
      arrayMethod,
      optimizedMethod,
      {
        iterations: 10000,
        warmupIterations: 100
      }
    );
    
    console.log(`\nMethod comparison: ${result.comparison.winner} is ${result.comparison.speedup.toFixed(2)}x faster`);
  }

  /**
   * Test hashrate with different window sizes
   */
  async testWindowSizes(): Promise<void> {
    const windowSizes = [60000, 300000, 600000, 3600000]; // 1min, 5min, 10min, 1hour
    
    for (const window of windowSizes) {
      await perfTest.run(() => {
        const minerId = this.minerIds[0];
        const shares = this.shareHistory.get(minerId) || [];
        const now = Date.now();
        
        const recentShares = shares.filter(s => now - s.timestamp <= window);
        
        if (recentShares.length === 0) return 0;
        
        const totalDifficulty = recentShares.reduce((sum, share) => sum + share.difficulty, 0);
        const timeSpan = (now - recentShares[0].timestamp) / 1000;
        
        return (totalDifficulty * 4294967296) / timeSpan;
      }, {
        name: `Hashrate Calculation (${window / 1000}s window)`,
        iterations: 1000,
        warmupIterations: 100
      });
    }
  }

  /**
   * Run all hashrate calculation performance tests
   */
  async runAll(): Promise<void> {
    await perfTest.suite('Hashrate Calculation Performance', [
      { name: 'Moving Average', fn: () => this.testMovingAverageHashrate() },
      { name: 'EWMA', fn: () => this.testEWMAHashrate() },
      { name: 'Pool-wide', fn: () => this.testPoolHashrate() },
      { name: 'Method Comparison', fn: () => this.compareCalculationMethods() },
      { name: 'Window Sizes', fn: () => this.testWindowSizes() }
    ]);
  }
}

// Run tests if executed directly
if (require.main === module) {
  const test = new HashrateCalculationPerformance();
  test.runAll().catch(console.error);
}
