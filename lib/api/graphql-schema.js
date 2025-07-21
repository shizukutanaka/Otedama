import { GraphQLSchema, GraphQLObjectType, GraphQLString, GraphQLInt, GraphQLFloat, GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLEnumType } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

// Enums
const HealthStatusEnum = new GraphQLEnumType({
    name: 'HealthStatus',
    values: {
        HEALTHY: { value: 'healthy' },
        DEGRADED: { value: 'degraded' },
        UNHEALTHY: { value: 'unhealthy' }
    }
});

const CurrencyEnum = new GraphQLEnumType({
    name: 'Currency',
    values: {
        BTC: { value: 'BTC' },
        ETH: { value: 'ETH' },
        RVN: { value: 'RVN' },
        XMR: { value: 'XMR' },
        LTC: { value: 'LTC' },
        ETC: { value: 'ETC' },
        DOGE: { value: 'DOGE' },
        ZEC: { value: 'ZEC' },
        DASH: { value: 'DASH' },
        ERGO: { value: 'ERGO' },
        FLUX: { value: 'FLUX' },
        KAS: { value: 'KAS' },
        ALPH: { value: 'ALPH' }
    }
});

const AlgorithmEnum = new GraphQLEnumType({
    name: 'Algorithm',
    values: {
        SHA256: { value: 'SHA256' },
        ETHASH: { value: 'Ethash' },
        KAWPOW: { value: 'KawPow' },
        RANDOMX: { value: 'RandomX' },
        SCRYPT: { value: 'Scrypt' },
        ETCHASH: { value: 'Etchash' },
        AUTOLYKOS2: { value: 'Autolykos2' },
        EQUIHASH: { value: 'Equihash' },
        X11: { value: 'X11' },
        KHEAVYHASH: { value: 'kHeavyHash' },
        BLAKE3: { value: 'Blake3' }
    }
});

// Types
const HealthCheckType = new GraphQLObjectType({
    name: 'HealthCheck',
    fields: () => ({
        status: { type: GraphQLNonNull(HealthStatusEnum) },
        timestamp: { type: GraphQLNonNull(GraphQLDateTime) },
        version: { type: GraphQLString },
        uptime: { type: GraphQLFloat },
        checks: { type: GraphQLString }
    })
});

const PriceType = new GraphQLObjectType({
    name: 'Price',
    fields: () => ({
        currency: { type: GraphQLNonNull(CurrencyEnum) },
        btc: { type: GraphQLNonNull(GraphQLFloat) },
        usd: { type: GraphQLNonNull(GraphQLFloat) },
        change24h: { type: GraphQLFloat }
    })
});

const WorkerType = new GraphQLObjectType({
    name: 'Worker',
    fields: () => ({
        id: { type: GraphQLNonNull(GraphQLString) },
        name: { type: GraphQLNonNull(GraphQLString) },
        hashrate: { type: GraphQLNonNull(GraphQLFloat) },
        shares: { type: GraphQLNonNull(GraphQLInt) },
        lastSeen: { type: GraphQLNonNull(GraphQLDateTime) },
        difficulty: { type: GraphQLFloat },
        efficiency: { type: GraphQLFloat }
    })
});

const MinerType = new GraphQLObjectType({
    name: 'Miner',
    fields: () => ({
        id: { type: GraphQLNonNull(GraphQLString) },
        address: { type: GraphQLNonNull(GraphQLString) },
        currency: { type: GraphQLNonNull(CurrencyEnum) },
        hashrate: { type: GraphQLNonNull(GraphQLFloat) },
        shares: { type: GraphQLNonNull(GraphQLInt) },
        balance: { type: GraphQLNonNull(GraphQLFloat) },
        paid: { type: GraphQLNonNull(GraphQLFloat) },
        workers: { type: GraphQLList(WorkerType) },
        lastSeen: { type: GraphQLNonNull(GraphQLDateTime) },
        efficiency: { type: GraphQLFloat }
    })
});

const PoolStatsType = new GraphQLObjectType({
    name: 'PoolStats',
    fields: () => ({
        miners: { type: GraphQLNonNull(GraphQLInt) },
        workers: { type: GraphQLNonNull(GraphQLInt) },
        hashrate: { type: GraphQLNonNull(GraphQLFloat) },
        currencies: { type: GraphQLList(CurrencyStatType) },
        totalPaid: { type: GraphQLNonNull(GraphQLFloat) },
        lastBlock: { type: BlockType }
    })
});

const CurrencyStatType = new GraphQLObjectType({
    name: 'CurrencyStat',
    fields: () => ({
        currency: { type: GraphQLNonNull(CurrencyEnum) },
        algorithm: { type: GraphQLNonNull(AlgorithmEnum) },
        miners: { type: GraphQLNonNull(GraphQLInt) },
        hashrate: { type: GraphQLNonNull(GraphQLFloat) },
        difficulty: { type: GraphQLFloat },
        blockHeight: { type: GraphQLInt }
    })
});

const BlockType = new GraphQLObjectType({
    name: 'Block',
    fields: () => ({
        currency: { type: GraphQLNonNull(CurrencyEnum) },
        height: { type: GraphQLNonNull(GraphQLInt) },
        hash: { type: GraphQLNonNull(GraphQLString) },
        reward: { type: GraphQLNonNull(GraphQLFloat) },
        timestamp: { type: GraphQLNonNull(GraphQLDateTime) },
        finder: { type: GraphQLString }
    })
});

const PaymentType = new GraphQLObjectType({
    name: 'Payment',
    fields: () => ({
        id: { type: GraphQLNonNull(GraphQLString) },
        minerId: { type: GraphQLNonNull(GraphQLString) },
        amount: { type: GraphQLNonNull(GraphQLFloat) },
        currency: { type: GraphQLNonNull(CurrencyEnum) },
        txHash: { type: GraphQLString },
        timestamp: { type: GraphQLNonNull(GraphQLDateTime) },
        status: { type: GraphQLNonNull(GraphQLString) }
    })
});

// DEX Types
const OrderType = new GraphQLObjectType({
    name: 'Order',
    fields: () => ({
        id: { type: GraphQLNonNull(GraphQLString) },
        userId: { type: GraphQLNonNull(GraphQLString) },
        type: { type: GraphQLNonNull(GraphQLString) },
        side: { type: GraphQLNonNull(GraphQLString) },
        pair: { type: GraphQLNonNull(GraphQLString) },
        price: { type: GraphQLNonNull(GraphQLFloat) },
        amount: { type: GraphQLNonNull(GraphQLFloat) },
        filled: { type: GraphQLNonNull(GraphQLFloat) },
        status: { type: GraphQLNonNull(GraphQLString) },
        timestamp: { type: GraphQLNonNull(GraphQLDateTime) }
    })
});

const TradeType = new GraphQLObjectType({
    name: 'Trade',
    fields: () => ({
        id: { type: GraphQLNonNull(GraphQLString) },
        pair: { type: GraphQLNonNull(GraphQLString) },
        price: { type: GraphQLNonNull(GraphQLFloat) },
        amount: { type: GraphQLNonNull(GraphQLFloat) },
        side: { type: GraphQLNonNull(GraphQLString) },
        timestamp: { type: GraphQLNonNull(GraphQLDateTime) }
    })
});

const MarketType = new GraphQLObjectType({
    name: 'Market',
    fields: () => ({
        pair: { type: GraphQLNonNull(GraphQLString) },
        lastPrice: { type: GraphQLNonNull(GraphQLFloat) },
        bid: { type: GraphQLFloat },
        ask: { type: GraphQLFloat },
        volume24h: { type: GraphQLNonNull(GraphQLFloat) },
        high24h: { type: GraphQLFloat },
        low24h: { type: GraphQLFloat },
        change24h: { type: GraphQLFloat }
    })
});

// Query type
const QueryType = new GraphQLObjectType({
    name: 'Query',
    fields: () => ({
        health: {
            type: HealthCheckType,
            resolve: async (parent, args, context) => {
                const health = await context.healthCheck.checkHealth();
                return {
                    ...health,
                    checks: JSON.stringify(health.checks)
                };
            }
        },
        
        prices: {
            type: GraphQLList(PriceType),
            args: {
                currencies: { type: GraphQLList(CurrencyEnum) }
            },
            resolve: async (parent, args, context) => {
                const prices = await context.priceFeed.getPrices();
                if (args.currencies && args.currencies.length > 0) {
                    return Object.entries(prices)
                        .filter(([currency]) => args.currencies.includes(currency))
                        .map(([currency, data]) => ({
                            currency,
                            ...data
                        }));
                }
                return Object.entries(prices).map(([currency, data]) => ({
                    currency,
                    ...data
                }));
            }
        },
        
        poolStats: {
            type: PoolStatsType,
            resolve: async (parent, args, context) => {
                return context.miningPool.getStats();
            }
        },
        
        miner: {
            type: MinerType,
            args: {
                id: { type: GraphQLNonNull(GraphQLString) }
            },
            resolve: async (parent, args, context) => {
                // Check authentication
                if (!context.user) {
                    throw new Error('Authentication required');
                }
                
                const miner = await context.miningPool.getMiner(args.id);
                if (!miner) {
                    throw new Error('Miner not found');
                }
                
                // Check authorization
                if (context.user.role !== 'admin' && context.user.id !== miner.userId) {
                    throw new Error('Unauthorized');
                }
                
                return miner;
            }
        },
        
        myMiners: {
            type: GraphQLList(MinerType),
            resolve: async (parent, args, context) => {
                if (!context.user) {
                    throw new Error('Authentication required');
                }
                
                return context.miningPool.getMinersByUser(context.user.id);
            }
        },
        
        blocks: {
            type: GraphQLList(BlockType),
            args: {
                limit: { type: GraphQLInt, defaultValue: 10 },
                offset: { type: GraphQLInt, defaultValue: 0 },
                currency: { type: CurrencyEnum }
            },
            resolve: async (parent, args, context) => {
                return context.miningPool.getBlocks(args);
            }
        },
        
        payments: {
            type: GraphQLList(PaymentType),
            args: {
                minerId: { type: GraphQLString },
                limit: { type: GraphQLInt, defaultValue: 20 },
                offset: { type: GraphQLInt, defaultValue: 0 }
            },
            resolve: async (parent, args, context) => {
                if (!context.user) {
                    throw new Error('Authentication required');
                }
                
                // If minerId provided, check authorization
                if (args.minerId) {
                    const miner = await context.miningPool.getMiner(args.minerId);
                    if (context.user.role !== 'admin' && context.user.id !== miner.userId) {
                        throw new Error('Unauthorized');
                    }
                    return context.miningPool.getPayments({ minerId: args.minerId, ...args });
                }
                
                // Otherwise get payments for all user's miners
                return context.miningPool.getPaymentsByUser(context.user.id, args);
            }
        },
        
        // DEX queries
        markets: {
            type: GraphQLList(MarketType),
            resolve: async (parent, args, context) => {
                return context.dexEngine.getMarkets();
            }
        },
        
        orderBook: {
            type: new GraphQLObjectType({
                name: 'OrderBook',
                fields: {
                    pair: { type: GraphQLNonNull(GraphQLString) },
                    bids: { type: GraphQLList(GraphQLList(GraphQLFloat)) },
                    asks: { type: GraphQLList(GraphQLList(GraphQLFloat)) }
                }
            }),
            args: {
                pair: { type: GraphQLNonNull(GraphQLString) },
                depth: { type: GraphQLInt, defaultValue: 20 }
            },
            resolve: async (parent, args, context) => {
                return context.dexEngine.getOrderBook(args.pair, args.depth);
            }
        },
        
        myOrders: {
            type: GraphQLList(OrderType),
            args: {
                pair: { type: GraphQLString },
                status: { type: GraphQLString }
            },
            resolve: async (parent, args, context) => {
                if (!context.user) {
                    throw new Error('Authentication required');
                }
                
                return context.dexEngine.getUserOrders(context.user.id, args);
            }
        },
        
        trades: {
            type: GraphQLList(TradeType),
            args: {
                pair: { type: GraphQLNonNull(GraphQLString) },
                limit: { type: GraphQLInt, defaultValue: 50 }
            },
            resolve: async (parent, args, context) => {
                return context.dexEngine.getRecentTrades(args.pair, args.limit);
            }
        }
    })
});

// Mutation type
const MutationType = new GraphQLObjectType({
    name: 'Mutation',
    fields: () => ({
        updateMinerSettings: {
            type: MinerType,
            args: {
                minerId: { type: GraphQLNonNull(GraphQLString) },
                payoutThreshold: { type: GraphQLFloat },
                email: { type: GraphQLString }
            },
            resolve: async (parent, args, context) => {
                if (!context.user) {
                    throw new Error('Authentication required');
                }
                
                const miner = await context.miningPool.getMiner(args.minerId);
                if (context.user.role !== 'admin' && context.user.id !== miner.userId) {
                    throw new Error('Unauthorized');
                }
                
                return context.miningPool.updateMinerSettings(args.minerId, {
                    payoutThreshold: args.payoutThreshold,
                    email: args.email
                });
            }
        },
        
        // DEX mutations
        createOrder: {
            type: OrderType,
            args: {
                type: { type: GraphQLNonNull(GraphQLString) },
                side: { type: GraphQLNonNull(GraphQLString) },
                pair: { type: GraphQLNonNull(GraphQLString) },
                price: { type: GraphQLFloat },
                amount: { type: GraphQLNonNull(GraphQLFloat) }
            },
            resolve: async (parent, args, context) => {
                if (!context.user) {
                    throw new Error('Authentication required');
                }
                
                return context.dexEngine.createOrder({
                    userId: context.user.id,
                    ...args
                });
            }
        },
        
        cancelOrder: {
            type: OrderType,
            args: {
                orderId: { type: GraphQLNonNull(GraphQLString) }
            },
            resolve: async (parent, args, context) => {
                if (!context.user) {
                    throw new Error('Authentication required');
                }
                
                const order = await context.dexEngine.getOrder(args.orderId);
                if (order.userId !== context.user.id) {
                    throw new Error('Unauthorized');
                }
                
                return context.dexEngine.cancelOrder(args.orderId);
            }
        }
    })
});

// Create and export schema
export const schema = new GraphQLSchema({
    query: QueryType,
    mutation: MutationType
});

export default schema;