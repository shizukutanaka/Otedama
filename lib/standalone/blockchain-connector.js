/**
 * Blockchain Connector
 * Direct connection to blockchain node for block templates and submissions
 * Supports Bitcoin and compatible cryptocurrencies
 */

const { EventEmitter } = require('events');
const http = require('http');
const https = require('https');

class BlockchainConnector extends EventEmitter {
    constructor(config) {
        super();
        
        this.config = {
            url: config.url || 'http://localhost:8332',
            user: config.user || 'user',
            pass: config.pass || 'pass',
            timeout: config.timeout || 30000,
            maxRetries: config.maxRetries || 3,
            retryDelay: config.retryDelay || 1000,
            ...config
        };
        
        // Parse URL
        const url = new URL(this.config.url);
        this.protocol = url.protocol === 'https:' ? https : http;
        this.hostname = url.hostname;
        this.port = url.port || (url.protocol === 'https:' ? 443 : 80);
        this.path = url.pathname || '/';
        
        // Connection state
        this.connected = false;
        this.lastBlockTemplate = null;
        this.blockHeight = 0;
        this.networkInfo = null;
    }
    
    // Connect to blockchain node
    async connect() {
        try {
            // Test connection and get network info
            this.networkInfo = await this.call('getnetworkinfo');
            const blockchainInfo = await this.call('getblockchaininfo');
            
            this.blockHeight = blockchainInfo.blocks;
            this.connected = true;
            
            this.emit('connected', {
                network: this.networkInfo,
                height: this.blockHeight
            });
            
            // Start monitoring for new blocks
            this.startBlockMonitoring();
            
        } catch (error) {
            this.connected = false;
            throw new Error(`Failed to connect to blockchain: ${error.message}`);
        }
    }
    
    // Make RPC call
    async call(method, params = []) {
        const id = Date.now();
        const postData = JSON.stringify({
            jsonrpc: '2.0',
            id,
            method,
            params
        });
        
        const options = {
            hostname: this.hostname,
            port: this.port,
            path: this.path,
            method: 'POST',
            auth: `${this.config.user}:${this.config.pass}`,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: this.config.timeout
        };
        
        let retries = 0;
        while (retries < this.config.maxRetries) {
            try {
                const result = await this.makeRequest(options, postData);
                
                if (result.error) {
                    throw new Error(result.error.message || 'RPC error');
                }
                
                return result.result;
                
            } catch (error) {
                retries++;
                if (retries >= this.config.maxRetries) {
                    throw error;
                }
                
                await this.delay(this.config.retryDelay * retries);
            }
        }
    }
    
    // Make HTTP request
    makeRequest(options, postData) {
        return new Promise((resolve, reject) => {
            const req = this.protocol.request(options, (res) => {
                let data = '';
                
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        resolve(result);
                    } catch (error) {
                        reject(new Error('Invalid JSON response'));
                    }
                });
            });
            
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
            
            req.write(postData);
            req.end();
        });
    }
    
    // Get block template for mining
    async getBlockTemplate(capabilities = ['coinbasetxn', 'workid', 'coinbase/append']) {
        try {
            const template = await this.call('getblocktemplate', [{
                capabilities,
                rules: ['segwit']
            }]);
            
            this.lastBlockTemplate = template;
            this.emit('template:new', template);
            
            return template;
            
        } catch (error) {
            // Fallback to getwork for older nodes
            if (error.message.includes('getblocktemplate')) {
                return this.getWork();
            }
            throw error;
        }
    }
    
    // Fallback getwork method
    async getWork() {
        const work = await this.call('getwork');
        
        // Convert getwork to block template format
        return {
            version: 1,
            previousblockhash: work.data.substring(8, 72),
            transactions: [],
            coinbasevalue: 5000000000, // Default 50 BTC, adjust as needed
            coinbaseaux: { flags: '' },
            target: work.target,
            mintime: Math.floor(Date.now() / 1000) - 600,
            mutable: ['time', 'transactions', 'prevblock'],
            noncerange: '00000000ffffffff',
            sigoplimit: 20000,
            sizelimit: 1000000,
            curtime: Math.floor(Date.now() / 1000),
            bits: work.data.substring(136, 144),
            height: this.blockHeight + 1
        };
    }
    
    // Submit block
    async submitBlock(blockHex) {
        try {
            // Try submitblock first
            const result = await this.call('submitblock', [blockHex]);
            
            if (result === null || result === 'duplicate' || result === 'duplicate-inconclusive') {
                // Block accepted
                const blockHash = await this.call('getbestblockhash');
                const block = await this.call('getblock', [blockHash]);
                
                return {
                    accepted: true,
                    hash: blockHash,
                    height: block.height,
                    reward: this.calculateBlockReward(block.height)
                };
            } else {
                return {
                    accepted: false,
                    error: result
                };
            }
            
        } catch (error) {
            // Fallback to getwork submission
            if (error.message.includes('submitblock')) {
                return this.submitWork(blockHex);
            }
            throw error;
        }
    }
    
    // Fallback work submission
    async submitWork(data) {
        const result = await this.call('getwork', [data]);
        
        return {
            accepted: result === true,
            hash: 'unknown',
            height: this.blockHeight + 1,
            reward: this.calculateBlockReward(this.blockHeight + 1)
        };
    }
    
    // Get current blockchain info
    async getInfo() {
        const [blockchainInfo, networkInfo, miningInfo] = await Promise.all([
            this.call('getblockchaininfo'),
            this.call('getnetworkinfo'),
            this.call('getmininginfo').catch(() => ({}))
        ]);
        
        return {
            chain: blockchainInfo.chain,
            blocks: blockchainInfo.blocks,
            headers: blockchainInfo.headers,
            difficulty: blockchainInfo.difficulty,
            medianTime: blockchainInfo.mediantime,
            chainWork: blockchainInfo.chainwork,
            version: networkInfo.version,
            protocolVersion: networkInfo.protocolversion,
            connections: networkInfo.connections,
            networkHashrate: miningInfo.networkhashps || 0
        };
    }
    
    // Get transaction
    async getTransaction(txid) {
        return this.call('getrawtransaction', [txid, true]);
    }
    
    // Send transaction
    async sendTransaction(recipients, fee = 0.0001) {
        try {
            // Create raw transaction
            const inputs = await this.call('listunspent');
            const rawTx = await this.call('createrawtransaction', [inputs, recipients]);
            
            // Sign transaction
            const signedTx = await this.call('signrawtransactionwithwallet', [rawTx]);
            
            // Send transaction
            const txid = await this.call('sendrawtransaction', [signedTx.hex]);
            
            return { txid, success: true };
            
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
    
    // Monitor for new blocks
    startBlockMonitoring() {
        this.blockMonitorInterval = setInterval(async () => {
            try {
                const info = await this.call('getblockchaininfo');
                
                if (info.blocks > this.blockHeight) {
                    this.blockHeight = info.blocks;
                    
                    const blockHash = await this.call('getblockhash', [this.blockHeight]);
                    const block = await this.call('getblock', [blockHash]);
                    
                    this.emit('block:new', {
                        height: this.blockHeight,
                        hash: blockHash,
                        previousHash: block.previousblockhash,
                        time: block.time,
                        difficulty: block.difficulty
                    });
                }
            } catch (error) {
                this.emit('error', { type: 'block_monitoring', error });
            }
        }, 10000); // Check every 10 seconds
    }
    
    // Calculate block reward based on height
    calculateBlockReward(height) {
        // Bitcoin reward halving schedule
        const halvings = Math.floor(height / 210000);
        const baseReward = 50 * 100000000; // 50 BTC in satoshis
        const reward = baseReward >> halvings;
        
        return reward;
    }
    
    // Helper delay function
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    // Disconnect
    async disconnect() {
        if (this.blockMonitorInterval) {
            clearInterval(this.blockMonitorInterval);
        }
        
        this.connected = false;
        this.emit('disconnected');
    }
}

module.exports = BlockchainConnector;