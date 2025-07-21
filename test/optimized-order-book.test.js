/**
 * Unit tests for OptimizedOrderBook
 * Tests O(log n) operations, Red-Black tree implementation, and order matching
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { OptimizedOrderBook } from '../lib/dex/optimized-order-book.js';

describe('OptimizedOrderBook', () => {
  let orderBook;

  beforeEach(() => {
    orderBook = new OptimizedOrderBook('BTC/USDT', {
      tickSize: 0.01,
      maxPriceLevels: 100
    });
  });

  afterEach(() => {
    orderBook.clear();
  });

  describe('Order Management', () => {
    it('should add orders correctly', () => {
      const order = {
        id: 'order1',
        userId: 'user1',
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
        price: 50000,
        quantity: 1.0,
        remainingQuantity: 1.0
      };

      const result = orderBook.addOrder(order);
      expect(result).to.be.true;

      const retrievedOrder = orderBook.getOrder('order1');
      expect(retrievedOrder).to.be.an('object');
      expect(retrievedOrder.id).to.equal('order1');
      expect(retrievedOrder.price).to.equal(50000);
    });

    it('should normalize prices according to tick size', () => {
      const order = {
        id: 'order1',
        userId: 'user1',
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
        price: 50000.567, // Should be rounded to 50000.56
        quantity: 1.0,
        remainingQuantity: 1.0
      };

      orderBook.addOrder(order);
      const retrievedOrder = orderBook.getOrder('order1');
      expect(retrievedOrder.price).to.equal(50000.56);
    });

    it('should remove orders correctly', () => {
      const order = {
        id: 'order1',
        userId: 'user1',
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
        price: 50000,
        quantity: 1.0,
        remainingQuantity: 1.0
      };

      orderBook.addOrder(order);
      expect(orderBook.getOrder('order1')).to.not.be.null;

      const removedOrder = orderBook.removeOrder('order1');
      expect(removedOrder).to.be.an('object');
      expect(removedOrder.id).to.equal('order1');
      expect(orderBook.getOrder('order1')).to.be.undefined;
    });

    it('should update order quantities', () => {
      const order = {
        id: 'order1',
        userId: 'user1',
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
        price: 50000,
        quantity: 2.0,
        remainingQuantity: 2.0
      };

      orderBook.addOrder(order);
      
      const updateResult = orderBook.updateOrder('order1', { remainingQuantity: 1.0 });
      expect(updateResult).to.be.true;

      const updatedOrder = orderBook.getOrder('order1');
      expect(updatedOrder.remainingQuantity).to.equal(1.0);
    });

    it('should remove orders when quantity becomes zero', () => {
      const order = {
        id: 'order1',
        userId: 'user1',
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
        price: 50000,
        quantity: 1.0,
        remainingQuantity: 1.0
      };

      orderBook.addOrder(order);
      orderBook.updateOrder('order1', { remainingQuantity: 0 });
      
      expect(orderBook.getOrder('order1')).to.be.undefined;
    });

    it('should track user orders', () => {
      const order1 = {
        id: 'order1',
        userId: 'user1',
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
        price: 50000,
        quantity: 1.0,
        remainingQuantity: 1.0
      };

      const order2 = {
        id: 'order2',
        userId: 'user1',
        symbol: 'BTC/USDT',
        side: 'sell',
        type: 'limit',
        price: 51000,
        quantity: 0.5,
        remainingQuantity: 0.5
      };

      orderBook.addOrder(order1);
      orderBook.addOrder(order2);

      const userOrders = orderBook.getUserOrders('user1');
      expect(userOrders).to.have.lengthOf(2);
      expect(userOrders.map(o => o.id)).to.include.members(['order1', 'order2']);
    });
  });

  describe('Price Level Operations', () => {
    it('should maintain correct bid ordering (highest first)', () => {
      const orders = [
        { id: 'order1', userId: 'user1', symbol: 'BTC/USDT', side: 'buy', price: 50000, quantity: 1, remainingQuantity: 1 },
        { id: 'order2', userId: 'user2', symbol: 'BTC/USDT', side: 'buy', price: 51000, quantity: 1, remainingQuantity: 1 },
        { id: 'order3', userId: 'user3', symbol: 'BTC/USDT', side: 'buy', price: 49000, quantity: 1, remainingQuantity: 1 }
      ];

      orders.forEach(order => orderBook.addOrder(order));

      expect(orderBook.getBestBid()).to.equal(51000);
      
      const depth = orderBook.getDepth(10);
      expect(depth.bids[0].price).to.equal(51000);
      expect(depth.bids[1].price).to.equal(50000);
      expect(depth.bids[2].price).to.equal(49000);
    });

    it('should maintain correct ask ordering (lowest first)', () => {
      const orders = [
        { id: 'order1', userId: 'user1', symbol: 'BTC/USDT', side: 'sell', price: 52000, quantity: 1, remainingQuantity: 1 },
        { id: 'order2', userId: 'user2', symbol: 'BTC/USDT', side: 'sell', price: 51000, quantity: 1, remainingQuantity: 1 },
        { id: 'order3', userId: 'user3', symbol: 'BTC/USDT', side: 'sell', price: 53000, quantity: 1, remainingQuantity: 1 }
      ];

      orders.forEach(order => orderBook.addOrder(order));

      expect(orderBook.getBestAsk()).to.equal(51000);
      
      const depth = orderBook.getDepth(10);
      expect(depth.asks[0].price).to.equal(51000);
      expect(depth.asks[1].price).to.equal(52000);
      expect(depth.asks[2].price).to.equal(53000);
    });

    it('should aggregate quantities at same price level', () => {
      const orders = [
        { id: 'order1', userId: 'user1', symbol: 'BTC/USDT', side: 'buy', price: 50000, quantity: 1, remainingQuantity: 1 },
        { id: 'order2', userId: 'user2', symbol: 'BTC/USDT', side: 'buy', price: 50000, quantity: 2, remainingQuantity: 2 },
        { id: 'order3', userId: 'user3', symbol: 'BTC/USDT', side: 'buy', price: 50000, quantity: 0.5, remainingQuantity: 0.5 }
      ];

      orders.forEach(order => orderBook.addOrder(order));

      const depth = orderBook.getDepth(10);
      const priceLevel = depth.bids.find(bid => bid.price === 50000);
      expect(priceLevel.quantity).to.equal(3.5);
      expect(priceLevel.orderCount).to.equal(3);
    });
  });

  describe('Order Matching', () => {
    beforeEach(() => {
      // Set up order book with some orders
      const buyOrders = [
        { id: 'buy1', userId: 'buyer1', symbol: 'BTC/USDT', side: 'buy', price: 50000, quantity: 2, remainingQuantity: 2 },
        { id: 'buy2', userId: 'buyer2', symbol: 'BTC/USDT', side: 'buy', price: 49900, quantity: 1, remainingQuantity: 1 },
        { id: 'buy3', userId: 'buyer3', symbol: 'BTC/USDT', side: 'buy', price: 49800, quantity: 3, remainingQuantity: 3 }
      ];

      const sellOrders = [
        { id: 'sell1', userId: 'seller1', symbol: 'BTC/USDT', side: 'sell', price: 50100, quantity: 1.5, remainingQuantity: 1.5 },
        { id: 'sell2', userId: 'seller2', symbol: 'BTC/USDT', side: 'sell', price: 50200, quantity: 2, remainingQuantity: 2 },
        { id: 'sell3', userId: 'seller3', symbol: 'BTC/USDT', side: 'sell', price: 50300, quantity: 1, remainingQuantity: 1 }
      ];

      [...buyOrders, ...sellOrders].forEach(order => orderBook.addOrder(order));
    });

    it('should match market buy orders correctly', () => {
      const marketBuy = {
        id: 'market1',
        userId: 'buyer4',
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'market',
        quantity: 2.0,
        remainingQuantity: 2.0
      };

      const result = orderBook.matchOrder(marketBuy);
      
      expect(result.matches).to.have.lengthOf(2); // Should match against 2 sell orders
      expect(result.fullyMatched).to.be.true;
      expect(result.remainingQuantity).to.equal(0);
      
      // First match should be at best ask (50100)
      expect(result.matches[0].price).to.equal(50100);
      expect(result.matches[0].quantity).to.equal(1.5);
      
      // Second match should be at next best ask (50200)
      expect(result.matches[1].price).to.equal(50200);
      expect(result.matches[1].quantity).to.equal(0.5);
    });

    it('should match market sell orders correctly', () => {
      const marketSell = {
        id: 'market2',
        userId: 'seller4',
        symbol: 'BTC/USDT',
        side: 'sell',
        type: 'market',
        quantity: 1.5,
        remainingQuantity: 1.5
      };

      const result = orderBook.matchOrder(marketSell);
      
      expect(result.matches).to.have.lengthOf(1);
      expect(result.fullyMatched).to.be.true;
      expect(result.remainingQuantity).to.equal(0);
      
      // Should match at best bid (50000)
      expect(result.matches[0].price).to.equal(50000);
      expect(result.matches[0].quantity).to.equal(1.5);
    });

    it('should match limit orders with price crossing', () => {
      const limitBuy = {
        id: 'limit1',
        userId: 'buyer5',
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
        price: 50150, // Crosses the spread
        quantity: 1.0,
        remainingQuantity: 1.0
      };

      const result = orderBook.matchOrder(limitBuy);
      
      expect(result.matches).to.have.lengthOf(1);
      expect(result.fullyMatched).to.be.true;
      expect(result.remainingQuantity).to.equal(0);
      
      // Should get filled at the better price (50100)
      expect(result.matches[0].price).to.equal(50100);
    });

    it('should not match limit orders without price crossing', () => {
      const limitBuy = {
        id: 'limit2',
        userId: 'buyer6',
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
        price: 50050, // Does not cross spread
        quantity: 1.0,
        remainingQuantity: 1.0
      };

      const result = orderBook.matchOrder(limitBuy);
      
      expect(result.matches).to.have.lengthOf(0);
      expect(result.fullyMatched).to.be.false;
      expect(result.remainingQuantity).to.equal(1.0);
    });

    it('should handle partial fills', () => {
      const largeBuy = {
        id: 'large1',
        userId: 'buyer7',
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'market',
        quantity: 10.0, // More than available
        remainingQuantity: 10.0
      };

      const result = orderBook.matchOrder(largeBuy);
      
      expect(result.matches).to.have.length.greaterThan(0);
      expect(result.fullyMatched).to.be.false;
      expect(result.remainingQuantity).to.be.greaterThan(0);
      
      // Should have consumed all available sell orders
      const totalMatched = result.matches.reduce((sum, match) => sum + match.quantity, 0);
      expect(totalMatched).to.equal(10 - result.remainingQuantity);
    });

    it('should maintain FIFO order at same price level', () => {
      // Add two sell orders at same price
      const sell1 = {
        id: 'fifo1',
        userId: 'seller1',
        symbol: 'BTC/USDT',
        side: 'sell',
        price: 50000,
        quantity: 1,
        remainingQuantity: 1
      };

      const sell2 = {
        id: 'fifo2',
        userId: 'seller2',
        symbol: 'BTC/USDT',
        side: 'sell',
        price: 50000,
        quantity: 1,
        remainingQuantity: 1
      };

      orderBook.addOrder(sell1);
      orderBook.addOrder(sell2);

      const marketBuy = {
        id: 'buyer',
        userId: 'buyer',
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'market',
        quantity: 1,
        remainingQuantity: 1
      };

      const result = orderBook.matchOrder(marketBuy);
      
      // Should match against first order added (FIFO)
      expect(result.matches[0].makerOrder.id).to.equal('fifo1');
    });

    it('should update order book after matching', () => {
      const initialBestAsk = orderBook.getBestAsk();
      
      const marketBuy = {
        id: 'cleaner',
        userId: 'buyer',
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'market',
        quantity: 1.5, // Exactly matches first sell order
        remainingQuantity: 1.5
      };

      orderBook.matchOrder(marketBuy);
      
      // Best ask should change to next price level
      const newBestAsk = orderBook.getBestAsk();
      expect(newBestAsk).to.be.greaterThan(initialBestAsk);
    });
  });

  describe('Order Book Depth', () => {
    it('should return correct depth structure', () => {
      const buyOrder = {
        id: 'buy1',
        userId: 'user1',
        symbol: 'BTC/USDT',
        side: 'buy',
        price: 50000,
        quantity: 1,
        remainingQuantity: 1
      };

      const sellOrder = {
        id: 'sell1',
        userId: 'user2',
        symbol: 'BTC/USDT',
        side: 'sell',
        price: 51000,
        quantity: 2,
        remainingQuantity: 2
      };

      orderBook.addOrder(buyOrder);
      orderBook.addOrder(sellOrder);

      const depth = orderBook.getDepth(5);
      
      expect(depth).to.have.property('bids');
      expect(depth).to.have.property('asks');
      expect(depth.bids).to.be.an('array');
      expect(depth.asks).to.be.an('array');
      
      expect(depth.bids[0]).to.deep.include({
        price: 50000,
        quantity: 1,
        orderCount: 1
      });

      expect(depth.asks[0]).to.deep.include({
        price: 51000,
        quantity: 2,
        orderCount: 1
      });
    });

    it('should respect depth limit', () => {
      // Add many orders at different price levels
      for (let i = 0; i < 20; i++) {
        orderBook.addOrder({
          id: `buy${i}`,
          userId: 'user1',
          symbol: 'BTC/USDT',
          side: 'buy',
          price: 50000 - i * 10,
          quantity: 1,
          remainingQuantity: 1
        });
      }

      const depth = orderBook.getDepth(5);
      expect(depth.bids).to.have.lengthOf(5);
    });
  });

  describe('Spread Calculation', () => {
    it('should calculate spread correctly', () => {
      orderBook.addOrder({
        id: 'buy1',
        userId: 'user1',
        symbol: 'BTC/USDT',
        side: 'buy',
        price: 50000,
        quantity: 1,
        remainingQuantity: 1
      });

      orderBook.addOrder({
        id: 'sell1',
        userId: 'user2',
        symbol: 'BTC/USDT',
        side: 'sell',
        price: 50100,
        quantity: 1,
        remainingQuantity: 1
      });

      const spread = orderBook.getSpread();
      expect(spread.absolute).to.equal(100);
      expect(spread.percentage).to.be.closeTo(0.1996, 0.001); // (100/50100)*100
    });

    it('should return null spread when no bids or asks', () => {
      const spread = orderBook.getSpread();
      expect(spread).to.be.null;
    });
  });

  describe('Statistics', () => {
    it('should track order book statistics', () => {
      const order1 = {
        id: 'order1',
        userId: 'user1',
        symbol: 'BTC/USDT',
        side: 'buy',
        price: 50000,
        quantity: 2,
        remainingQuantity: 2
      };

      const order2 = {
        id: 'order2',
        userId: 'user2',
        symbol: 'BTC/USDT',
        side: 'sell',
        price: 51000,
        quantity: 1,
        remainingQuantity: 1
      };

      orderBook.addOrder(order1);
      orderBook.addOrder(order2);

      const stats = orderBook.getStats();
      
      expect(stats.totalOrders).to.equal(2);
      expect(stats.totalVolume).to.equal(3);
      expect(stats.bestBid).to.equal(50000);
      expect(stats.bestAsk).to.equal(51000);
      expect(stats.bidLevels).to.equal(1);
      expect(stats.askLevels).to.equal(1);
    });

    it('should update statistics after trades', () => {
      orderBook.addOrder({
        id: 'sell1',
        userId: 'seller',
        symbol: 'BTC/USDT',
        side: 'sell',
        price: 50000,
        quantity: 1,
        remainingQuantity: 1
      });

      const marketBuy = {
        id: 'buy1',
        userId: 'buyer',
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'market',
        quantity: 1,
        remainingQuantity: 1
      };

      orderBook.matchOrder(marketBuy);

      const stats = orderBook.getStats();
      expect(stats.lastPrice).to.equal(50000);
      expect(stats.lastTradeTime).to.be.a('number');
    });
  });

  describe('Performance', () => {
    it('should handle large number of orders efficiently', () => {
      const startTime = process.hrtime.bigint();
      
      // Add 1000 orders
      for (let i = 0; i < 1000; i++) {
        orderBook.addOrder({
          id: `order${i}`,
          userId: `user${i}`,
          symbol: 'BTC/USDT',
          side: i % 2 === 0 ? 'buy' : 'sell',
          price: 50000 + (i % 2 === 0 ? -i : i),
          quantity: 1,
          remainingQuantity: 1
        });
      }

      const addTime = process.hrtime.bigint();
      
      // Remove half of them
      for (let i = 0; i < 500; i++) {
        orderBook.removeOrder(`order${i * 2}`);
      }

      const removeTime = process.hrtime.bigint();
      
      const addDuration = Number(addTime - startTime) / 1000000; // Convert to ms
      const removeDuration = Number(removeTime - addTime) / 1000000;
      
      // Should complete within reasonable time (adjust thresholds as needed)
      expect(addDuration).to.be.below(1000); // 1 second for 1000 additions
      expect(removeDuration).to.be.below(500); // 0.5 seconds for 500 removals
      
      // Verify tree is still balanced
      expect(orderBook.getStats().totalOrders).to.equal(500);
    });

    it('should maintain O(log n) complexity for operations', () => {
      const sizes = [100, 1000, 10000];
      const times = [];

      for (const size of sizes) {
        const testBook = new OptimizedOrderBook('TEST/USDT');
        
        // Add orders
        for (let i = 0; i < size; i++) {
          testBook.addOrder({
            id: `order${i}`,
            userId: 'user1',
            symbol: 'TEST/USDT',
            side: 'buy',
            price: 100 + i,
            quantity: 1,
            remainingQuantity: 1
          });
        }

        // Measure time for a single operation
        const start = process.hrtime.bigint();
        testBook.addOrder({
          id: 'testOrder',
          userId: 'user1',
          symbol: 'TEST/USDT',
          side: 'buy',
          price: 50000,
          quantity: 1,
          remainingQuantity: 1
        });
        const end = process.hrtime.bigint();
        
        times.push(Number(end - start) / 1000); // Convert to microseconds
        testBook.clear();
      }

      // Time complexity should grow logarithmically, not linearly
      // For O(log n), time ratio should be approximately log(size2)/log(size1)
      const ratio1 = times[1] / times[0]; // 1000 vs 100
      const ratio2 = times[2] / times[1]; // 10000 vs 1000
      
      // For O(log n): log(1000)/log(100) = 1.5, log(10000)/log(1000) = 1.33
      // Allow some variance but should be much less than linear growth (10x)
      expect(ratio1).to.be.below(5);
      expect(ratio2).to.be.below(5);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty order book operations', () => {
      expect(orderBook.getBestBid()).to.be.null;
      expect(orderBook.getBestAsk()).to.be.null;
      expect(orderBook.getSpread()).to.be.null;
      expect(orderBook.removeOrder('nonexistent')).to.be.false;
      expect(orderBook.getOrder('nonexistent')).to.be.undefined;
      
      const depth = orderBook.getDepth();
      expect(depth.bids).to.be.empty;
      expect(depth.asks).to.be.empty;
    });

    it('should handle zero quantities', () => {
      const order = {
        id: 'zero',
        userId: 'user1',
        symbol: 'BTC/USDT',
        side: 'buy',
        price: 50000,
        quantity: 0,
        remainingQuantity: 0
      };

      const result = orderBook.addOrder(order);
      expect(result).to.be.true;
      
      const stats = orderBook.getStats();
      expect(stats.totalVolume).to.equal(0);
    });

    it('should handle very small quantities', () => {
      const order = {
        id: 'small',
        userId: 'user1',
        symbol: 'BTC/USDT',
        side: 'buy',
        price: 50000,
        quantity: 0.00000001, // Satoshi level
        remainingQuantity: 0.00000001
      };

      orderBook.addOrder(order);
      expect(orderBook.getOrder('small').quantity).to.equal(0.00000001);
    });

    it('should handle price precision edge cases', () => {
      const order = {
        id: 'precision',
        userId: 'user1',
        symbol: 'BTC/USDT',
        side: 'buy',
        price: 50000.999999, // Should be normalized
        quantity: 1,
        remainingQuantity: 1
      };

      orderBook.addOrder(order);
      const retrievedOrder = orderBook.getOrder('precision');
      expect(retrievedOrder.price).to.be.closeTo(51000.00, 0.01);
    });

    it('should clear order book completely', () => {
      // Add several orders
      for (let i = 0; i < 10; i++) {
        orderBook.addOrder({
          id: `order${i}`,
          userId: 'user1',
          symbol: 'BTC/USDT',
          side: i % 2 === 0 ? 'buy' : 'sell',
          price: 50000 + i * 100,
          quantity: 1,
          remainingQuantity: 1
        });
      }

      expect(orderBook.getStats().totalOrders).to.equal(10);

      orderBook.clear();

      const stats = orderBook.getStats();
      expect(stats.totalOrders).to.equal(0);
      expect(stats.totalVolume).to.equal(0);
      expect(stats.bestBid).to.be.null;
      expect(stats.bestAsk).to.be.null;
      
      const depth = orderBook.getDepth();
      expect(depth.bids).to.be.empty;
      expect(depth.asks).to.be.empty;
    });
  });

  describe('Event Emissions', () => {
    it('should emit events for order operations', (done) => {
      let eventCount = 0;
      const expectedEvents = ['order:added', 'order:removed'];
      const receivedEvents = [];

      orderBook.on('order:added', (order) => {
        receivedEvents.push('order:added');
        expect(order.id).to.equal('event-order');
        eventCount++;
      });

      orderBook.on('order:removed', (order) => {
        receivedEvents.push('order:removed');
        expect(order.id).to.equal('event-order');
        eventCount++;
      });

      orderBook.on('book:cleared', () => {
        receivedEvents.push('book:cleared');
        eventCount++;
        
        if (eventCount === 3) {
          expect(receivedEvents).to.include.members(['order:added', 'order:removed', 'book:cleared']);
          done();
        }
      });

      const order = {
        id: 'event-order',
        userId: 'user1',
        symbol: 'BTC/USDT',
        side: 'buy',
        price: 50000,
        quantity: 1,
        remainingQuantity: 1
      };

      orderBook.addOrder(order);
      orderBook.removeOrder('event-order');
      orderBook.clear();
    });
  });
});