/**
 * DEX Tests
 * Comprehensive testing for decentralized exchange functionality
 */

import { OrderBook, OrderType, OrderStatus } from '../lib/dex/order-book.js';
import { MatchingEngine } from '../lib/dex/matching-engine.js';
import { DexPair } from '../lib/dex/dex-pair.js';

describe('OrderBook', () => {
    let orderBook;
    
    beforeEach(() => {
        orderBook = new OrderBook('BTC', 'USDT');
    });
    
    describe('Order Management', () => {
        it('should add buy orders correctly', () => {
            const order = orderBook.addOrder({
                type: OrderType.BUY,
                price: 50000,
                amount: 0.1,
                userId: 'user1'
            });
            
            expect(order).toBeTruthy();
            expect(order.id).toBeTruthy();
            expect(order.type).toBe(OrderType.BUY);
            expect(order.status).toBe(OrderStatus.OPEN);
            expect(orderBook.buyOrders.length).toBe(1);
        });
        
        it('should add sell orders correctly', () => {
            const order = orderBook.addOrder({
                type: OrderType.SELL,
                price: 51000,
                amount: 0.1,
                userId: 'user1'
            });
            
            expect(order).toBeTruthy();
            expect(order.type).toBe(OrderType.SELL);
            expect(orderBook.sellOrders.length).toBe(1);
        });
        
        it('should sort buy orders by price descending', () => {
            orderBook.addOrder({ type: OrderType.BUY, price: 50000, amount: 0.1, userId: 'user1' });
            orderBook.addOrder({ type: OrderType.BUY, price: 51000, amount: 0.1, userId: 'user2' });
            orderBook.addOrder({ type: OrderType.BUY, price: 49000, amount: 0.1, userId: 'user3' });
            
            expect(orderBook.buyOrders[0].price).toBe(51000);
            expect(orderBook.buyOrders[1].price).toBe(50000);
            expect(orderBook.buyOrders[2].price).toBe(49000);
        });
        
        it('should sort sell orders by price ascending', () => {
            orderBook.addOrder({ type: OrderType.SELL, price: 51000, amount: 0.1, userId: 'user1' });
            orderBook.addOrder({ type: OrderType.SELL, price: 50000, amount: 0.1, userId: 'user2' });
            orderBook.addOrder({ type: OrderType.SELL, price: 52000, amount: 0.1, userId: 'user3' });
            
            expect(orderBook.sellOrders[0].price).toBe(50000);
            expect(orderBook.sellOrders[1].price).toBe(51000);
            expect(orderBook.sellOrders[2].price).toBe(52000);
        });
        
        it('should cancel orders', () => {
            const order = orderBook.addOrder({
                type: OrderType.BUY,
                price: 50000,
                amount: 0.1,
                userId: 'user1'
            });
            
            const result = orderBook.cancelOrder(order.id, 'user1');
            
            expect(result).toBe(true);
            expect(order.status).toBe(OrderStatus.CANCELLED);
            expect(orderBook.buyOrders.length).toBe(0);
        });
        
        it('should not cancel orders from different users', () => {
            const order = orderBook.addOrder({
                type: OrderType.BUY,
                price: 50000,
                amount: 0.1,
                userId: 'user1'
            });
            
            const result = orderBook.cancelOrder(order.id, 'user2');
            
            expect(result).toBe(false);
            expect(order.status).toBe(OrderStatus.OPEN);
        });
    });
    
    describe('Order Book Depth', () => {
        it('should calculate depth correctly', () => {
            // Add buy orders
            orderBook.addOrder({ type: OrderType.BUY, price: 50000, amount: 0.1, userId: 'user1' });
            orderBook.addOrder({ type: OrderType.BUY, price: 49900, amount: 0.2, userId: 'user2' });
            orderBook.addOrder({ type: OrderType.BUY, price: 49800, amount: 0.3, userId: 'user3' });
            
            // Add sell orders
            orderBook.addOrder({ type: OrderType.SELL, price: 50100, amount: 0.15, userId: 'user4' });
            orderBook.addOrder({ type: OrderType.SELL, price: 50200, amount: 0.25, userId: 'user5' });
            
            const depth = orderBook.getDepth(3);
            
            expect(depth.bids).toHaveLength(3);
            expect(depth.asks).toHaveLength(2);
            
            expect(depth.bids[0]).toEqual({ price: 50000, amount: 0.1, total: 0.1 });
            expect(depth.bids[1]).toEqual({ price: 49900, amount: 0.2, total: 0.3 });
            
            expect(depth.asks[0]).toEqual({ price: 50100, amount: 0.15, total: 0.15 });
        });
        
        it('should calculate spread correctly', () => {
            orderBook.addOrder({ type: OrderType.BUY, price: 50000, amount: 0.1, userId: 'user1' });
            orderBook.addOrder({ type: OrderType.SELL, price: 50100, amount: 0.1, userId: 'user2' });
            
            const spread = orderBook.getSpread();
            
            expect(spread.bid).toBe(50000);
            expect(spread.ask).toBe(50100);
            expect(spread.spread).toBe(100);
            expect(spread.spreadPercent).toBeCloseTo(0.2, 2);
        });
    });
});

describe('MatchingEngine', () => {
    let engine;
    let orderBook;
    
    beforeEach(() => {
        orderBook = new OrderBook('BTC', 'USDT');
        engine = new MatchingEngine(orderBook);
    });
    
    describe('Order Matching', () => {
        it('should match buy and sell orders at same price', () => {
            const sellOrder = orderBook.addOrder({
                type: OrderType.SELL,
                price: 50000,
                amount: 0.1,
                userId: 'seller'
            });
            
            const buyOrder = orderBook.addOrder({
                type: OrderType.BUY,
                price: 50000,
                amount: 0.1,
                userId: 'buyer'
            });
            
            const trades = engine.matchOrder(buyOrder);
            
            expect(trades).toHaveLength(1);
            expect(trades[0].price).toBe(50000);
            expect(trades[0].amount).toBe(0.1);
            expect(trades[0].maker).toBe(sellOrder);
            expect(trades[0].taker).toBe(buyOrder);
            
            expect(buyOrder.status).toBe(OrderStatus.FILLED);
            expect(sellOrder.status).toBe(OrderStatus.FILLED);
        });
        
        it('should match buy order with multiple sell orders', () => {
            orderBook.addOrder({ type: OrderType.SELL, price: 50000, amount: 0.05, userId: 'seller1' });
            orderBook.addOrder({ type: OrderType.SELL, price: 50100, amount: 0.05, userId: 'seller2' });
            
            const buyOrder = orderBook.addOrder({
                type: OrderType.BUY,
                price: 50100,
                amount: 0.1,
                userId: 'buyer'
            });
            
            const trades = engine.matchOrder(buyOrder);
            
            expect(trades).toHaveLength(2);
            expect(trades[0].amount).toBe(0.05);
            expect(trades[0].price).toBe(50000);
            expect(trades[1].amount).toBe(0.05);
            expect(trades[1].price).toBe(50100);
            
            expect(buyOrder.status).toBe(OrderStatus.FILLED);
            expect(buyOrder.filledAmount).toBe(0.1);
        });
        
        it('should partially fill orders', () => {
            const sellOrder = orderBook.addOrder({
                type: OrderType.SELL,
                price: 50000,
                amount: 0.2,
                userId: 'seller'
            });
            
            const buyOrder = orderBook.addOrder({
                type: OrderType.BUY,
                price: 50000,
                amount: 0.1,
                userId: 'buyer'
            });
            
            const trades = engine.matchOrder(buyOrder);
            
            expect(trades).toHaveLength(1);
            expect(trades[0].amount).toBe(0.1);
            
            expect(buyOrder.status).toBe(OrderStatus.FILLED);
            expect(sellOrder.status).toBe(OrderStatus.PARTIALLY_FILLED);
            expect(sellOrder.filledAmount).toBe(0.1);
            expect(sellOrder.remainingAmount).toBe(0.1);
        });
        
        it('should not match orders with price gap', () => {
            orderBook.addOrder({
                type: OrderType.SELL,
                price: 51000,
                amount: 0.1,
                userId: 'seller'
            });
            
            const buyOrder = orderBook.addOrder({
                type: OrderType.BUY,
                price: 50000,
                amount: 0.1,
                userId: 'buyer'
            });
            
            const trades = engine.matchOrder(buyOrder);
            
            expect(trades).toHaveLength(0);
            expect(buyOrder.status).toBe(OrderStatus.OPEN);
        });
    });
    
    describe('Market Orders', () => {
        it('should fill market buy orders at best prices', () => {
            orderBook.addOrder({ type: OrderType.SELL, price: 50000, amount: 0.05, userId: 'seller1' });
            orderBook.addOrder({ type: OrderType.SELL, price: 50100, amount: 0.05, userId: 'seller2' });
            orderBook.addOrder({ type: OrderType.SELL, price: 50200, amount: 0.05, userId: 'seller3' });
            
            const marketOrder = {
                type: OrderType.BUY,
                price: null, // Market order
                amount: 0.1,
                userId: 'buyer',
                isMarket: true
            };
            
            const trades = engine.matchMarketOrder(marketOrder);
            
            expect(trades).toHaveLength(2);
            expect(trades[0].price).toBe(50000);
            expect(trades[1].price).toBe(50100);
        });
    });
    
    describe('Trade Execution', () => {
        it('should emit trade events', (done) => {
            engine.on('trade', (trade) => {
                expect(trade.price).toBe(50000);
                expect(trade.amount).toBe(0.1);
                done();
            });
            
            orderBook.addOrder({
                type: OrderType.SELL,
                price: 50000,
                amount: 0.1,
                userId: 'seller'
            });
            
            const buyOrder = orderBook.addOrder({
                type: OrderType.BUY,
                price: 50000,
                amount: 0.1,
                userId: 'buyer'
            });
            
            engine.matchOrder(buyOrder);
        });
        
        it('should calculate fees correctly', () => {
            const sellOrder = orderBook.addOrder({
                type: OrderType.SELL,
                price: 50000,
                amount: 0.1,
                userId: 'seller'
            });
            
            const buyOrder = orderBook.addOrder({
                type: OrderType.BUY,
                price: 50000,
                amount: 0.1,
                userId: 'buyer'
            });
            
            engine.config.makerFee = 0.001; // 0.1%
            engine.config.takerFee = 0.002; // 0.2%
            
            const trades = engine.matchOrder(buyOrder);
            
            expect(trades[0].fees.maker).toBe(0.0001); // 0.1 * 0.001
            expect(trades[0].fees.taker).toBe(0.0002); // 0.1 * 0.002
        });
    });
});

describe('DexPair', () => {
    let pair;
    
    beforeEach(() => {
        pair = new DexPair({
            baseAsset: 'BTC',
            quoteAsset: 'USDT',
            minOrderSize: 0.001,
            tickSize: 0.01,
            makerFee: 0.001,
            takerFee: 0.002
        });
    });
    
    describe('Trading Pair Management', () => {
        it('should validate order parameters', () => {
            const validOrder = {
                type: OrderType.BUY,
                price: 50000,
                amount: 0.01,
                userId: 'user1'
            };
            
            expect(pair.validateOrder(validOrder)).toBe(true);
            
            const invalidOrder = {
                type: OrderType.BUY,
                price: 50000.001, // Invalid tick size
                amount: 0.0001, // Below minimum
                userId: 'user1'
            };
            
            const validation = pair.validateOrder(invalidOrder);
            expect(validation.valid).toBe(false);
            expect(validation.errors).toContain('Invalid tick size');
            expect(validation.errors).toContain('Order size below minimum');
        });
        
        it('should track 24h statistics', async () => {
            // Simulate trades
            pair.recordTrade({
                price: 50000,
                amount: 0.1,
                timestamp: Date.now()
            });
            
            pair.recordTrade({
                price: 51000,
                amount: 0.2,
                timestamp: Date.now()
            });
            
            const stats = pair.get24hStats();
            
            expect(stats.volume).toBe(0.3);
            expect(stats.high).toBe(51000);
            expect(stats.low).toBe(50000);
            expect(stats.trades).toBe(2);
        });
        
        it('should calculate VWAP correctly', () => {
            pair.recordTrade({ price: 50000, amount: 0.1 });
            pair.recordTrade({ price: 51000, amount: 0.2 });
            pair.recordTrade({ price: 52000, amount: 0.1 });
            
            const vwap = pair.calculateVWAP();
            
            // VWAP = (50000*0.1 + 51000*0.2 + 52000*0.1) / 0.4
            expect(vwap).toBe(51000);
        });
    });
    
    describe('Price Discovery', () => {
        it('should update last price on trade', () => {
            expect(pair.lastPrice).toBe(0);
            
            pair.recordTrade({
                price: 50000,
                amount: 0.1
            });
            
            expect(pair.lastPrice).toBe(50000);
        });
        
        it('should track price changes', () => {
            pair.lastPrice = 50000;
            
            pair.recordTrade({
                price: 51000,
                amount: 0.1
            });
            
            const stats = pair.get24hStats();
            expect(stats.change).toBe(1000);
            expect(stats.changePercent).toBe(2);
        });
    });
});