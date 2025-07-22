const http = require('http');
const https = require('https');
const EventEmitter = require('events');

class BlockchainRPCClient extends EventEmitter {
    constructor(config) {
        super();
        this.config = {
            host: config.host || 'localhost',
            port: config.port || 8332,
            user: config.user || 'rpcuser',
            pass: config.pass || 'rpcpass',
            ssl: config.ssl || false,
            timeout: config.timeout || 30000,
            coin: config.coin || 'bitcoin',
            ...config
        };
        
        this.id = 0;
        this.client = this.config.ssl ? https : http;
    }
    
    async call(method, params = []) {
        return new Promise((resolve, reject) => {
            const payload = JSON.stringify({
                jsonrpc: '1.0',
                id: ++this.id,
                method: method,
                params: params
            });
            
            const options = {
                hostname: this.config.host,
                port: this.config.port,
                path: '/',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': payload.length,
                    'Authorization': 'Basic ' + Buffer.from(`${this.config.user}:${this.config.pass}`).toString('base64')
                },
                timeout: this.config.timeout
            };
            
            const req = this.client.request(options, (res) => {
                let data = '';
                
                res.on('data', chunk => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        if (response.error) {
                            reject(new Error(response.error.message || 'RPC Error'));
                        } else {
                            resolve(response.result);
                        }
                    } catch (err) {
                        reject(new Error('Invalid JSON response: ' + err.message));
                    }
                });
            });
            
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('RPC request timeout'));
            });
            
            req.write(payload);
            req.end();
        });
    }
    
    // Bitcoin Core compatible methods
    async getBlockTemplate(params = {}) {
        return this.call('getblocktemplate', [params]);
    }
    
    async submitBlock(blockHex) {
        return this.call('submitblock', [blockHex]);
    }
    
    async getInfo() {
        try {
            // Try newer method first
            return await this.call('getblockchaininfo');
        } catch (err) {
            // Fallback to older method
            return this.call('getinfo');
        }
    }
    
    async getMiningInfo() {
        return this.call('getmininginfo');
    }
    
    async getNetworkHashRate() {
        return this.call('getnetworkhashps');
    }
    
    async getBlockCount() {
        return this.call('getblockcount');
    }
    
    async getBlock(blockhash, verbose = true) {
        return this.call('getblock', [blockhash, verbose]);
    }
    
    async getBlockHash(height) {
        return this.call('getblockhash', [height]);
    }
    
    async getDifficulty() {
        return this.call('getdifficulty');
    }
    
    async validateAddress(address) {
        return this.call('validateaddress', [address]);
    }
    
    async sendRawTransaction(hexstring) {
        return this.call('sendrawtransaction', [hexstring]);
    }
    
    async getTransaction(txid) {
        return this.call('gettransaction', [txid]);
    }
    
    async getRawTransaction(txid, verbose = true) {
        return this.call('getrawtransaction', [txid, verbose]);
    }
    
    // Ethereum-specific methods
    async eth_getWork() {
        return this.call('eth_getWork');
    }
    
    async eth_submitWork(nonce, header, mix) {
        return this.call('eth_submitWork', [nonce, header, mix]);
    }
    
    async eth_submitHashrate(hashrate, id) {
        return this.call('eth_submitHashrate', [hashrate, id]);
    }
    
    async eth_blockNumber() {
        return this.call('eth_blockNumber');
    }
    
    async eth_getBlockByNumber(number, full = false) {
        return this.call('eth_getBlockByNumber', [number, full]);
    }
    
    // Helper methods
    async testConnection() {
        try {
            await this.getInfo();
            return true;
        } catch (err) {
            return false;
        }
    }
    
    async waitForBlock(timeout = 60000) {
        return new Promise(async (resolve, reject) => {
            const startHeight = await this.getBlockCount();
            const checkInterval = 1000;
            let elapsed = 0;
            
            const interval = setInterval(async () => {
                try {
                    const currentHeight = await this.getBlockCount();
                    if (currentHeight > startHeight) {
                        clearInterval(interval);
                        const hash = await this.getBlockHash(currentHeight);
                        const block = await this.getBlock(hash);
                        resolve(block);
                    }
                    
                    elapsed += checkInterval;
                    if (elapsed >= timeout) {
                        clearInterval(interval);
                        reject(new Error('Timeout waiting for new block'));
                    }
                } catch (err) {
                    clearInterval(interval);
                    reject(err);
                }
            }, checkInterval);
        });
    }
    
    // Multi-coin support
    static createClient(coin, config) {
        const coinConfigs = {
            bitcoin: {
                port: 8332,
                ssl: false
            },
            litecoin: {
                port: 9332,
                ssl: false
            },
            ethereum: {
                port: 8545,
                ssl: false
            },
            monero: {
                port: 18081,
                ssl: false
            },
            dash: {
                port: 9998,
                ssl: false
            },
            ravencoin: {
                port: 8766,
                ssl: false
            },
            'bitcoin-cash': {
                port: 8332,
                ssl: false
            },
            dogecoin: {
                port: 22555,
                ssl: false
            }
        };
        
        const coinConfig = coinConfigs[coin.toLowerCase()] || {};
        return new BlockchainRPCClient({
            ...coinConfig,
            ...config,
            coin: coin
        });
    }
}

// Multi-chain RPC Manager
class MultiChainRPCManager extends EventEmitter {
    constructor() {
        super();
        this.clients = new Map();
        this.activeClient = null;
    }
    
    addClient(name, type, config) {
        const client = BlockchainRPCClient.createClient(type, config);
        
        this.clients.set(name, {
            type: type,
            client: client,
            config: config
        });
        
        // Set as active if first client
        if (!this.activeClient && this.clients.size === 1) {
            this.activeClient = name;
        }
        
        this.emit('client-added', { name, type });
        return client;
    }
    
    getClient(name) {
        const clientInfo = this.clients.get(name);
        return clientInfo ? clientInfo.client : null;
    }
    
    getActiveClient() {
        return this.getClient(this.activeClient);
    }
    
    setActiveClient(name) {
        if (this.clients.has(name)) {
            this.activeClient = name;
            this.emit('active-client-changed', { name });
            return true;
        }
        return false;
    }
    
    removeClient(name) {
        if (this.clients.delete(name)) {
            if (this.activeClient === name) {
                this.activeClient = this.clients.size > 0 ? 
                    this.clients.keys().next().value : null;
            }
            this.emit('client-removed', { name });
            return true;
        }
        return false;
    }
    
    async testConnections() {
        const results = {};
        
        for (const [name, info] of this.clients) {
            try {
                const connected = await info.client.testConnection();
                const blockHeight = connected ? await info.client.getBlockCount() : null;
                
                results[name] = {
                    success: connected,
                    blockHeight: blockHeight,
                    type: info.type
                };
                
            } catch (error) {
                results[name] = {
                    success: false,
                    error: error.message
                };
            }
        }
        
        return results;
    }
    
    getClientsInfo() {
        const info = [];
        
        for (const [name, clientInfo] of this.clients) {
            info.push({
                name: name,
                type: clientInfo.type,
                active: name === this.activeClient,
                config: {
                    host: clientInfo.config.host,
                    port: clientInfo.config.port,
                    ssl: clientInfo.config.ssl
                }
            });
        }
        
        return info;
    }
}

module.exports = {
    BlockchainRPCClient,
    MultiChainRPCManager
};