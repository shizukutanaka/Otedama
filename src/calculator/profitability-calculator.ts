/**
 * Profitability Calculator - Mining Revenue Estimation
 * Following John Carmack's principle: Simple, fast, and accurate calculations
 */

export interface HashingPowerUnit {
  readonly value: number;
  readonly unit: 'H/s' | 'KH/s' | 'MH/s' | 'GH/s' | 'TH/s' | 'PH/s' | 'EH/s';
}

export interface PowerConsumption {
  readonly watts: number;
  readonly efficiency?: number; // J/TH (Joules per TeraHash)
}

export interface ElectricityCost {
  readonly pricePerKwh: number; // USD per kWh
  readonly currency: string;
}

export interface NetworkStats {
  readonly difficulty: number;
  readonly networkHashrate: number; // H/s
  readonly blockReward: number; // BTC
  readonly blockTime: number; // seconds
}

export interface MiningHardware {
  readonly name: string;
  readonly hashrate: HashingPowerUnit;
  readonly powerConsumption: PowerConsumption;
  readonly initialCost?: number; // USD
  readonly lifespan?: number; // months
}

export interface ProfitabilityResult {
  readonly daily: {
    readonly revenue: number; // BTC
    readonly electricityCost: number; // USD
    readonly profit: number; // USD
    readonly profitMargin: number; // percentage
  };
  readonly monthly: {
    readonly revenue: number;
    readonly electricityCost: number;
    readonly profit: number;
    readonly profitMargin: number;
  };
  readonly yearly: {
    readonly revenue: number;
    readonly electricityCost: number;
    readonly profit: number;
    readonly profitMargin: number;
    readonly roi?: number; // months to ROI
  };
  readonly breakeven: {
    readonly btcPrice: number; // USD - price needed to breakeven
    readonly electricityPrice: number; // USD/kWh - max electricity price for profitability
  };
}

export interface CalculationInput {
  readonly hardware: MiningHardware;
  readonly network: NetworkStats;
  readonly electricity: ElectricityCost;
  readonly btcPrice: number; // USD
  readonly poolFee: number; // percentage (0-100)
}

/**
 * High-performance profitability calculator
 * Optimized for speed and accuracy
 */
export class ProfitabilityCalculator {
  private readonly SECONDS_PER_DAY = 86400;
  private readonly DAYS_PER_MONTH = 30.44; // Average
  private readonly DAYS_PER_YEAR = 365.25; // Including leap years
  private readonly HOURS_PER_DAY = 24;

  /**
   * Convert hashrate to standard H/s unit
   */
  private normalizeHashrate(hashrate: HashingPowerUnit): number {
    const multipliers = {
      'H/s': 1,
      'KH/s': 1e3,
      'MH/s': 1e6,
      'GH/s': 1e9,
      'TH/s': 1e12,
      'PH/s': 1e15,
      'EH/s': 1e18
    };
    
    return hashrate.value * multipliers[hashrate.unit];
  }

  /**
   * Calculate mining revenue for a given period
   */
  private calculateRevenue(
    hashrateHz: number,
    networkStats: NetworkStats,
    poolFee: number,
    periodDays: number
  ): number {
    // Revenue = (Your_Hashrate / Network_Hashrate) * Block_Reward * Blocks_Per_Period * (1 - Pool_Fee)
    const shareOfNetwork = hashrateHz / networkStats.networkHashrate;
    const blocksPerSecond = 1 / networkStats.blockTime;
    const blocksPerPeriod = blocksPerSecond * this.SECONDS_PER_DAY * periodDays;
    const grossRevenue = shareOfNetwork * networkStats.blockReward * blocksPerPeriod;
    const netRevenue = grossRevenue * (1 - poolFee / 100);
    
    return netRevenue;
  }

  /**
   * Calculate electricity cost for a given period
   */
  private calculateElectricityCost(
    powerWatts: number,
    electricityPrice: number,
    periodDays: number
  ): number {
    const kilowatts = powerWatts / 1000;
    const hoursInPeriod = periodDays * this.HOURS_PER_DAY;
    const energyConsumption = kilowatts * hoursInPeriod; // kWh
    
    return energyConsumption * electricityPrice;
  }

  /**
   * Calculate breakeven BTC price
   */
  private calculateBreakevenBtcPrice(
    dailyRevenueBtc: number,
    dailyElectricityCostUsd: number
  ): number {
    if (dailyRevenueBtc <= 0) return Infinity;
    return dailyElectricityCostUsd / dailyRevenueBtc;
  }

  /**
   * Calculate maximum profitable electricity price
   */
  private calculateMaxElectricityPrice(
    powerWatts: number,
    dailyRevenueBtc: number,
    btcPrice: number
  ): number {
    const dailyRevenueUsd = dailyRevenueBtc * btcPrice;
    const dailyKwh = (powerWatts / 1000) * this.HOURS_PER_DAY;
    
    if (dailyKwh <= 0) return 0;
    return dailyRevenueUsd / dailyKwh;
  }

  /**
   * Main calculation method
   */
  calculate(input: CalculationInput): ProfitabilityResult {
    const hashrateHz = this.normalizeHashrate(input.hardware.hashrate);
    
    // Daily calculations
    const dailyRevenueBtc = this.calculateRevenue(
      hashrateHz,
      input.network,
      input.poolFee,
      1
    );
    const dailyElectricityCostUsd = this.calculateElectricityCost(
      input.hardware.powerConsumption.watts,
      input.electricity.pricePerKwh,
      1
    );
    const dailyRevenueUsd = dailyRevenueBtc * input.btcPrice;
    const dailyProfitUsd = dailyRevenueUsd - dailyElectricityCostUsd;
    const dailyProfitMargin = dailyRevenueUsd > 0 ? (dailyProfitUsd / dailyRevenueUsd) * 100 : -100;

    // Monthly calculations
    const monthlyRevenueBtc = dailyRevenueBtc * this.DAYS_PER_MONTH;
    const monthlyElectricityCostUsd = dailyElectricityCostUsd * this.DAYS_PER_MONTH;
    const monthlyRevenueUsd = monthlyRevenueBtc * input.btcPrice;
    const monthlyProfitUsd = monthlyRevenueUsd - monthlyElectricityCostUsd;
    const monthlyProfitMargin = monthlyRevenueUsd > 0 ? (monthlyProfitUsd / monthlyRevenueUsd) * 100 : -100;

    // Yearly calculations
    const yearlyRevenueBtc = dailyRevenueBtc * this.DAYS_PER_YEAR;
    const yearlyElectricityCostUsd = dailyElectricityCostUsd * this.DAYS_PER_YEAR;
    const yearlyRevenueUsd = yearlyRevenueBtc * input.btcPrice;
    const yearlyProfitUsd = yearlyRevenueUsd - yearlyElectricityCostUsd;
    const yearlyProfitMargin = yearlyRevenueUsd > 0 ? (yearlyProfitUsd / yearlyRevenueUsd) * 100 : -100;

    // ROI calculation
    let roi: number | undefined;
    if (input.hardware.initialCost && monthlyProfitUsd > 0) {
      roi = input.hardware.initialCost / monthlyProfitUsd;
    }

    // Breakeven calculations
    const breakevenBtcPrice = this.calculateBreakevenBtcPrice(dailyRevenueBtc, dailyElectricityCostUsd);
    const maxElectricityPrice = this.calculateMaxElectricityPrice(
      input.hardware.powerConsumption.watts,
      dailyRevenueBtc,
      input.btcPrice
    );

    return {
      daily: {
        revenue: dailyRevenueBtc,
        electricityCost: dailyElectricityCostUsd,
        profit: dailyProfitUsd,
        profitMargin: dailyProfitMargin
      },
      monthly: {
        revenue: monthlyRevenueBtc,
        electricityCost: monthlyElectricityCostUsd,
        profit: monthlyProfitUsd,
        profitMargin: monthlyProfitMargin
      },
      yearly: {
        revenue: yearlyRevenueBtc,
        electricityCost: yearlyElectricityCostUsd,
        profit: yearlyProfitUsd,
        profitMargin: yearlyProfitMargin,
        roi
      },
      breakeven: {
        btcPrice: breakevenBtcPrice,
        electricityPrice: maxElectricityPrice
      }
    };
  }

  /**
   * Quick profitability check - optimized for speed
   */
  isProfitable(input: CalculationInput): boolean {
    const hashrateHz = this.normalizeHashrate(input.hardware.hashrate);
    const dailyRevenueBtc = this.calculateRevenue(hashrateHz, input.network, input.poolFee, 1);
    const dailyElectricityCostUsd = this.calculateElectricityCost(
      input.hardware.powerConsumption.watts,
      input.electricity.pricePerKwh,
      1
    );
    const dailyRevenueUsd = dailyRevenueBtc * input.btcPrice;
    
    return dailyRevenueUsd > dailyElectricityCostUsd;
  }

  /**
   * Calculate efficiency metrics
   */
  calculateEfficiency(hardware: MiningHardware): {
    readonly hashPerWatt: number;
    readonly efficiency: number; // J/TH
  } {
    const hashrateHz = this.normalizeHashrate(hardware.hashrate);
    const hashPerWatt = hashrateHz / hardware.powerConsumption.watts;
    
    // Convert to J/TH (standard efficiency metric)
    const efficiency = hardware.powerConsumption.efficiency || 
      (hardware.powerConsumption.watts / (hashrateHz / 1e12));
    
    return {
      hashPerWatt,
      efficiency
    };
  }

  /**
   * Compare multiple hardware options
   */
  compareHardware(
    hardwareOptions: MiningHardware[],
    network: NetworkStats,
    electricity: ElectricityCost,
    btcPrice: number,
    poolFee: number
  ): Array<{ hardware: MiningHardware; result: ProfitabilityResult; rank: number }> {
    const comparisons = hardwareOptions.map(hardware => {
      const result = this.calculate({
        hardware,
        network,
        electricity,
        btcPrice,
        poolFee
      });
      
      return { hardware, result };
    });

    // Sort by daily profit (descending)
    comparisons.sort((a, b) => b.result.daily.profit - a.result.daily.profit);

    // Add rank
    return comparisons.map((comparison, index) => ({
      ...comparison,
      rank: index + 1
    }));
  }
}

// Factory function for creating calculator instances
export function createProfitabilityCalculator(): ProfitabilityCalculator {
  return new ProfitabilityCalculator();
}

// Pre-defined hardware configurations for common miners
export const COMMON_HARDWARE: Record<string, MiningHardware> = {
  'ANTMINER_S19_PRO': {
    name: 'Antminer S19 Pro',
    hashrate: { value: 110, unit: 'TH/s' },
    powerConsumption: { watts: 3250, efficiency: 29.5 },
    initialCost: 2500,
    lifespan: 36
  },
  'ANTMINER_S19J_PRO': {
    name: 'Antminer S19j Pro',
    hashrate: { value: 100, unit: 'TH/s' },
    powerConsumption: { watts: 3068, efficiency: 30.7 },
    initialCost: 2200,
    lifespan: 36
  },
  'WHATSMINER_M30S': {
    name: 'WhatsMiner M30S++',
    hashrate: { value: 112, unit: 'TH/s' },
    powerConsumption: { watts: 3472, efficiency: 31 },
    initialCost: 2400,
    lifespan: 36
  },
  'ANTMINER_S21': {
    name: 'Antminer S21',
    hashrate: { value: 200, unit: 'TH/s' },
    powerConsumption: { watts: 3550, efficiency: 17.8 },
    initialCost: 4500,
    lifespan: 36
  }
};
