/**
 * Profitability Calculator Tests
 */

import { 
  ProfitabilityCalculator,
  createProfitabilityCalculator,
  COMMON_HARDWARE,
  CalculationInput,
  MiningHardware
} from '../profitability-calculator';

describe('ProfitabilityCalculator', () => {
  let calculator: ProfitabilityCalculator;

  beforeEach(() => {
    calculator = createProfitabilityCalculator();
  });

  describe('Basic Calculations', () => {
    const testInput: CalculationInput = {
      hardware: {
        name: 'Test Miner',
        hashrate: { value: 100, unit: 'TH/s' },
        powerConsumption: { watts: 3000 },
        initialCost: 2000
      },
      network: {
        difficulty: 50000000000000,
        networkHashrate: 500000000000000000, // 500 EH/s
        blockReward: 6.25,
        blockTime: 600
      },
      electricity: {
        pricePerKwh: 0.10,
        currency: 'USD'
      },
      btcPrice: 50000,
      poolFee: 1.0
    };

    test('should calculate daily profitability correctly', () => {
      const result = calculator.calculate(testInput);
      
      expect(result.daily.revenue).toBeGreaterThan(0);
      expect(result.daily.electricityCost).toBeGreaterThan(0);
      expect(result.daily.profit).toBeDefined();
      expect(result.daily.profitMargin).toBeDefined();
    });

    test('should calculate monthly profitability correctly', () => {
      const result = calculator.calculate(testInput);
      
      expect(result.monthly.revenue).toBeCloseTo(result.daily.revenue * 30.44, 6);
      expect(result.monthly.electricityCost).toBeCloseTo(result.daily.electricityCost * 30.44, 2);
      expect(result.monthly.profit).toBeDefined();
    });

    test('should calculate yearly profitability correctly', () => {
      const result = calculator.calculate(testInput);
      
      expect(result.yearly.revenue).toBeCloseTo(result.daily.revenue * 365.25, 6);
      expect(result.yearly.electricityCost).toBeCloseTo(result.daily.electricityCost * 365.25, 2);
      expect(result.yearly.roi).toBeDefined();
    });

    test('should calculate breakeven points correctly', () => {
      const result = calculator.calculate(testInput);
      
      expect(result.breakeven.btcPrice).toBeGreaterThan(0);
      expect(result.breakeven.electricityPrice).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases', () => {
    test('should handle zero hashrate', () => {
      const input: CalculationInput = {
        hardware: {
          name: 'No Hash',
          hashrate: { value: 0, unit: 'TH/s' },
          powerConsumption: { watts: 1000 }
        },
        network: {
          difficulty: 50000000000000,
          networkHashrate: 500000000000000000,
          blockReward: 6.25,
          blockTime: 600
        },
        electricity: { pricePerKwh: 0.10, currency: 'USD' },
        btcPrice: 50000,
        poolFee: 1.0
      };

      const result = calculator.calculate(input);
      expect(result.daily.revenue).toBe(0);
      expect(result.daily.electricityCost).toBeGreaterThan(0);
      expect(result.daily.profit).toBeLessThan(0);
    });

    test('should handle zero power consumption', () => {
      const input: CalculationInput = {
        hardware: {
          name: 'No Power',
          hashrate: { value: 100, unit: 'TH/s' },
          powerConsumption: { watts: 0 }
        },
        network: {
          difficulty: 50000000000000,
          networkHashrate: 500000000000000000,
          blockReward: 6.25,
          blockTime: 600
        },
        electricity: { pricePerKwh: 0.10, currency: 'USD' },
        btcPrice: 50000,
        poolFee: 1.0
      };

      const result = calculator.calculate(input);
      expect(result.daily.electricityCost).toBe(0);
      expect(result.daily.profit).toEqual(result.daily.revenue * 50000);
    });

    test('should handle 100% pool fee', () => {
      const input: CalculationInput = {
        hardware: COMMON_HARDWARE.ANTMINER_S19_PRO,
        network: {
          difficulty: 50000000000000,
          networkHashrate: 500000000000000000,
          blockReward: 6.25,
          blockTime: 600
        },
        electricity: { pricePerKwh: 0.10, currency: 'USD' },
        btcPrice: 50000,
        poolFee: 100.0
      };

      const result = calculator.calculate(input);
      expect(result.daily.revenue).toBe(0);
      expect(result.daily.profit).toBeLessThan(0);
    });
  });

  describe('Hashrate Unit Conversion', () => {
    test('should convert different hashrate units correctly', () => {
      const testCases = [
        { value: 1, unit: 'H/s' as const, expected: 1 },
        { value: 1, unit: 'KH/s' as const, expected: 1000 },
        { value: 1, unit: 'MH/s' as const, expected: 1000000 },
        { value: 1, unit: 'GH/s' as const, expected: 1000000000 },
        { value: 1, unit: 'TH/s' as const, expected: 1000000000000 },
        { value: 1, unit: 'PH/s' as const, expected: 1000000000000000 },
        { value: 1, unit: 'EH/s' as const, expected: 1000000000000000000 }
      ];

      testCases.forEach(({ value, unit, expected }) => {
        const input: CalculationInput = {
          hardware: {
            name: 'Test',
            hashrate: { value, unit },
            powerConsumption: { watts: 1000 }
          },
          network: {
            difficulty: 1,
            networkHashrate: expected,
            blockReward: 6.25,
            blockTime: 600
          },
          electricity: { pricePerKwh: 0.10, currency: 'USD' },
          btcPrice: 50000,
          poolFee: 0
        };

        const result = calculator.calculate(input);
        // With equal hashrate to network, should get close to full block reward
        expect(result.daily.revenue).toBeGreaterThan(0);
      });
    });
  });

  describe('Quick Profitability Check', () => {
    test('should return true for profitable mining', () => {
      const input: CalculationInput = {
        hardware: COMMON_HARDWARE.ANTMINER_S19_PRO,
        network: {
          difficulty: 10000000000000, // Lower difficulty = more profitable
          networkHashrate: 100000000000000000,
          blockReward: 6.25,
          blockTime: 600
        },
        electricity: { pricePerKwh: 0.05, currency: 'USD' }, // Cheap electricity
        btcPrice: 60000, // High BTC price
        poolFee: 1.0
      };

      const isProfitable = calculator.isProfitable(input);
      expect(isProfitable).toBe(true);
    });

    test('should return false for unprofitable mining', () => {
      const input: CalculationInput = {
        hardware: COMMON_HARDWARE.ANTMINER_S19_PRO,
        network: {
          difficulty: 100000000000000000, // Very high difficulty
          networkHashrate: 1000000000000000000,
          blockReward: 6.25,
          blockTime: 600
        },
        electricity: { pricePerKwh: 0.50, currency: 'USD' }, // Expensive electricity
        btcPrice: 20000, // Low BTC price
        poolFee: 5.0 // High pool fee
      };

      const isProfitable = calculator.isProfitable(input);
      expect(isProfitable).toBe(false);
    });
  });

  describe('Hardware Comparison', () => {
    test('should compare multiple hardware options correctly', () => {
      const hardwareOptions = [
        COMMON_HARDWARE.ANTMINER_S19_PRO,
        COMMON_HARDWARE.ANTMINER_S19J_PRO,
        COMMON_HARDWARE.WHATSMINER_M30S
      ];

      const network = {
        difficulty: 50000000000000,
        networkHashrate: 500000000000000000,
        blockReward: 6.25,
        blockTime: 600
      };

      const electricity = { pricePerKwh: 0.10, currency: 'USD' };

      const comparison = calculator.compareHardware(
        hardwareOptions,
        network,
        electricity,
        50000,
        1.0
      );

      expect(comparison).toHaveLength(3);
      expect(comparison[0].rank).toBe(1);
      expect(comparison[1].rank).toBe(2);
      expect(comparison[2].rank).toBe(3);

      // First should be most profitable
      expect(comparison[0].result.daily.profit).toBeGreaterThanOrEqual(
        comparison[1].result.daily.profit
      );
      expect(comparison[1].result.daily.profit).toBeGreaterThanOrEqual(
        comparison[2].result.daily.profit
      );
    });
  });

  describe('Efficiency Calculations', () => {
    test('should calculate efficiency metrics correctly', () => {
      const hardware = COMMON_HARDWARE.ANTMINER_S19_PRO;
      const efficiency = calculator.calculateEfficiency(hardware);

      expect(efficiency.hashPerWatt).toBeGreaterThan(0);
      expect(efficiency.efficiency).toBeGreaterThan(0);
      expect(efficiency.efficiency).toBeCloseTo(29.5, 1); // S19 Pro efficiency
    });
  });

  describe('Real World Scenarios', () => {
    test('should handle current Bitcoin network conditions', () => {
      const input: CalculationInput = {
        hardware: COMMON_HARDWARE.ANTMINER_S21, // Latest hardware
        network: {
          difficulty: 72000000000000000, // Approximate current difficulty
          networkHashrate: 500000000000000000, // ~500 EH/s
          blockReward: 6.25,
          blockTime: 600
        },
        electricity: { pricePerKwh: 0.08, currency: 'USD' }, // Competitive rate
        btcPrice: 45000, // Reasonable BTC price
        poolFee: 1.0
      };

      const result = calculator.calculate(input);
      
      // Should generate reasonable results
      expect(result.daily.revenue).toBeGreaterThan(0);
      expect(result.daily.revenue).toBeLessThan(1); // Less than 1 BTC per day
      expect(result.breakeven.btcPrice).toBeGreaterThan(0);
      expect(result.breakeven.btcPrice).toBeLessThan(100000); // Reasonable breakeven
    });

    test('should handle bear market conditions', () => {
      const input: CalculationInput = {
        hardware: COMMON_HARDWARE.ANTMINER_S19_PRO,
        network: {
          difficulty: 80000000000000000, // High difficulty
          networkHashrate: 600000000000000000,
          blockReward: 6.25,
          blockTime: 600
        },
        electricity: { pricePerKwh: 0.12, currency: 'USD' }, // Higher electricity cost
        btcPrice: 25000, // Bear market price
        poolFee: 2.0 // Higher pool fee
      };

      const result = calculator.calculate(input);
      
      // Might be unprofitable in bear market
      expect(result.daily.profit).toBeDefined();
      expect(result.breakeven.btcPrice).toBeGreaterThan(25000);
    });
  });
});
