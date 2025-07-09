/**
 * 電力コスト計算・ROI分析システム
 * 設計思想: John Carmack (正確性), Rob Pike (シンプル), Robert C. Martin (保守性)
 * 
 * 機能:
 * - 詳細な電力消費計算
 * - リアルタイム電力コスト監視
 * - ROI分析と投資回収期間
 * - 電力効率最適化
 * - 時間帯別電力料金対応
 * - 環境影響計算
 * - コスト予測
 */

import { EventEmitter } from 'events';

// === 型定義 ===
export interface PowerConsumption {
  deviceId: string;
  deviceType: 'CPU' | 'GPU' | 'ASIC' | 'SYSTEM';
  model: string;
  basePowerWatts: number;
  idlePowerWatts: number;
  maxPowerWatts: number;
  currentPowerWatts: number;
  powerEfficiency: number; // % (0-100)
  utilizationRate: number; // % (0-100)
  timestamp: number;
}

export interface ElectricityRate {
  regionId: string;
  provider: string;
  currency: string;
  rateStructure: 'flat' | 'tiered' | 'time_of_use' | 'demand';
  rates: {
    standard: number; // per kWh
    peak?: number;
    offPeak?: number;
    super_offPeak?: number;
  };
  demandCharge?: number; // per kW
  fixedCharges: {
    monthly: number;
    daily: number;
  };
  taxes: number; // percentage
  timeZone: string;
  peakHours?: TimeRange[];
  offPeakHours?: TimeRange[];
}

export interface TimeRange {
  start: string; // HH:MM format
  end: string;
  days: number[]; // 0=Sunday, 1=Monday, etc.
}

export interface PowerCostCalculation {
  deviceId: string;
  period: {
    start: number;
    end: number;
    hours: number;
  };
  consumption: {
    totalKwh: number;
    peakKwh: number;
    offPeakKwh: number;
    averageWatts: number;
    maxWatts: number;
    utilizationRate: number;
  };
  costs: {
    energyCost: number;
    demandCost: number;
    fixedCosts: number;
    taxes: number;
    total: number;
  };
  efficiency: {
    powerEfficiency: number;
    costPerHash: number;
    hashPerWatt: number;
    hashPerDollar: number;
  };
}

export interface ROIAnalysis {
  deviceId: string;
  investment: {
    hardwareCost: number;
    setupCost: number;
    totalInitialCost: number;
  };
  revenue: {
    daily: number;
    monthly: number;
    annual: number;
  };
  expenses: {
    powerCost: number;
    maintenanceCost: number;
    poolFees: number;
    other: number;
    total: number;
  };
  netProfit: {
    daily: number;
    monthly: number;
    annual: number;
  };
  roi: {
    simple: number; // percentage
    annualized: number; // percentage
    paybackPeriod: number; // days
    breakEvenPoint: number; // timestamp
    npv: number; // Net Present Value
    irr: number; // Internal Rate of Return
  };
  sensitivity: {
    priceChange: Record<string, number>; // % price change -> ROI impact
    powerCostChange: Record<string, number>;
    difficultyChange: Record<string, number>;
  };
}

export interface EnvironmentalImpact {
  deviceId: string;
  carbonFootprint: {
    dailyKgCO2: number;
    monthlyKgCO2: number;
    annualKgCO2: number;
  };
  energySource: {
    renewable: number; // percentage
    coal: number;
    gas: number;
    nuclear: number;
    other: number;
  };
  waterUsage: {
    dailyLiters: number;
    coolingWater: number;
  };
  ewaste: {
    expectedLifespan: number; // months
    recyclingCost: number;
  };
}

export interface PowerOptimization {
  deviceId: string;
  currentSettings: {
    powerLimit: number; // percentage
    clockSpeed: number; // MHz
    memorySpeed: number; // MHz
    voltage: number; // V
  };
  recommendations: {
    optimalPowerLimit: number;
    expectedSavings: number; // USD per day
    performanceImpact: number; // percentage
    efficiency: number; // hash/watt improvement
  };
  scenarios: Array<{
    name: string;
    powerLimit: number;
    hashrate: number;
    powerConsumption: number;
    dailyCost: number;
    dailyProfit: number;
  }>;
}

// === 電力レート管理 ===
class ElectricityRateManager {
  private rates = new Map<string, ElectricityRate>();

  addRate(rate: ElectricityRate): void {
    this.rates.set(rate.regionId, rate);
  }

  getRate(regionId: string): ElectricityRate | null {
    return this.rates.get(regionId) || null;
  }

  calculateHourlyRate(regionId: string, timestamp: number): number {
    const rate = this.rates.get(regionId);
    if (!rate) return 0.10; // Default rate

    if (rate.rateStructure === 'flat') {
      return rate.rates.standard;
    }

    if (rate.rateStructure === 'time_of_use') {
      const hour = this.getHourInTimeZone(timestamp, rate.timeZone);
      const dayOfWeek = new Date(timestamp).getDay();

      // Check if current time is peak hours
      const isPeak = rate.peakHours?.some(range => 
        this.isTimeInRange(hour, dayOfWeek, range)
      ) || false;

      // Check if current time is off-peak hours
      const isOffPeak = rate.offPeakHours?.some(range =>
        this.isTimeInRange(hour, dayOfWeek, range)
      ) || false;

      if (isPeak && rate.rates.peak) {
        return rate.rates.peak;
      } else if (isOffPeak && rate.rates.offPeak) {
        return rate.rates.offPeak;
      } else if (rate.rates.super_offPeak) {
        return rate.rates.super_offPeak;
      }
    }

    return rate.rates.standard;
  }

  private getHourInTimeZone(timestamp: number, timeZone: string): number {
    return new Date(timestamp).getHours(); // Simplified - should use proper timezone conversion
  }

  private isTimeInRange(hour: number, dayOfWeek: number, range: TimeRange): boolean {
    if (!range.days.includes(dayOfWeek)) return false;

    const startHour = parseInt(range.start.split(':')[0]);
    const endHour = parseInt(range.end.split(':')[0]);

    if (startHour <= endHour) {
      return hour >= startHour && hour < endHour;
    } else {
      // Range crosses midnight
      return hour >= startHour || hour < endHour;
    }
  }

  // プリセット料金プラン
  static createStandardRates(): ElectricityRate[] {
    return [
      {
        regionId: 'us_residential',
        provider: 'Standard US Residential',
        currency: 'USD',
        rateStructure: 'tiered',
        rates: { standard: 0.12 },
        fixedCharges: { monthly: 15, daily: 0.5 },
        taxes: 8.5,
        timeZone: 'America/New_York'
      },
      {
        regionId: 'us_commercial',
        provider: 'US Commercial',
        currency: 'USD',
        rateStructure: 'time_of_use',
        rates: { 
          standard: 0.08, 
          peak: 0.15, 
          offPeak: 0.06,
          super_offPeak: 0.04
        },
        demandCharge: 12.50,
        fixedCharges: { monthly: 250, daily: 8.33 },
        taxes: 6.5,
        timeZone: 'America/New_York',
        peakHours: [
          { start: '16:00', end: '21:00', days: [1, 2, 3, 4, 5] }
        ],
        offPeakHours: [
          { start: '22:00', end: '06:00', days: [0, 1, 2, 3, 4, 5, 6] }
        ]
      },
      {
        regionId: 'iceland_renewable',
        provider: 'Iceland Renewable',
        currency: 'USD',
        rateStructure: 'flat',
        rates: { standard: 0.04 },
        fixedCharges: { monthly: 20, daily: 0.67 },
        taxes: 0,
        timeZone: 'Atlantic/Reykjavik'
      },
      {
        regionId: 'china_industrial',
        provider: 'China Industrial',
        currency: 'USD',
        rateStructure: 'tiered',
        rates: { standard: 0.08 },
        fixedCharges: { monthly: 50, daily: 1.67 },
        taxes: 3,
        timeZone: 'Asia/Shanghai'
      }
    ];
  }
}

// === メイン電力コスト計算システム ===
export class PowerCostAnalyzer extends EventEmitter {
  private powerData = new Map<string, PowerConsumption[]>();
  private rateManager = new ElectricityRateManager();
  private readonly MAX_HISTORY_HOURS = 8760; // 1 year
  private defaultRegion = 'us_residential';

  constructor() {
    super();
    
    // デフォルト料金プランを設定
    ElectricityRateManager.createStandardRates().forEach(rate => {
      this.rateManager.addRate(rate);
    });
  }

  // === 設定 ===
  setDefaultRegion(regionId: string): void {
    this.defaultRegion = regionId;
    this.emit('configChanged', { defaultRegion: regionId });
  }

  addElectricityRate(rate: ElectricityRate): void {
    this.rateManager.addRate(rate);
    this.emit('rateAdded', rate);
  }

  // === データ収集 ===
  recordPowerConsumption(consumption: PowerConsumption): void {
    const deviceData = this.powerData.get(consumption.deviceId) || [];
    deviceData.push(consumption);

    // データサイズ制限
    if (deviceData.length > this.MAX_HISTORY_HOURS) {
      deviceData.shift();
    }

    this.powerData.set(consumption.deviceId, deviceData);
    this.emit('powerDataRecorded', consumption);
  }

  // === コスト計算 ===
  calculatePowerCost(
    deviceId: string,
    startTime: number,
    endTime: number,
    regionId?: string
  ): PowerCostCalculation {
    const region = regionId || this.defaultRegion;
    const deviceData = this.powerData.get(deviceId) || [];
    const periodData = deviceData.filter(d => 
      d.timestamp >= startTime && d.timestamp <= endTime
    );

    if (periodData.length === 0) {
      throw new Error(`No power data found for device ${deviceId} in specified period`);
    }

    const hours = (endTime - startTime) / (1000 * 60 * 60);
    
    // 消費電力統計
    const totalKwh = this.calculateTotalKwh(periodData);
    const { peakKwh, offPeakKwh } = this.calculateTimeOfUseKwh(periodData, region);
    const averageWatts = totalKwh * 1000 / hours;
    const maxWatts = Math.max(...periodData.map(d => d.currentPowerWatts));
    const utilizationRate = periodData.reduce((sum, d) => sum + d.utilizationRate, 0) / periodData.length;

    // コスト計算
    const rate = this.rateManager.getRate(region);
    if (!rate) {
      throw new Error(`Electricity rate not found for region: ${region}`);
    }

    const energyCost = this.calculateEnergyCost(totalKwh, peakKwh, offPeakKwh, rate);
    const demandCost = this.calculateDemandCost(maxWatts, rate, hours);
    const fixedCosts = this.calculateFixedCosts(rate, hours);
    const taxes = (energyCost + demandCost + fixedCosts) * (rate.taxes / 100);
    const total = energyCost + demandCost + fixedCosts + taxes;

    // 効率指標
    const powerEfficiency = utilizationRate;
    const hashrate = this.estimateHashrate(deviceId, averageWatts);
    const costPerHash = total / (hashrate * hours);
    const hashPerWatt = hashrate / averageWatts;
    const hashPerDollar = hashrate / (total / hours);

    return {
      deviceId,
      period: { start: startTime, end: endTime, hours },
      consumption: {
        totalKwh,
        peakKwh,
        offPeakKwh,
        averageWatts,
        maxWatts,
        utilizationRate
      },
      costs: {
        energyCost,
        demandCost,
        fixedCosts,
        taxes,
        total
      },
      efficiency: {
        powerEfficiency,
        costPerHash,
        hashPerWatt,
        hashPerDollar
      }
    };
  }

  // === ROI分析 ===
  calculateROI(
    deviceId: string,
    hardwareCost: number,
    dailyRevenue: number,
    analysisMonths: number = 24,
    regionId?: string
  ): ROIAnalysis {
    const region = regionId || this.defaultRegion;
    
    // 過去30日間の平均電力コストを計算
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const now = Date.now();
    
    let dailyPowerCost: number;
    try {
      const powerCost = this.calculatePowerCost(deviceId, thirtyDaysAgo, now, region);
      dailyPowerCost = powerCost.costs.total / 30;
    } catch (error) {
      // フォールバック：推定計算
      dailyPowerCost = this.estimateDailyPowerCost(deviceId, region);
    }

    const setupCost = hardwareCost * 0.1; // 10% setup cost
    const totalInitialCost = hardwareCost + setupCost;

    // 運用コスト
    const maintenanceCost = hardwareCost * 0.05 / 365; // 5% annual maintenance
    const poolFees = dailyRevenue * 0.01; // 1% pool fees
    const otherCosts = 5; // $5/day misc costs

    const totalDailyExpenses = dailyPowerCost + maintenanceCost + poolFees + otherCosts;
    const dailyNetProfit = dailyRevenue - totalDailyExpenses;

    // ROI計算
    const simpleROI = (dailyNetProfit * 365) / totalInitialCost * 100;
    const paybackPeriod = totalInitialCost / (dailyNetProfit || 1);
    const breakEvenPoint = Date.now() + (paybackPeriod * 24 * 60 * 60 * 1000);

    // NPV & IRR計算
    const discountRate = 0.10; // 10% discount rate
    const npv = this.calculateNPV(dailyNetProfit, totalInitialCost, analysisMonths, discountRate);
    const irr = this.calculateIRR(dailyNetProfit, totalInitialCost, analysisMonths);

    // センシティビティ分析
    const sensitivity = this.calculateSensitivity(
      dailyRevenue,
      totalDailyExpenses,
      totalInitialCost
    );

    return {
      deviceId,
      investment: {
        hardwareCost,
        setupCost,
        totalInitialCost
      },
      revenue: {
        daily: dailyRevenue,
        monthly: dailyRevenue * 30,
        annual: dailyRevenue * 365
      },
      expenses: {
        powerCost: dailyPowerCost,
        maintenanceCost,
        poolFees,
        other: otherCosts,
        total: totalDailyExpenses
      },
      netProfit: {
        daily: dailyNetProfit,
        monthly: dailyNetProfit * 30,
        annual: dailyNetProfit * 365
      },
      roi: {
        simple: simpleROI,
        annualized: simpleROI,
        paybackPeriod,
        breakEvenPoint,
        npv,
        irr
      },
      sensitivity
    };
  }

  // === 環境影響分析 ===
  calculateEnvironmentalImpact(
    deviceId: string,
    regionId?: string,
    analysisMonths: number = 12
  ): EnvironmentalImpact {
    const region = regionId || this.defaultRegion;
    
    // 電力消費データ
    const deviceData = this.powerData.get(deviceId) || [];
    const recentData = deviceData.slice(-30); // Last 30 data points
    
    if (recentData.length === 0) {
      throw new Error(`No power data available for device ${deviceId}`);
    }

    const avgPowerKw = recentData.reduce((sum, d) => sum + d.currentPowerWatts, 0) / recentData.length / 1000;
    const dailyKwh = avgPowerKw * 24;

    // 地域のエネルギーミックス（簡略化）
    const energyMix = this.getRegionalEnergyMix(region);
    
    // CO2排出量計算（kg CO2 per kWh）
    const co2Factor = this.calculateCO2Factor(energyMix);
    const dailyKgCO2 = dailyKwh * co2Factor;

    // 水使用量（冷却用）
    const dailyWaterLiters = avgPowerKw * 24 * 2.5; // 2.5L per kWh for cooling

    // ハードウェア寿命
    const expectedLifespan = this.estimateHardwareLifespan(deviceId);
    const recyclingCost = 50; // $50 recycling cost

    return {
      deviceId,
      carbonFootprint: {
        dailyKgCO2,
        monthlyKgCO2: dailyKgCO2 * 30,
        annualKgCO2: dailyKgCO2 * 365
      },
      energySource: energyMix,
      waterUsage: {
        dailyLiters: dailyWaterLiters,
        coolingWater: dailyWaterLiters * 0.8
      },
      ewaste: {
        expectedLifespan,
        recyclingCost
      }
    };
  }

  // === 電力最適化 ===
  optimizePowerSettings(
    deviceId: string,
    targetEfficiency: 'max_profit' | 'max_efficiency' | 'balanced' = 'balanced'
  ): PowerOptimization {
    const deviceData = this.powerData.get(deviceId)?.slice(-1)[0];
    if (!deviceData) {
      throw new Error(`No current power data for device ${deviceId}`);
    }

    const currentSettings = {
      powerLimit: deviceData.powerEfficiency,
      clockSpeed: 1500, // Mock values
      memorySpeed: 1750,
      voltage: 1.2
    };

    // 異なる電力制限設定のシナリオ
    const scenarios = this.generatePowerScenarios(deviceData);
    
    // 最適設定を選択
    let optimalScenario = scenarios[0];
    switch (targetEfficiency) {
      case 'max_profit':
        optimalScenario = scenarios.reduce((best, current) => 
          current.dailyProfit > best.dailyProfit ? current : best
        );
        break;
      case 'max_efficiency':
        optimalScenario = scenarios.reduce((best, current) => 
          (current.hashrate / current.powerConsumption) > (best.hashrate / best.powerConsumption) ? current : best
        );
        break;
      case 'balanced':
        optimalScenario = scenarios.reduce((best, current) => {
          const currentScore = current.dailyProfit * 0.7 + (current.hashrate / current.powerConsumption) * 0.3;
          const bestScore = best.dailyProfit * 0.7 + (best.hashrate / best.powerConsumption) * 0.3;
          return currentScore > bestScore ? current : best;
        });
        break;
    }

    const currentProfit = scenarios.find(s => s.powerLimit === currentSettings.powerLimit)?.dailyProfit || 0;
    const expectedSavings = optimalScenario.dailyProfit - currentProfit;
    const performanceImpact = ((optimalScenario.hashrate - scenarios[0].hashrate) / scenarios[0].hashrate) * 100;
    const efficiencyImprovement = (optimalScenario.hashrate / optimalScenario.powerConsumption) / 
                                 (scenarios[0].hashrate / scenarios[0].powerConsumption) - 1;

    return {
      deviceId,
      currentSettings,
      recommendations: {
        optimalPowerLimit: optimalScenario.powerLimit,
        expectedSavings,
        performanceImpact,
        efficiency: efficiencyImprovement * 100
      },
      scenarios: scenarios.slice(0, 5) // Top 5 scenarios
    };
  }

  // === プライベートヘルパー ===
  private calculateTotalKwh(powerData: PowerConsumption[]): number {
    if (powerData.length === 0) return 0;

    let totalWattHours = 0;
    for (let i = 1; i < powerData.length; i++) {
      const timeDiff = (powerData[i].timestamp - powerData[i-1].timestamp) / (1000 * 60 * 60); // hours
      const avgWatts = (powerData[i].currentPowerWatts + powerData[i-1].currentPowerWatts) / 2;
      totalWattHours += avgWatts * timeDiff;
    }

    return totalWattHours / 1000; // Convert to kWh
  }

  private calculateTimeOfUseKwh(
    powerData: PowerConsumption[],
    regionId: string
  ): { peakKwh: number; offPeakKwh: number } {
    let peakKwh = 0;
    let offPeakKwh = 0;

    for (let i = 1; i < powerData.length; i++) {
      const timeDiff = (powerData[i].timestamp - powerData[i-1].timestamp) / (1000 * 60 * 60);
      const avgWatts = (powerData[i].currentPowerWatts + powerData[i-1].currentPowerWatts) / 2;
      const kwh = (avgWatts * timeDiff) / 1000;

      const hourlyRate = this.rateManager.calculateHourlyRate(regionId, powerData[i].timestamp);
      const standardRate = this.rateManager.getRate(regionId)?.rates.standard || 0.10;

      if (hourlyRate > standardRate) {
        peakKwh += kwh;
      } else {
        offPeakKwh += kwh;
      }
    }

    return { peakKwh, offPeakKwh };
  }

  private calculateEnergyCost(
    totalKwh: number,
    peakKwh: number,
    offPeakKwh: number,
    rate: ElectricityRate
  ): number {
    switch (rate.rateStructure) {
      case 'flat':
        return totalKwh * rate.rates.standard;
      
      case 'time_of_use':
        return (peakKwh * (rate.rates.peak || rate.rates.standard)) +
               (offPeakKwh * (rate.rates.offPeak || rate.rates.standard));
      
      case 'tiered':
        // Simplified tiered calculation
        const tier1 = Math.min(totalKwh, 500);
        const tier2 = Math.max(0, totalKwh - 500);
        return tier1 * rate.rates.standard + tier2 * (rate.rates.standard * 1.2);
      
      default:
        return totalKwh * rate.rates.standard;
    }
  }

  private calculateDemandCost(maxWatts: number, rate: ElectricityRate, hours: number): number {
    if (!rate.demandCharge) return 0;
    const maxKw = maxWatts / 1000;
    return maxKw * rate.demandCharge * (hours / (30 * 24)); // Prorate monthly demand charge
  }

  private calculateFixedCosts(rate: ElectricityRate, hours: number): number {
    const monthlyPortion = (hours / (30 * 24)) * rate.fixedCharges.monthly;
    const dailyPortion = (hours / 24) * rate.fixedCharges.daily;
    return monthlyPortion + dailyPortion;
  }

  private estimateHashrate(deviceId: string, watts: number): number {
    // Simplified hashrate estimation based on power consumption
    const deviceData = this.powerData.get(deviceId)?.[0];
    if (!deviceData) return 0;

    switch (deviceData.deviceType) {
      case 'ASIC':
        return watts * 35000000000; // 35 TH/s per kW for modern ASICs
      case 'GPU':
        return watts * 200000; // 200 MH/s per kW for GPUs
      case 'CPU':
        return watts * 50000; // 50 KH/s per kW for CPUs
      default:
        return 0;
    }
  }

  private estimateDailyPowerCost(deviceId: string, regionId: string): number {
    const rate = this.rateManager.getRate(regionId);
    if (!rate) return 10; // Default $10/day

    const deviceData = this.powerData.get(deviceId)?.[0];
    if (!deviceData) return 10;

    const dailyKwh = (deviceData.currentPowerWatts * 24) / 1000;
    return dailyKwh * rate.rates.standard * (1 + rate.taxes / 100);
  }

  private calculateNPV(
    dailyNetProfit: number,
    initialCost: number,
    months: number,
    discountRate: number
  ): number {
    let npv = -initialCost;
    const monthlyProfit = dailyNetProfit * 30;
    const monthlyRate = discountRate / 12;

    for (let month = 1; month <= months; month++) {
      npv += monthlyProfit / Math.pow(1 + monthlyRate, month);
    }

    return npv;
  }

  private calculateIRR(
    dailyNetProfit: number,
    initialCost: number,
    months: number
  ): number {
    const monthlyProfit = dailyNetProfit * 30;
    
    // Simplified IRR calculation using Newton's method
    let rate = 0.1; // Initial guess
    for (let i = 0; i < 10; i++) {
      let npv = -initialCost;
      let derivative = 0;

      for (let month = 1; month <= months; month++) {
        const factor = Math.pow(1 + rate, month);
        npv += monthlyProfit / factor;
        derivative -= (month * monthlyProfit) / (factor * (1 + rate));
      }

      const newRate = rate - npv / derivative;
      if (Math.abs(newRate - rate) < 0.0001) break;
      rate = newRate;
    }

    return rate * 12 * 100; // Convert to annual percentage
  }

  private calculateSensitivity(
    dailyRevenue: number,
    dailyExpenses: number,
    initialCost: number
  ): ROIAnalysis['sensitivity'] {
    const baseProfit = dailyRevenue - dailyExpenses;
    const baseROI = (baseProfit * 365) / initialCost * 100;

    const priceChanges = [-50, -25, -10, 0, 10, 25, 50];
    const powerCostChanges = [-20, -10, -5, 0, 5, 10, 20];
    const difficultyChanges = [-30, -15, -5, 0, 5, 15, 30];

    return {
      priceChange: Object.fromEntries(
        priceChanges.map(change => {
          const newRevenue = dailyRevenue * (1 + change / 100);
          const newProfit = newRevenue - dailyExpenses;
          const newROI = (newProfit * 365) / initialCost * 100;
          return [change.toString(), newROI - baseROI];
        })
      ),
      powerCostChange: Object.fromEntries(
        powerCostChanges.map(change => {
          const newExpenses = dailyExpenses * (1 + change / 100);
          const newProfit = dailyRevenue - newExpenses;
          const newROI = (newProfit * 365) / initialCost * 100;
          return [change.toString(), newROI - baseROI];
        })
      ),
      difficultyChange: Object.fromEntries(
        difficultyChanges.map(change => {
          const newRevenue = dailyRevenue / (1 + change / 100);
          const newProfit = newRevenue - dailyExpenses;
          const newROI = (newProfit * 365) / initialCost * 100;
          return [change.toString(), newROI - baseROI];
        })
      )
    };
  }

  private getRegionalEnergyMix(regionId: string): EnvironmentalImpact['energySource'] {
    const energyMixes: Record<string, EnvironmentalImpact['energySource']> = {
      'us_residential': { renewable: 20, coal: 20, gas: 40, nuclear: 20, other: 0 },
      'iceland_renewable': { renewable: 85, coal: 0, gas: 0, nuclear: 0, other: 15 },
      'china_industrial': { renewable: 15, coal: 60, gas: 15, nuclear: 5, other: 5 }
    };

    return energyMixes[regionId] || energyMixes['us_residential'];
  }

  private calculateCO2Factor(energyMix: EnvironmentalImpact['energySource']): number {
    // kg CO2 per kWh by energy source
    const co2Factors = {
      renewable: 0.02,
      coal: 0.95,
      gas: 0.49,
      nuclear: 0.012,
      other: 0.5
    };

    return (
      (energyMix.renewable / 100) * co2Factors.renewable +
      (energyMix.coal / 100) * co2Factors.coal +
      (energyMix.gas / 100) * co2Factors.gas +
      (energyMix.nuclear / 100) * co2Factors.nuclear +
      (energyMix.other / 100) * co2Factors.other
    );
  }

  private estimateHardwareLifespan(deviceId: string): number {
    const deviceData = this.powerData.get(deviceId)?.[0];
    if (!deviceData) return 36;

    switch (deviceData.deviceType) {
      case 'ASIC': return 24; // 2 years
      case 'GPU': return 36;  // 3 years
      case 'CPU': return 60;  // 5 years
      default: return 36;
    }
  }

  private generatePowerScenarios(deviceData: PowerConsumption): PowerOptimization['scenarios'] {
    const basePower = deviceData.maxPowerWatts;
    const scenarios: PowerOptimization['scenarios'] = [];

    for (let powerLimit = 60; powerLimit <= 100; powerLimit += 10) {
      const power = basePower * (powerLimit / 100);
      const hashrate = this.estimateHashrate(deviceData.deviceId, power);
      const dailyCost = (power * 24 * 0.10) / 1000; // $0.10/kWh
      const dailyRevenue = hashrate * 0.000001; // Simplified revenue calculation
      const dailyProfit = dailyRevenue - dailyCost;

      scenarios.push({
        name: `${powerLimit}% Power Limit`,
        powerLimit,
        hashrate,
        powerConsumption: power,
        dailyCost,
        dailyProfit
      });
    }

    return scenarios.sort((a, b) => b.dailyProfit - a.dailyProfit);
  }

  // === パブリックユーティリティ ===
  generateCostReport(deviceId: string, days: number = 30): string {
    const endTime = Date.now();
    const startTime = endTime - (days * 24 * 60 * 60 * 1000);

    try {
      const costCalc = this.calculatePowerCost(deviceId, startTime, endTime);
      const roi = this.calculateROI(deviceId, 5000, 50); // Example values
      const envImpact = this.calculateEnvironmentalImpact(deviceId);

      return [
        `=== Power Cost & ROI Report ===`,
        `Device: ${deviceId}`,
        `Period: ${days} days`,
        ``,
        `Power Consumption:`,
        `- Total: ${costCalc.consumption.totalKwh.toFixed(2)} kWh`,
        `- Average: ${costCalc.consumption.averageWatts.toFixed(0)} W`,
        `- Peak: ${costCalc.consumption.maxWatts.toFixed(0)} W`,
        `- Utilization: ${costCalc.consumption.utilizationRate.toFixed(1)}%`,
        ``,
        `Costs:`,
        `- Energy: $${costCalc.costs.energyCost.toFixed(2)}`,
        `- Demand: $${costCalc.costs.demandCost.toFixed(2)}`,
        `- Fixed: $${costCalc.costs.fixedCosts.toFixed(2)}`,
        `- Taxes: $${costCalc.costs.taxes.toFixed(2)}`,
        `- Total: $${costCalc.costs.total.toFixed(2)}`,
        `- Daily Average: $${(costCalc.costs.total / days).toFixed(2)}`,
        ``,
        `Efficiency:`,
        `- Hash/Watt: ${costCalc.efficiency.hashPerWatt.toFixed(0)}`,
        `- Hash/Dollar: ${costCalc.efficiency.hashPerDollar.toFixed(0)}`,
        `- Cost/Hash: $${costCalc.efficiency.costPerHash.toFixed(8)}`,
        ``,
        `ROI Analysis:`,
        `- Daily Net Profit: $${roi.netProfit.daily.toFixed(2)}`,
        `- Simple ROI: ${roi.roi.simple.toFixed(1)}%`,
        `- Payback Period: ${roi.roi.paybackPeriod.toFixed(0)} days`,
        `- NPV: $${roi.roi.npv.toFixed(2)}`,
        ``,
        `Environmental Impact:`,
        `- Daily CO2: ${envImpact.carbonFootprint.dailyKgCO2.toFixed(2)} kg`,
        `- Daily Water: ${envImpact.waterUsage.dailyLiters.toFixed(0)} L`,
        `- Renewable Energy: ${envImpact.energySource.renewable}%`
      ].join('\n');

    } catch (error) {
      return `Error generating report: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // === データエクスポート ===
  exportPowerData(deviceId: string): PowerConsumption[] {
    return this.powerData.get(deviceId) || [];
  }

  clearPowerData(deviceId?: string): void {
    if (deviceId) {
      this.powerData.delete(deviceId);
    } else {
      this.powerData.clear();
    }
    this.emit('dataCleared', { deviceId });
  }
}

// === ヘルパークラス ===
export class PowerCostHelper {
  static createMockPowerConsumption(deviceId: string, deviceType: PowerConsumption['deviceType']): PowerConsumption {
    const basePower = {
      'CPU': 150,
      'GPU': 300,
      'ASIC': 3250,
      'SYSTEM': 100
    };

    const power = basePower[deviceType];
    
    return {
      deviceId,
      deviceType,
      model: `Mock ${deviceType}`,
      basePowerWatts: power,
      idlePowerWatts: power * 0.1,
      maxPowerWatts: power * 1.2,
      currentPowerWatts: power * (0.8 + Math.random() * 0.2),
      powerEfficiency: 85 + Math.random() * 10,
      utilizationRate: 90 + Math.random() * 10,
      timestamp: Date.now()
    };
  }

  static formatCurrency(amount: number, currency: string = 'USD'): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency
    }).format(amount);
  }

  static formatPower(watts: number): string {
    if (watts >= 1000) {
      return `${(watts / 1000).toFixed(2)} kW`;
    }
    return `${watts.toFixed(0)} W`;
  }

  static formatEnergy(kwh: number): string {
    if (kwh >= 1000) {
      return `${(kwh / 1000).toFixed(2)} MWh`;
    }
    return `${kwh.toFixed(2)} kWh`;
  }

  static calculateEfficiencyRating(efficiency: PowerCostCalculation['efficiency']): string {
    const rating = efficiency.hashPerWatt;
    if (rating > 100) return 'Excellent';
    if (rating > 75) return 'Good';
    if (rating > 50) return 'Average';
    if (rating > 25) return 'Poor';
    return 'Very Poor';
  }
}

export default PowerCostAnalyzer;