// Difficulty Adjustment Configuration
export interface DifficultyConfig {
  // Base difficulty settings
  initialDifficulty: number;  // Initial difficulty value
  minDifficulty: number;      // Minimum difficulty
  maxDifficulty: number;      // Maximum difficulty
  
  // Adjustment parameters
  targetTime: number;         // Target time per share (seconds)
  timeWindow: number;         // Time window for share analysis (seconds)
  adjustmentInterval: number; // How often to adjust (seconds)
  adjustmentFactor: number;   // How much to adjust by (factor)
  
  // Miner-specific settings
  miner: {
    minHashrate: number;      // Minimum hashrate per miner
    maxHashrate: number;      // Maximum hashrate per miner
    adjustmentGracePeriod: number; // Don't adjust too quickly
  };
  
  // Network-wide settings
  network: {
    minMiners: number;        // Minimum number of miners
    maxMiners: number;        // Maximum number of miners
    shareDistribution: number; // Target share distribution
  };
  
  // Safety thresholds
  safety: {
    maxAdjustment: number;    // Maximum adjustment per interval
    minAdjustment: number;    // Minimum adjustment per interval
    stabilityThreshold: number; // How stable must hashrate be
  };
  
  // Advanced settings
  advanced: {
    useExponentialSmoothing: boolean;
    smoothingFactor: number;
    dynamicWindow: boolean;
    windowAdjustment: number;
  };
}

// Default configuration
export const defaultDifficultyConfig: DifficultyConfig = {
  initialDifficulty: 1000000, // 1M
  minDifficulty: 100000,     // 100K
  maxDifficulty: 1000000000, // 1B
  
  targetTime: 30,            // 30 seconds per share
  timeWindow: 600,           // 10 minutes
  adjustmentInterval: 60,    // Adjust every minute
  adjustmentFactor: 0.1,     // 10% adjustment
  
  miner: {
    minHashrate: 100000,     // 100K H/s
    maxHashrate: 1000000000, // 1G H/s
    adjustmentGracePeriod: 300 // 5 minutes
  },
  
  network: {
    minMiners: 10,
    maxMiners: 1000,
    shareDistribution: 0.8    // 80% of shares should be valid
  },
  
  safety: {
    maxAdjustment: 0.5,      // 50% max adjustment
    minAdjustment: 0.05,     // 5% min adjustment
    stabilityThreshold: 0.1  // 10% hashrate stability
  },
  
  advanced: {
    useExponentialSmoothing: true,
    smoothingFactor: 0.2,
    dynamicWindow: true,
    windowAdjustment: 0.1
  }
};

// Load configuration from environment or config file
export function loadDifficultyConfig(): DifficultyConfig {
  // In a real implementation, this would load from a config file or environment variables
  // For now, just return the default config
  return defaultDifficultyConfig;
}
