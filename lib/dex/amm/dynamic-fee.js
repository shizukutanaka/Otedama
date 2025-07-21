export class DynamicFeeManager {
  constructor(config = {}) {
    this.config = {
      baseFee: 100, // Default base fee
      ...config,
    };
  }

  /**
   * Calculate fee based on pool utilization
   */
  calculateUtilizationFee(utilization) {
    // Higher utilization = higher fee
    // This helps balance the pool
    
    if (utilization < 0.2) {
        // Low utilization
        return this.config.baseFee * 0.9;
    } else if (utilization < 0.8) {
        // Normal utilization
        return this.config.baseFee;
    } else if (utilization < 0.95) {
        // High utilization
        return this.config.baseFee * 1.2;
    } else {
        // Critical utilization
        return this.config.baseFee * 1.5;
    }
  }
}
