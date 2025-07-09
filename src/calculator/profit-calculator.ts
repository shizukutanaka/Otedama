// Profit calculator for mining revenue prediction (Uncle Bob clean architecture)
import { createComponentLogger } from '../logging/logger';

const logger = createComponentLogger('profit-calculator');

// Mining hardware specifications
export interface MiningHardware {
  name: string;
  hashrate: number; // H/s
  powerConsumption: number; // Watts
  efficiency: number; // J/TH
  cost: number; // USD
}

// Electricity cost configuration
export interface ElectricityCost {
  rate: number; // USD per kWh
  tieredRates?: Array<{
    maxKWh: number;
    rate: number;
  }>;
  timeOfUseRates?: Array<{
    startHour: number;
    endHour: number;
    rate: number;
  }>;
}

// Mining calculation parameters
export interface MiningParameters {
  difficulty: number;
  blockReward: number;
  blockTime: number; // seconds
  poolFee: number; // percentage
  price: number; // USD per coin
}

// Profitability result
export interface ProfitabilityResult {
  // Revenue
  coinsPerDay: number;
  revenuePerDay: number;
  revenuePerMonth: number;
  revenuePerYear: number;
  
  // Costs
  electricityCostPerDay: number;
  electricityCostPerMonth: number;
  electricityCostPerYear: number;
  
  // Profit
  profitPerDay: number;
  profitPerMonth: number;
  profitPerYear: number;
  
  // ROI
  roiDays: number;
  roiMonths: number;
  
  // Efficiency
  profitMargin: number; // percentage
  costPerCoin: number;
  breakevenPrice: number;
}

// Profit calculator
export class ProfitCalculator {
  constructor() {}
  
  // Calculate mining profitability
  calculate(
    hardware: MiningHardware,
    electricity: ElectricityCost,
    params: MiningParameters
  ): ProfitabilityResult {
    // Calculate expected coins per day
    const networkHashrate = this.difficultyToHashrate(params.difficulty, params.blockTime);
    const blocksPerDay = 86400 / params.blockTime;
    const poolShare = hardware.hashrate / networkHashrate;
    const expectedBlocksPerDay = blocksPerDay * poolShare;
    const coinsPerDay = expectedBlocksPerDay * params.blockReward * (1 - params.poolFee / 100);
    
    // Calculate revenue
    const revenuePerDay = coinsPerDay * params.price;
    const revenuePerMonth = revenuePerDay * 30;
    const revenuePerYear = revenuePerDay * 365;
    
    // Calculate electricity cost
    const powerKW = hardware.powerConsumption / 1000;
    const kWhPerDay = powerKW * 24;
    const electricityCostPerDay = this.calculateElectricityCost(kWhPerDay, electricity);
    const electricityCostPerMonth = electricityCostPerDay * 30;
    const electricityCostPerYear = electricityCostPerDay * 365;
    
    // Calculate profit
    const profitPerDay = revenuePerDay - electricityCostPerDay;
    const profitPerMonth = profitPerDay * 30;
    const profitPerYear = profitPerDay * 365;
    
    // Calculate ROI
    const roiDays = hardware.cost > 0 && profitPerDay > 0 ? 
      hardware.cost / profitPerDay : Infinity;
    const roiMonths = roiDays / 30;
    
    // Calculate efficiency metrics
    const profitMargin = revenuePerDay > 0 ? 
      (profitPerDay / revenuePerDay) * 100 : 0;
    const costPerCoin = coinsPerDay > 0 ? 
      electricityCostPerDay / coinsPerDay : 0;
    const breakevenPrice = coinsPerDay > 0 ? 
      electricityCostPerDay / (coinsPerDay * (1 - params.poolFee / 100)) : 0;
    
    return {
      coinsPerDay,
      revenuePerDay,
      revenuePerMonth,
      revenuePerYear,
      electricityCostPerDay,
      electricityCostPerMonth,
      electricityCostPerYear,
      profitPerDay,
      profitPerMonth,
      profitPerYear,
      roiDays,
      roiMonths,
      profitMargin,
      costPerCoin,
      breakevenPrice
    };
  }
  
  // Calculate electricity cost with tiered/TOU rates
  private calculateElectricityCost(
    kWhPerDay: number,
    electricity: ElectricityCost
  ): number {
    // Time of use rates
    if (electricity.timeOfUseRates && electricity.timeOfUseRates.length > 0) {
      let totalCost = 0;
      
      for (const period of electricity.timeOfUseRates) {
        const hours = this.getHoursInPeriod(period.startHour, period.endHour);
        const kWhInPeriod = (kWhPerDay / 24) * hours;
        totalCost += kWhInPeriod * period.rate;
      }
      
      return totalCost;
    }
    
    // Tiered rates
    if (electricity.tieredRates && electricity.tieredRates.length > 0) {
      let totalCost = 0;
      let remainingKWh = kWhPerDay;
      
      for (const tier of electricity.tieredRates) {
        const kWhInTier = Math.min(remainingKWh, tier.maxKWh);
        totalCost += kWhInTier * tier.rate;
        remainingKWh -= kWhInTier;
        
        if (remainingKWh <= 0) break;
      }
      
      return totalCost;
    }
    
    // Simple flat rate
    return kWhPerDay * electricity.rate;
  }
  
  // Calculate hours in time period
  private getHoursInPeriod(startHour: number, endHour: number): number {
    if (endHour >= startHour) {
      return endHour - startHour;
    } else {
      // Crosses midnight
      return (24 - startHour) + endHour;
    }
  }
  
  // Convert difficulty to hashrate
  private difficultyToHashrate(difficulty: number, blockTime: number): number {
    return difficulty * Math.pow(2, 32) / blockTime;
  }
  
  // Calculate required hashrate for target income
  calculateRequiredHashrate(
    targetIncomePerDay: number,
    electricity: ElectricityCost,
    params: MiningParameters,
    hardwareEfficiency: number // J/TH
  ): {
    requiredHashrate: number;
    powerConsumption: number;
    electricityCost: number;
    netProfit: number;
  } {
    // Calculate required coins per day
    const requiredCoins = targetIncomePerDay / params.price;
    const coinsAfterFee = requiredCoins / (1 - params.poolFee / 100);
    
    // Calculate required hashrate
    const networkHashrate = this.difficultyToHashrate(params.difficulty, params.blockTime);
    const blocksPerDay = 86400 / params.blockTime;
    const requiredBlocksPerDay = coinsAfterFee / params.blockReward;
    const requiredPoolShare = requiredBlocksPerDay / blocksPerDay;
    const requiredHashrate = requiredPoolShare * networkHashrate;
    
    // Calculate power consumption
    const powerConsumption = (requiredHashrate / 1e12) * hardwareEfficiency; // Watts
    const kWhPerDay = (powerConsumption / 1000) * 24;
    const electricityCost = this.calculateElectricityCost(kWhPerDay, electricity);
    
    const netProfit = targetIncomePerDay - electricityCost;
    
    return {
      requiredHashrate,
      powerConsumption,
      electricityCost,
      netProfit
    };
  }
  
  // What-if analysis
  whatIf(
    baseline: ProfitabilityResult,
    hardware: MiningHardware,
    electricity: ElectricityCost,
    params: MiningParameters,
    changes: {
      difficulty?: number;
      price?: number;
      electricityRate?: number;
      hashrate?: number;
    }
  ): {
    baseline: ProfitabilityResult;
    scenario: ProfitabilityResult;
    impact: {
      profitChange: number;
      profitChangePercent: number;
      roiChange: number;
    };
  } {
    // Apply changes
    const newParams = { ...params };
    if (changes.difficulty !== undefined) {
      newParams.difficulty *= (1 + changes.difficulty / 100);
    }
    if (changes.price !== undefined) {
      newParams.price *= (1 + changes.price / 100);
    }
    
    const newElectricity = { ...electricity };
    if (changes.electricityRate !== undefined) {
      newElectricity.rate *= (1 + changes.electricityRate / 100);
    }
    
    const newHardware = { ...hardware };
    if (changes.hashrate !== undefined) {
      newHardware.hashrate *= (1 + changes.hashrate / 100);
    }
    
    // Calculate new scenario
    const scenario = this.calculate(newHardware, newElectricity, newParams);
    
    // Calculate impact
    const profitChange = scenario.profitPerDay - baseline.profitPerDay;
    const profitChangePercent = baseline.profitPerDay !== 0 ? 
      (profitChange / baseline.profitPerDay) * 100 : 0;
    const roiChange = scenario.roiDays - baseline.roiDays;
    
    return {
      baseline,
      scenario,
      impact: {
        profitChange,
        profitChangePercent,
        roiChange
      }
    };
  }
}

// Hardware database
export class HardwareDatabase {
  private static readonly HARDWARE: MiningHardware[] = [
    // Bitcoin ASICs
    {
      name: 'Antminer S19 Pro',
      hashrate: 110e12, // 110 TH/s
      powerConsumption: 3250,
      efficiency: 29.5,
      cost: 5000
    },
    {
      name: 'Antminer S19j Pro',
      hashrate: 100e12, // 100 TH/s
      powerConsumption: 3050,
      efficiency: 30.5,
      cost: 4000
    },
    {
      name: 'Whatsminer M30S++',
      hashrate: 112e12, // 112 TH/s
      powerConsumption: 3472,
      efficiency: 31,
      cost: 4500
    },
    {
      name: 'Antminer S17 Pro',
      hashrate: 56e12, // 56 TH/s
      powerConsumption: 2094,
      efficiency: 37.4,
      cost: 2000
    },
    
    // Litecoin ASICs
    {
      name: 'Antminer L7',
      hashrate: 9500e6, // 9500 MH/s
      powerConsumption: 3425,
      efficiency: 0.36,
      cost: 18000
    },
    {
      name: 'Innosilicon A6+ LTCMaster',
      hashrate: 2200e6, // 2200 MH/s
      powerConsumption: 2100,
      efficiency: 0.95,
      cost: 3000
    }
  ];
  
  // Get all hardware
  static getAll(): MiningHardware[] {
    return [...this.HARDWARE];
  }
  
  // Get hardware by name
  static getByName(name: string): MiningHardware | undefined {
    return this.HARDWARE.find(hw => hw.name === name);
  }
  
  // Get hardware for algorithm
  static getForAlgorithm(algorithm: string): MiningHardware[] {
    // Simplified - in production would have algorithm mapping
    if (algorithm === 'sha256') {
      return this.HARDWARE.filter(hw => hw.name.includes('Antminer S') || hw.name.includes('Whatsminer'));
    } else if (algorithm === 'scrypt') {
      return this.HARDWARE.filter(hw => hw.name.includes('L7') || hw.name.includes('LTCMaster'));
    }
    
    return [];
  }
}

// Mining calculator with historical data
export class HistoricalProfitCalculator {
  constructor(
    private calculator: ProfitCalculator
  ) {}
  
  // Calculate profitability over time period
  calculateHistorical(
    hardware: MiningHardware,
    electricity: ElectricityCost,
    historicalData: Array<{
      date: Date;
      difficulty: number;
      price: number;
      blockReward: number;
    }>,
    poolFee: number,
    blockTime: number
  ): Array<{
    date: Date;
    profitability: ProfitabilityResult;
  }> {
    const results = [];
    
    for (const data of historicalData) {
      const params: MiningParameters = {
        difficulty: data.difficulty,
        blockReward: data.blockReward,
        blockTime,
        poolFee,
        price: data.price
      };
      
      const profitability = this.calculator.calculate(
        hardware,
        electricity,
        params
      );
      
      results.push({
        date: data.date,
        profitability
      });
    }
    
    return results;
  }
  
  // Calculate average profitability
  calculateAverage(
    results: Array<{ profitability: ProfitabilityResult }>
  ): ProfitabilityResult {
    const count = results.length;
    if (count === 0) {
      throw new Error('No results to average');
    }
    
    const sum = results.reduce((acc, r) => ({
      coinsPerDay: acc.coinsPerDay + r.profitability.coinsPerDay,
      revenuePerDay: acc.revenuePerDay + r.profitability.revenuePerDay,
      revenuePerMonth: acc.revenuePerMonth + r.profitability.revenuePerMonth,
      revenuePerYear: acc.revenuePerYear + r.profitability.revenuePerYear,
      electricityCostPerDay: acc.electricityCostPerDay + r.profitability.electricityCostPerDay,
      electricityCostPerMonth: acc.electricityCostPerMonth + r.profitability.electricityCostPerMonth,
      electricityCostPerYear: acc.electricityCostPerYear + r.profitability.electricityCostPerYear,
      profitPerDay: acc.profitPerDay + r.profitability.profitPerDay,
      profitPerMonth: acc.profitPerMonth + r.profitability.profitPerMonth,
      profitPerYear: acc.profitPerYear + r.profitability.profitPerYear,
      roiDays: acc.roiDays + r.profitability.roiDays,
      roiMonths: acc.roiMonths + r.profitability.roiMonths,
      profitMargin: acc.profitMargin + r.profitability.profitMargin,
      costPerCoin: acc.costPerCoin + r.profitability.costPerCoin,
      breakevenPrice: acc.breakevenPrice + r.profitability.breakevenPrice
    }), {
      coinsPerDay: 0,
      revenuePerDay: 0,
      revenuePerMonth: 0,
      revenuePerYear: 0,
      electricityCostPerDay: 0,
      electricityCostPerMonth: 0,
      electricityCostPerYear: 0,
      profitPerDay: 0,
      profitPerMonth: 0,
      profitPerYear: 0,
      roiDays: 0,
      roiMonths: 0,
      profitMargin: 0,
      costPerCoin: 0,
      breakevenPrice: 0
    });
    
    // Calculate averages
    return {
      coinsPerDay: sum.coinsPerDay / count,
      revenuePerDay: sum.revenuePerDay / count,
      revenuePerMonth: sum.revenuePerMonth / count,
      revenuePerYear: sum.revenuePerYear / count,
      electricityCostPerDay: sum.electricityCostPerDay / count,
      electricityCostPerMonth: sum.electricityCostPerMonth / count,
      electricityCostPerYear: sum.electricityCostPerYear / count,
      profitPerDay: sum.profitPerDay / count,
      profitPerMonth: sum.profitPerMonth / count,
      profitPerYear: sum.profitPerYear / count,
      roiDays: sum.roiDays / count,
      roiMonths: sum.roiMonths / count,
      profitMargin: sum.profitMargin / count,
      costPerCoin: sum.costPerCoin / count,
      breakevenPrice: sum.breakevenPrice / count
    };
  }
}
