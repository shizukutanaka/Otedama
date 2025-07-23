/**
 * Miner API Endpoints
 * Provides API for miners to manage their settings and payment addresses
 */

const express = require('express');
const { createLogger } = require('../core/logger');

const logger = createLogger('miner-api');

class MinerAPI {
  constructor(minerAddressManager, paymentProcessor) {
    this.addressManager = minerAddressManager;
    this.paymentProcessor = paymentProcessor;
    this.router = express.Router();
    
    this.setupRoutes();
  }
  
  setupRoutes() {
    // Middleware
    this.router.use(express.json());
    
    // Get miner info by mining address
    this.router.get('/miner/:address', (req, res) => {
      try {
        const { address } = req.params;
        const paymentAddress = this.addressManager.getPaymentAddressByMiningAddress(address);
        
        if (!paymentAddress) {
          return res.status(404).json({
            error: 'Miner not found'
          });
        }
        
        // Get miner statistics
        const minerStats = this.paymentProcessor.getMinerStats(address);
        
        res.json({
          miningAddress: address,
          paymentAddress,
          isCustomAddress: paymentAddress !== address,
          stats: minerStats
        });
      } catch (error) {
        logger.error('Error getting miner info:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });
    
    // Update payment address
    this.router.post('/miner/:address/payment-address', async (req, res) => {
      try {
        const { address } = req.params;
        const { paymentAddress, signature } = req.body;
        
        if (!paymentAddress) {
          return res.status(400).json({
            error: 'Payment address is required'
          });
        }
        
        // Find miner by mining address
        const miner = this.addressManager.addressIndex.get(address);
        if (!miner) {
          return res.status(404).json({
            error: 'Miner not found'
          });
        }
        
        // Update payment address
        await this.addressManager.updatePaymentAddress(miner, paymentAddress, signature);
        
        res.json({
          success: true,
          miningAddress: address,
          paymentAddress,
          message: 'Payment address updated successfully'
        });
      } catch (error) {
        logger.error('Error updating payment address:', error);
        
        if (error.message.includes('cooldown')) {
          res.status(429).json({ error: error.message });
        } else if (error.message.includes('Invalid')) {
          res.status(400).json({ error: error.message });
        } else {
          res.status(500).json({ error: 'Failed to update payment address' });
        }
      }
    });
    
    // Get payment summary
    this.router.get('/payments/summary', (req, res) => {
      try {
        const summary = this.addressManager.getPaymentSummary();
        
        res.json({
          paymentAddresses: summary.length,
          totalMiners: this.addressManager.stats.totalMiners,
          customAddresses: this.addressManager.stats.customAddresses,
          summary
        });
      } catch (error) {
        logger.error('Error getting payment summary:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });
    
    // Get payment history for address
    this.router.get('/payments/:address/history', (req, res) => {
      try {
        const { address } = req.params;
        const limit = parseInt(req.query.limit) || 50;
        
        // Get all completed payments for this address
        const payments = [];
        for (const payment of this.paymentProcessor.completedPayments.values()) {
          if (payment.address === address) {
            payments.push({
              txid: payment.txid,
              amount: payment.amount,
              timestamp: payment.timestamp
            });
          }
        }
        
        // Sort by timestamp descending
        payments.sort((a, b) => b.timestamp - a.timestamp);
        
        res.json({
          address,
          totalPayments: payments.length,
          payments: payments.slice(0, limit)
        });
      } catch (error) {
        logger.error('Error getting payment history:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });
    
    // Validate Bitcoin address
    this.router.post('/validate-address', (req, res) => {
      try {
        const { address } = req.body;
        
        if (!address) {
          return res.status(400).json({
            error: 'Address is required'
          });
        }
        
        const isValid = this.addressManager.isValidBitcoinAddress(address);
        
        res.json({
          address,
          valid: isValid
        });
      } catch (error) {
        logger.error('Error validating address:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });
    
    // Get address change policy
    this.router.get('/policy/address-change', (req, res) => {
      res.json({
        allowed: this.addressManager.options.allowAddressChange,
        cooldownPeriod: this.addressManager.options.addressChangeDelay,
        requireSignature: this.addressManager.options.requireSignature,
        cooldownHours: Math.floor(this.addressManager.options.addressChangeDelay / 3600000)
      });
    });
    
    // Instructions for changing payment address
    this.router.get('/instructions/change-address', (req, res) => {
      const instructions = {
        steps: [
          {
            step: 1,
            description: 'Find your mining address',
            details: 'This is the address you use to connect to the pool'
          },
          {
            step: 2,
            description: 'Choose your payment address',
            details: 'This can be any valid Bitcoin address you control'
          },
          {
            step: 3,
            description: 'Submit the change request',
            details: 'POST to /api/miner/{your-mining-address}/payment-address'
          }
        ],
        example: {
          url: '/api/miner/1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa/payment-address',
          method: 'POST',
          body: {
            paymentAddress: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
            signature: 'optional-signature-if-required'
          }
        },
        notes: [
          'Address changes may have a cooldown period',
          'Some pools may require signature verification',
          'Payments will be sent to your new address after the change'
        ]
      };
      
      res.json(instructions);
    });
  }
  
  getRouter() {
    return this.router;
  }
}

module.exports = MinerAPI;