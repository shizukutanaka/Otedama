/**
 * WebSocket Real-time Module
 * Export all WebSocket components
 */

export { RealtimeServer, MiningStatsServer, DexDataServer, RealtimeClient } from './realtime-server.js';
export { RealtimeDataClient, MiningDataClient, TradingDataClient } from './realtime-client.js';
export { RealtimeIntegration, createRealtimeIntegration } from './realtime-integration.js';

// Quick setup function
export function setupRealtimeServers(config = {}) {
    const integration = new RealtimeIntegration(config);
    
    integration.initialize()
        .then(() => {
            console.log('Real-time servers initialized');
            console.log(`Mining stats: ws://localhost:${config.miningPort || 8081}`);
            console.log(`DEX data: ws://localhost:${config.dexPort || 8082}`);
        })
        .catch(error => {
            console.error('Failed to initialize real-time servers:', error);
        });
    
    return integration;
}