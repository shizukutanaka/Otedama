/**
 * Fee Transparency and Information Routes
 * Provides public access to fee information and transparency reports
 */

import express from 'express';
import { secureFeeConfig, feeCalculator } from '../security/fee-protection.js';
import { feeAuditMonitor } from '../security/fee-audit-monitor.js';
import { getLogger } from '../core/logger.js';

const logger = getLogger('FeeRoutes');

const router = express.Router();

/**
 * GET /api/fees/current
 * Get current fee rates and structure (public endpoint)
 */
router.get('/current', async (req, res) => {
  try {
    const feeInfo = {
      poolFee: {
        rate: secureFeeConfig.getPoolFeeRate(),
        percentage: (secureFeeConfig.getPoolFeeRate() * 100).toFixed(2) + '%',
        description: 'Pool operation and maintenance fee'
      },
      limits: secureFeeConfig.getFeeLimits(),
      lastUpdated: Date.now(),
      transparency: {
        protected: true,
        auditTrail: true,
        publicDisclosure: true
      }
    };

    res.json({
      success: true,
      data: feeInfo,
      message: 'Current fee information retrieved successfully'
    });

  } catch (error) {
    logger.error('Error retrieving fee information:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve fee information'
    });
  }
});

/**
 * GET /api/fees/transparency
 * Get detailed fee transparency report (public endpoint)
 */
router.get('/transparency', async (req, res) => {
  try {
    const transparencyReport = secureFeeConfig.getFeeTransparencyReport();
    
    res.json({
      success: true,
      data: transparencyReport,
      message: 'Fee transparency report generated successfully'
    });

  } catch (error) {
    logger.error('Error generating transparency report:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate transparency report'
    });
  }
});

/**
 * POST /api/fees/calculate
 * Calculate fees for a given amount (public endpoint)
 */
router.post('/calculate', async (req, res) => {
  try {
    const { amount, currency = 'BTC' } = req.body;

    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid amount provided'
      });
    }

    const feeCalculation = feeCalculator.calculatePoolFees(amount);
    
    res.json({
      success: true,
      data: {
        ...feeCalculation,
        currency,
        calculatedAt: Date.now()
      },
      message: 'Fee calculation completed successfully'
    });

  } catch (error) {
    logger.error('Error calculating fees:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to calculate fees'
    });
  }
});


/**
 * GET /api/fees/summary
 * Get basic fee summary (public endpoint)
 */
router.get('/summary', async (req, res) => {
  try {
    const summary = {
      currentFee: '0.5%',
      feeAmount: secureFeeConfig.getPoolFeeRate(),
      protected: true,
      lastUpdated: Date.now()
    };
    
    res.json({
      success: true,
      data: summary,
      message: 'Fee summary retrieved successfully'
    });

  } catch (error) {
    logger.error('Error retrieving fee summary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve fee summary'
    });
  }
});

export default router;