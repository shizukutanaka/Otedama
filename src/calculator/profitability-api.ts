/**
 * Profitability API Routes
 * RESTful endpoints for mining profitability calculations
 */

import { Express, Request, Response } from 'express';
import { ProfitabilityService } from './profitability-service';
import { COMMON_HARDWARE, MiningHardware } from './profitability-calculator';
import { createComponentLogger } from '../logging/logger';

const logger = createComponentLogger('ProfitabilityAPI');

export interface ProfitabilityApiRoutes {
  setupRoutes(app: Express, profitabilityService: ProfitabilityService): void;
}

/**
 * Setup profitability calculation API routes
 */
export function setupProfitabilityRoutes(
  app: Express, 
  profitabilityService: ProfitabilityService
): void {
  const apiPrefix = '/api/v1/profitability';

  /**
   * GET /api/v1/profitability/calculate
   * Calculate profitability for given parameters
   */
  app.get(`${apiPrefix}/calculate`, async (req: Request, res: Response) => {
    try {
      const {
        hardware: hardwareName,
        hashrate,
        hashrateUnit = 'TH/s',
        powerConsumption,
        electricityPrice = 0.10,
        currency = 'USD',
        btcPrice,
        poolFee,
        customHardwareName
      } = req.query;

      // Validate required parameters
      if (!hardwareName && (!hashrate || !powerConsumption)) {
        return res.status(400).json({
          success: false,
          error: 'Either hardware name or hashrate/powerConsumption is required'
        });
      }

      let hardware: MiningHardware;

      if (hardwareName && typeof hardwareName === 'string') {
        // Use predefined hardware
        const predefinedHardware = COMMON_HARDWARE[hardwareName.toUpperCase()];
        if (!predefinedHardware) {
          return res.status(400).json({
            success: false,
            error: `Unknown hardware: ${hardwareName}. Available: ${Object.keys(COMMON_HARDWARE).join(', ')}`
          });
        }
        hardware = predefinedHardware;
      } else {
        // Use custom hardware specification
        const hashrateValue = parseFloat(hashrate as string);
        const powerWatts = parseFloat(powerConsumption as string);

        if (isNaN(hashrateValue) || isNaN(powerWatts)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid hashrate or power consumption values'
          });
        }

        hardware = {
          name: (customHardwareName as string) || 'Custom Hardware',
          hashrate: {
            value: hashrateValue,
            unit: hashrateUnit as any
          },
          powerConsumption: {
            watts: powerWatts
          }
        };
      }

      const calculationInput: any = {
        hardware,
        electricity: {
          pricePerKwh: parseFloat(electricityPrice as string),
          currency: currency as string
        }
      };

      if (btcPrice) {
        calculationInput.btcPrice = parseFloat(btcPrice as string);
      }

      if (poolFee) {
        calculationInput.poolFee = parseFloat(poolFee as string);
      }

      const result = await profitabilityService.calculate(calculationInput);

      res.json({
        success: true,
        data: {
          hardware: hardware,
          result: result,
          marketData: profitabilityService.getMarketData(),
          networkStats: profitabilityService.getNetworkStats(),
          calculatedAt: new Date().toISOString()
        }
      });

    } catch (error) {
      logger.error('Profitability calculation failed', error as Error);
      res.status(500).json({
        success: false,
        error: 'Failed to calculate profitability'
      });
    }
  });

  /**
   * POST /api/v1/profitability/calculate
   * Calculate profitability with detailed hardware specification
   */
  app.post(`${apiPrefix}/calculate`, async (req: Request, res: Response) => {
    try {
      const { hardware, electricity, btcPrice, poolFee } = req.body;

      if (!hardware) {
        return res.status(400).json({
          success: false,
          error: 'Hardware specification is required'
        });
      }

      const result = await profitabilityService.calculate({
        hardware,
        electricity,
        btcPrice,
        poolFee
      });

      res.json({
        success: true,
        data: {
          hardware,
          result,
          marketData: profitabilityService.getMarketData(),
          networkStats: profitabilityService.getNetworkStats(),
          calculatedAt: new Date().toISOString()
        }
      });

    } catch (error) {
      logger.error('Profitability calculation failed', error as Error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to calculate profitability'
      });
    }
  });

  /**
   * GET /api/v1/profitability/compare
   * Compare profitability of all common hardware
   */
  app.get(`${apiPrefix}/compare`, async (req: Request, res: Response) => {
    try {
      const {
        electricityPrice = 0.10,
        currency = 'USD'
      } = req.query;

      const comparison = await profitabilityService.calculateAllHardware(
        parseFloat(electricityPrice as string),
        currency as string
      );

      res.json({
        success: true,
        data: {
          comparison,
          parameters: {
            electricityPrice: parseFloat(electricityPrice as string),
            currency: currency as string
          },
          marketData: profitabilityService.getMarketData(),
          networkStats: profitabilityService.getNetworkStats(),
          calculatedAt: new Date().toISOString()
        }
      });

    } catch (error) {
      logger.error('Hardware comparison failed', error as Error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to compare hardware'
      });
    }
  });

  /**
   * GET /api/v1/profitability/check
   * Quick profitability check (returns only boolean)
   */
  app.get(`${apiPrefix}/check`, async (req: Request, res: Response) => {
    try {
      const {
        hardware: hardwareName,
        hashrate,
        hashrateUnit = 'TH/s',
        powerConsumption,
        electricityPrice = 0.10,
        btcPrice,
        poolFee
      } = req.query;

      let hardware: MiningHardware;

      if (hardwareName && typeof hardwareName === 'string') {
        const predefinedHardware = COMMON_HARDWARE[hardwareName.toUpperCase()];
        if (!predefinedHardware) {
          return res.status(400).json({
            success: false,
            error: `Unknown hardware: ${hardwareName}`
          });
        }
        hardware = predefinedHardware;
      } else {
        const hashrateValue = parseFloat(hashrate as string);
        const powerWatts = parseFloat(powerConsumption as string);

        if (isNaN(hashrateValue) || isNaN(powerWatts)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid hashrate or power consumption values'
          });
        }

        hardware = {
          name: 'Custom Hardware',
          hashrate: { value: hashrateValue, unit: hashrateUnit as any },
          powerConsumption: { watts: powerWatts }
        };
      }

      const calculationInput: any = {
        hardware,
        electricity: {
          pricePerKwh: parseFloat(electricityPrice as string),
          currency: 'USD'
        }
      };

      if (btcPrice) {
        calculationInput.btcPrice = parseFloat(btcPrice as string);
      }

      if (poolFee) {
        calculationInput.poolFee = parseFloat(poolFee as string);
      }

      const isProfitable = await profitabilityService.isProfitable(calculationInput);

      res.json({
        success: true,
        data: {
          isProfitable,
          hardware: hardware.name,
          checkedAt: new Date().toISOString()
        }
      });

    } catch (error) {
      logger.error('Profitability check failed', error as Error);
      res.status(500).json({
        success: false,
        error: 'Failed to check profitability'
      });
    }
  });

  /**
   * GET /api/v1/profitability/trends/:hardware
   * Get profitability trends for specific hardware
   */
  app.get(`${apiPrefix}/trends/:hardware`, async (req: Request, res: Response) => {
    try {
      const { hardware: hardwareName } = req.params;
      const {
        electricityPrice = 0.10,
        days = 30
      } = req.query;

      const hardware = COMMON_HARDWARE[hardwareName.toUpperCase()];
      if (!hardware) {
        return res.status(400).json({
          success: false,
          error: `Unknown hardware: ${hardwareName}. Available: ${Object.keys(COMMON_HARDWARE).join(', ')}`
        });
      }

      const trends = await profitabilityService.getProfitabilityTrends(
        hardware,
        parseFloat(electricityPrice as string),
        parseInt(days as string)
      );

      res.json({
        success: true,
        data: {
          hardware: hardware.name,
          trends,
          parameters: {
            electricityPrice: parseFloat(electricityPrice as string),
            days: parseInt(days as string)
          },
          calculatedAt: new Date().toISOString()
        }
      });

    } catch (error) {
      logger.error('Trends calculation failed', error as Error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get profitability trends'
      });
    }
  });

  /**
   * GET /api/v1/profitability/forecast/:hardware
   * Get future profitability forecast with difficulty adjustment
   */
  app.get(`${apiPrefix}/forecast/:hardware`, async (req: Request, res: Response) => {
    try {
      const { hardware: hardwareName } = req.params;
      const {
        electricityPrice = 0.10,
        days = 14
      } = req.query;

      const hardware = COMMON_HARDWARE[hardwareName.toUpperCase()];
      if (!hardware) {
        return res.status(400).json({
          success: false,
          error: `Unknown hardware: ${hardwareName}. Available: ${Object.keys(COMMON_HARDWARE).join(', ')}`
        });
      }

      const forecast = await profitabilityService.estimateFutureProfitability(
        hardware,
        parseFloat(electricityPrice as string),
        parseInt(days as string)
      );

      res.json({
        success: true,
        data: {
          hardware: hardware.name,
          forecast,
          parameters: {
            electricityPrice: parseFloat(electricityPrice as string),
            days: parseInt(days as string)
          },
          calculatedAt: new Date().toISOString()
        }
      });

    } catch (error) {
      logger.error('Forecast calculation failed', error as Error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get profitability forecast'
      });
    }
  });

  /**
   * GET /api/v1/profitability/hardware
   * Get list of available hardware configurations
   */
  app.get(`${apiPrefix}/hardware`, (req: Request, res: Response) => {
    try {
      const hardwareList = Object.entries(COMMON_HARDWARE).map(([key, hardware]) => ({
        id: key,
        ...hardware
      }));

      res.json({
        success: true,
        data: {
          hardware: hardwareList,
          count: hardwareList.length
        }
      });

    } catch (error) {
      logger.error('Failed to get hardware list', error as Error);
      res.status(500).json({
        success: false,
        error: 'Failed to get hardware list'
      });
    }
  });

  /**
   * GET /api/v1/profitability/market
   * Get current market data and network statistics
   */
  app.get(`${apiPrefix}/market`, (req: Request, res: Response) => {
    try {
      const marketData = profitabilityService.getMarketData();
      const networkStats = profitabilityService.getNetworkStats();

      res.json({
        success: true,
        data: {
          market: marketData,
          network: networkStats,
          timestamp: new Date().toISOString()
        }
      });

    } catch (error) {
      logger.error('Failed to get market data', error as Error);
      res.status(500).json({
        success: false,
        error: 'Failed to get market data'
      });
    }
  });

  logger.info('Profitability API routes registered', { prefix: apiPrefix });
}

/**
 * Setup profitability routes in the main API server
 */
export function integrateProfitabilityAPI(
  apiServer: any,
  profitabilityService: ProfitabilityService
): void {
  if (apiServer && apiServer.app) {
    setupProfitabilityRoutes(apiServer.app, profitabilityService);
  }
}
