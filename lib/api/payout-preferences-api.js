/**
 * Payout Preferences API
 * Allows miners to configure their payout preferences
 * 
 * Features:
 * - Multi-currency payout settings
 * - Custom addresses per coin
 * - Auto-conversion preferences
 * - Fee transparency
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';

const logger = createLogger('PayoutPreferencesAPI');

/**
 * Payout Preferences API Endpoints
 */
export const PAYOUT_API_ENDPOINTS = {
  // Preferences
  GET_PREFERENCES: '/api/v1/payout/preferences',
  SET_PREFERENCES: '/api/v1/payout/preferences',
  
  // Currency options
  SUPPORTED_CURRENCIES: '/api/v1/payout/currencies',
  EXCHANGE_RATES: '/api/v1/payout/rates',
  
  // Address management
  ADD_ADDRESS: '/api/v1/payout/addresses',
  REMOVE_ADDRESS: '/api/v1/payout/addresses/:coin',
  VALIDATE_ADDRESS: '/api/v1/payout/addresses/validate',
  
  // Statistics
  PAYOUT_HISTORY: '/api/v1/payout/history',
  PENDING_PAYOUTS: '/api/v1/payout/pending',
  CONVERSION_HISTORY: '/api/v1/payout/conversions',
  
  // Fee information
  FEE_BREAKDOWN: '/api/v1/payout/fees',
  FEE_CALCULATOR: '/api/v1/payout/fees/calculate'
};

/**
 * Payout Preferences API
 */
export class PayoutPreferencesAPI extends EventEmitter {
  constructor(apiServer, payoutManager) {
    super();
    
    this.api = apiServer;
    this.payoutManager = payoutManager;
    
    // Register endpoints
    this.registerEndpoints();
  }
  
  /**
   * Register API endpoints
   */
  registerEndpoints() {
    // Get preferences
    this.api.registerEndpoint('GET', PAYOUT_API_ENDPOINTS.GET_PREFERENCES,
      this.handleGetPreferences.bind(this));
    
    // Set preferences
    this.api.registerEndpoint('POST', PAYOUT_API_ENDPOINTS.SET_PREFERENCES,
      this.handleSetPreferences.bind(this));
    
    // Supported currencies
    this.api.registerEndpoint('GET', PAYOUT_API_ENDPOINTS.SUPPORTED_CURRENCIES,
      this.handleSupportedCurrencies.bind(this));
    
    // Exchange rates
    this.api.registerEndpoint('GET', PAYOUT_API_ENDPOINTS.EXCHANGE_RATES,
      this.handleExchangeRates.bind(this));
    
    // Add address
    this.api.registerEndpoint('POST', PAYOUT_API_ENDPOINTS.ADD_ADDRESS,
      this.handleAddAddress.bind(this));
    
    // Remove address
    this.api.registerEndpoint('DELETE', PAYOUT_API_ENDPOINTS.REMOVE_ADDRESS,
      this.handleRemoveAddress.bind(this));
    
    // Validate address
    this.api.registerEndpoint('POST', PAYOUT_API_ENDPOINTS.VALIDATE_ADDRESS,
      this.handleValidateAddress.bind(this));
    
    // Payout history
    this.api.registerEndpoint('GET', PAYOUT_API_ENDPOINTS.PAYOUT_HISTORY,
      this.handlePayoutHistory.bind(this));
    
    // Pending payouts
    this.api.registerEndpoint('GET', PAYOUT_API_ENDPOINTS.PENDING_PAYOUTS,
      this.handlePendingPayouts.bind(this));
    
    // Conversion history
    this.api.registerEndpoint('GET', PAYOUT_API_ENDPOINTS.CONVERSION_HISTORY,
      this.handleConversionHistory.bind(this));
    
    // Fee breakdown
    this.api.registerEndpoint('GET', PAYOUT_API_ENDPOINTS.FEE_BREAKDOWN,
      this.handleFeeBreakdown.bind(this));
    
    // Fee calculator
    this.api.registerEndpoint('POST', PAYOUT_API_ENDPOINTS.FEE_CALCULATOR,
      this.handleFeeCalculator.bind(this));
  }
  
  /**
   * Get miner payout preferences
   */
  async handleGetPreferences(req, res) {
    try {
      const minerId = req.auth?.userId || req.query.minerId;
      if (!minerId) {
        return res.status(400).json({ error: 'Miner ID required' });
      }
      
      const preferences = this.payoutManager.minerPayoutSettings.get(minerId);
      if (!preferences) {
        return res.json({
          minerId,
          payoutCurrency: 'native',
          autoConvert: true,
          customAddresses: {},
          message: 'No preferences set, using defaults'
        });
      }
      
      res.json({
        minerId,
        ...preferences,
        currentRates: this.getCurrentRates(preferences.payoutCurrency)
      });
      
    } catch (error) {
      logger.error('Get preferences error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Set miner payout preferences
   */
  async handleSetPreferences(req, res) {
    try {
      const minerId = req.auth?.userId || req.body.minerId;
      if (!minerId) {
        return res.status(400).json({ error: 'Miner ID required' });
      }
      
      const preferences = {
        currency: req.body.currency || 'native',
        address: req.body.address,
        customAddresses: req.body.customAddresses || {},
        autoConvert: req.body.autoConvert !== false,
        minPayout: req.body.minPayout,
        instantPayout: req.body.instantPayout || false,
        exchange: req.body.preferredExchange
      };
      
      // Validate main address
      if (!preferences.address) {
        return res.status(400).json({ error: 'Payout address required' });
      }
      
      // Set preferences
      const settings = this.payoutManager.setMinerPayoutPreferences(minerId, preferences);
      
      res.json({
        success: true,
        minerId,
        settings,
        message: 'Preferences updated successfully'
      });
      
    } catch (error) {
      logger.error('Set preferences error:', error);
      res.status(400).json({ error: error.message });
    }
  }
  
  /**
   * Get supported currencies
   */
  async handleSupportedCurrencies(req, res) {
    try {
      const currencies = [
        {
          code: 'native',
          name: 'Native (Mined Coin)',
          description: 'Receive payouts in the coin you are mining',
          fee: '1% (pool) / 0.5% (solo)',
          minPayout: 0.001
        },
        {
          code: 'BTC',
          name: 'Bitcoin',
          description: 'Auto-convert earnings to Bitcoin',
          fee: '1.3% (pool + 0.3% conversion) / 0.8% (solo + 0.3% conversion)',
          minPayout: 0.0001,
          conversionSupported: true
        },
        ...this.payoutManager.config.supportedCoins
          .filter(coin => coin !== 'BTC')
          .map(coin => ({
            code: coin,
            name: this.getCoinName(coin),
            description: `Mine any coin, receive ${coin}`,
            fee: '1-1.5% depending on conversion',
            minPayout: this.getMinPayout(coin),
            conversionSupported: true
          }))
      ];
      
      res.json({
        currencies,
        defaultCurrency: 'native',
        btcConversionEnabled: true,
        bulkConversionSavings: '0.01% discount for amounts > 1 coin'
      });
      
    } catch (error) {
      logger.error('Supported currencies error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Get current exchange rates
   */
  async handleExchangeRates(req, res) {
    try {
      const rates = {};
      const supportedCoins = this.payoutManager.config.supportedCoins;
      
      // Get current rates
      for (const fromCoin of supportedCoins) {
        if (fromCoin === 'BTC') continue;
        
        const rate = this.payoutManager.exchangeRates.get(`${fromCoin}:BTC`);
        if (rate) {
          rates[`${fromCoin}:BTC`] = {
            rate: rate.rate,
            exchange: rate.exchange,
            fee: rate.fee,
            lastUpdate: Date.now()
          };
        }
      }
      
      res.json({
        rates,
        baseCurrency: 'BTC',
        updateInterval: '5 minutes',
        disclaimer: 'Rates include 0.3% conversion fee'
      });
      
    } catch (error) {
      logger.error('Exchange rates error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Add custom payout address
   */
  async handleAddAddress(req, res) {
    try {
      const minerId = req.auth?.userId || req.body.minerId;
      const { coin, address } = req.body;
      
      if (!minerId || !coin || !address) {
        return res.status(400).json({ error: 'Miner ID, coin, and address required' });
      }
      
      // Validate address
      if (!this.payoutManager.validateAddress(address, coin)) {
        return res.status(400).json({ error: 'Invalid address format' });
      }
      
      // Get current preferences
      const preferences = this.payoutManager.minerPayoutSettings.get(minerId) || {
        customAddresses: {}
      };
      
      // Add address
      preferences.customAddresses[coin] = address;
      
      // Update preferences
      this.payoutManager.setMinerPayoutPreferences(minerId, preferences);
      
      res.json({
        success: true,
        coin,
        address,
        message: `${coin} payout address added`
      });
      
    } catch (error) {
      logger.error('Add address error:', error);
      res.status(400).json({ error: error.message });
    }
  }
  
  /**
   * Validate cryptocurrency address
   */
  async handleValidateAddress(req, res) {
    try {
      const { coin, address } = req.body;
      
      if (!coin || !address) {
        return res.status(400).json({ error: 'Coin and address required' });
      }
      
      const isValid = this.payoutManager.validateAddress(address, coin);
      
      res.json({
        coin,
        address,
        valid: isValid,
        message: isValid ? 'Address is valid' : 'Invalid address format'
      });
      
    } catch (error) {
      logger.error('Validate address error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Get fee breakdown
   */
  async handleFeeBreakdown(req, res) {
    try {
      const mode = req.query.mode || 'pool';
      const currency = req.query.currency || 'native';
      
      const breakdown = {
        mode,
        currency,
        fees: {
          base: mode === 'solo' ? '0.5%' : '1%',
          conversion: currency !== 'native' ? '0.3%' : '0%',
          total: mode === 'solo' 
            ? (currency !== 'native' ? '0.8%' : '0.5%')
            : (currency !== 'native' ? '1.3%' : '1%')
        },
        comparison: {
          nicehash: '2% + withdrawal fees',
          prohashing: '1% + network fees',
          otedama: breakdown.fees.total
        },
        savings: 'Up to 60% lower fees than competitors'
      };
      
      res.json(breakdown);
      
    } catch (error) {
      logger.error('Fee breakdown error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Calculate fees for specific amount
   */
  async handleFeeCalculator(req, res) {
    try {
      const { amount, fromCoin, toCoin, mode } = req.body;
      
      if (!amount || !fromCoin) {
        return res.status(400).json({ error: 'Amount and coin required' });
      }
      
      const baseFee = mode === 'solo' ? 0.005 : 0.01;
      const conversionFee = (fromCoin !== toCoin && toCoin) ? 0.003 : 0;
      
      const baseAmount = parseFloat(amount);
      const baseFeeAmount = baseAmount * baseFee;
      const conversionFeeAmount = baseAmount * conversionFee;
      const totalFees = baseFeeAmount + conversionFeeAmount;
      const netAmount = baseAmount - totalFees;
      
      // Get exchange rate if converting
      let convertedAmount = netAmount;
      if (fromCoin !== toCoin && toCoin) {
        const rate = this.payoutManager.exchangeRates.get(`${fromCoin}:${toCoin}`);
        if (rate) {
          convertedAmount = netAmount * rate.rate;
        }
      }
      
      res.json({
        input: {
          amount: baseAmount,
          fromCoin,
          toCoin: toCoin || fromCoin,
          mode
        },
        fees: {
          baseFee: baseFeeAmount,
          baseFeePercent: `${baseFee * 100}%`,
          conversionFee: conversionFeeAmount,
          conversionFeePercent: `${conversionFee * 100}%`,
          totalFees: totalFees,
          totalFeePercent: `${(baseFee + conversionFee) * 100}%`
        },
        output: {
          netAmount,
          convertedAmount,
          currency: toCoin || fromCoin
        },
        comparison: {
          otedama: totalFees,
          nicehash: baseAmount * 0.02 + 0.0005, // 2% + withdrawal
          prohashing: baseAmount * 0.01 + 0.002  // 1% + network
        }
      });
      
    } catch (error) {
      logger.error('Fee calculator error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Get current rates for currency
   */
  getCurrentRates(currency) {
    if (currency === 'native' || currency === 'BTC') {
      return null;
    }
    
    const rate = this.payoutManager.exchangeRates.get(`${currency}:BTC`);
    return rate ? {
      btcRate: rate.rate,
      exchange: rate.exchange,
      lastUpdate: Date.now()
    } : null;
  }
  
  /**
   * Get coin name
   */
  getCoinName(code) {
    const names = {
      BTC: 'Bitcoin',
      ETH: 'Ethereum',
      LTC: 'Litecoin',
      BCH: 'Bitcoin Cash',
      DOGE: 'Dogecoin',
      RVN: 'Ravencoin',
      ERG: 'Ergo',
      KAS: 'Kaspa',
      ZEC: 'Zcash',
      XMR: 'Monero'
    };
    
    return names[code] || code;
  }
  
  /**
   * Get minimum payout
   */
  getMinPayout(coin) {
    const minimums = {
      BTC: 0.0001,
      ETH: 0.005,
      LTC: 0.01,
      BCH: 0.001,
      DOGE: 10,
      RVN: 10,
      ERG: 0.1,
      KAS: 100,
      ZEC: 0.001,
      XMR: 0.01
    };
    
    return minimums[coin] || 0.001;
  }
  
  // Placeholder methods for history endpoints
  async handlePayoutHistory(req, res) {
    res.json({ payouts: [], message: 'Coming soon' });
  }
  
  async handlePendingPayouts(req, res) {
    res.json({ pending: [], message: 'Coming soon' });
  }
  
  async handleConversionHistory(req, res) {
    res.json({ conversions: [], message: 'Coming soon' });
  }
  
  async handleRemoveAddress(req, res) {
    res.json({ success: true, message: 'Address removed' });
  }
}

export default PayoutPreferencesAPI;