/**
 * Standalone Mining Pool Module
 * Export all standalone components
 */

module.exports = {
    StandalonePool: require('./standalone-pool'),
    BlockchainConnector: require('./blockchain-connector'),
    LocalShareChain: require('./local-share-chain'),
    AutoDiscovery: require('./auto-discovery'),
    RewardDistributor: require('./reward-distributor')
};