/**
 * Payout Settings API for Otedama
 * Allows miners to configure their payout preferences
 */

import { Router } from 'express';
import { body, param, validationResult } from 'express-validator';
import { PayoutMode } from '../lib/payout.js';

export function createPayoutRouter(payoutManager, logger) {
  const router = Router();
  
  /**
   * Get miner payout preference
   */
  router.get('/preferences/:walletAddress', [
    param('walletAddress').isString().isLength({ min: 20, max: 100 })
  ], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const preference = payoutManager.getMinerPreference(req.params.walletAddress);
      
      res.json({
        success: true,
        preference: {
          walletAddress: preference.wallet_address,
          payoutMode: preference.payout_mode,
          minimumPayout: preference.minimum_payout,
          description: preference.payout_mode === PayoutMode.DIRECT 
            ? 'Receive mined currency directly (1.8% pool fee deducted in BTC)'
            : 'Auto-convert to BTC (2% total fee)'
        }
      });
    } catch (error) {
      logger.error('Failed to get payout preference:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve payout preference'
      });
    }
  });
  
  /**
   * Update miner payout preference
   */
  router.post('/preferences/:walletAddress', [
    param('walletAddress').isString().isLength({ min: 20, max: 100 }),
    body('payoutMode').isIn([PayoutMode.DIRECT, PayoutMode.CONVERT]),
    body('minimumPayout').optional().isFloat({ min: 0.0001, max: 1 })
  ], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const { walletAddress } = req.params;
      const { payoutMode, minimumPayout } = req.body;
      
      payoutManager.setMinerPreference(walletAddress, payoutMode, minimumPayout);
      
      res.json({
        success: true,
        message: 'Payout preference updated successfully',
        preference: {
          walletAddress,
          payoutMode,
          minimumPayout: minimumPayout || payoutManager.options.minimumPayout
        }
      });
    } catch (error) {
      logger.error('Failed to update payout preference:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update payout preference'
      });
    }
  });
  
  /**
   * Get pending balance
   */
  router.get('/balance/:walletAddress', [
    param('walletAddress').isString().isLength({ min: 20, max: 100 })
  ], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const balances = payoutManager.getPendingBalance(req.params.walletAddress);
      const preference = payoutManager.getMinerPreference(req.params.walletAddress);
      
      res.json({
        success: true,
        balances,
        payoutMode: preference.payout_mode,
        minimumPayout: preference.minimum_payout,
        nextPayoutIn: calculateNextPayoutTime()
      });
    } catch (error) {
      logger.error('Failed to get pending balance:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve balance'
      });
    }
  });
  
  /**
   * Get payout history
   */
  router.get('/history/:walletAddress', [
    param('walletAddress').isString().isLength({ min: 20, max: 100 })
  ], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const limit = parseInt(req.query.limit) || 50;
      const history = payoutManager.getPayoutHistory(req.params.walletAddress, limit);
      
      res.json({
        success: true,
        history: history.map(payout => ({
          ...payout,
          feeBreakdown: {
            poolFee: payout.pool_fee_btc,
            conversionFee: payout.conversion_fee_btc,
            totalFees: payout.pool_fee_btc + payout.conversion_fee_btc,
            feePercentage: payout.original_currency === payout.payout_currency ? 1.8 : 2.0
          }
        })),
        total: history.length
      });
    } catch (error) {
      logger.error('Failed to get payout history:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve payout history'
      });
    }
  });
  
  /**
   * Calculate estimated payout
   */
  router.post('/estimate', [
    body('walletAddress').isString().isLength({ min: 20, max: 100 }),
    body('currency').isString().isLength({ min: 3, max: 5 }),
    body('amount').isFloat({ min: 0.00000001 })
  ], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const { walletAddress, currency, amount } = req.body;
      const estimate = await payoutManager.calculateEstimatedPayout(
        walletAddress,
        currency,
        amount
      );
      
      res.json({
        success: true,
        estimate: {
          ...estimate,
          explanation: estimate.mode === 'direct'
            ? `You will receive ${amount} ${currency} directly. Pool fee of ${estimate.poolFeeBtc} BTC will be deducted separately.`
            : `Your ${amount} ${currency} will be converted to ${estimate.netAmount} BTC after a 2% fee.`
        }
      });
    } catch (error) {
      logger.error('Failed to calculate payout estimate:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to calculate estimate'
      });
    }
  });
  
  /**
   * Get current exchange rates
   */
  router.get('/rates', async (req, res) => {
    try {
      const rates = {};
      
      // Get all supported currencies
      const currencies = ['ETH', 'RVN', 'XMR', 'LTC', 'DOGE', 'ETC', 'DASH', 'ZEC', 'VTC'];
      
      for (const currency of currencies) {
        rates[currency] = await payoutManager.getExchangeRate(currency);
      }
      
      res.json({
        success: true,
        rates,
        baseCurrency: 'BTC',
        lastUpdate: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get exchange rates:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve exchange rates'
      });
    }
  });
  
  /**
   * Get fee structure
   */
  router.get('/fees', (req, res) => {
    res.json({
      success: true,
      fees: {
        direct: {
          description: 'Direct payout in mined currency',
          poolFee: 1.8,
          conversionFee: 0,
          totalFee: 1.8,
          note: 'Pool fee is deducted in BTC based on current exchange rate'
        },
        convert: {
          description: 'Auto-convert to BTC',
          poolFee: 'Included',
          conversionFee: 'Included',
          totalFee: 2.0,
          note: 'All fees included in the 2% total'
        }
      }
    });
  });
  
  /**
   * Helper function to calculate next payout time
   */
  function calculateNextPayoutTime() {
    const now = Date.now();
    const interval = payoutManager.options.payoutInterval;
    const nextPayout = Math.ceil(now / interval) * interval;
    const timeUntil = nextPayout - now;
    
    return {
      timestamp: nextPayout,
      relative: formatTime(timeUntil)
    };
  }
  
  /**
   * Format time duration
   */
  function formatTime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
  
  return router;
}