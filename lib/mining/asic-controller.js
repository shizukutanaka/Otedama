const net = require('net');
const EventEmitter = require('events');
const crypto = require('crypto');

class ASICController extends EventEmitter {
    constructor(config) {
        super();
        this.config = {
            type: config.type || 'antminer', // antminer, whatsminer, avalon, innosilicon
            host: config.host || '192.168.1.100',
            port: config.port || 4028, // CGMiner API port
            username: config.username || 'root',
            password: config.password || 'root',
            pollInterval: config.pollInterval || 5000,
            timeout: config.timeout || 10000,
            ...config
        };
        
        this.connected = false;
        this.stats = {
            hashrate: 0,
            temperature: 0,
            fanSpeed: 0,
            accepted: 0,
            rejected: 0,
            errors: 0,
            uptime: 0
        };
        
        this.commandQueue = [];
        this.processing = false;
    }
    
    async connect() {
        try {
            // Test connection
            const info = await this.sendCommand('version');
            if (info) {
                this.connected = true;
                this.emit('connected', info);
                
                // Start monitoring
                this.startMonitoring();
                
                return true;
            }
        } catch (err) {
            this.emit('error', err);
            return false;
        }
    }
    
    async sendCommand(command, parameter = '') {
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            let response = '';
            
            // Build command
            const cmdObj = {
                command: command,
                parameter: parameter
            };
            const cmdStr = JSON.stringify(cmdObj);
            
            socket.setTimeout(this.config.timeout);
            
            socket.connect(this.config.port, this.config.host, () => {
                socket.write(cmdStr);
            });
            
            socket.on('data', (data) => {
                response += data.toString();
                
                // Check if we have complete response
                if (response.includes('\x00')) {
                    socket.end();
                }
            });
            
            socket.on('end', () => {
                try {
                    // Remove null terminator
                    response = response.replace(/\x00$/, '');
                    const result = JSON.parse(response);
                    
                    if (result.STATUS && result.STATUS[0]) {
                        if (result.STATUS[0].STATUS === 'E') {
                            reject(new Error(result.STATUS[0].Msg || 'Command error'));
                        } else {
                            resolve(result);
                        }
                    } else {
                        resolve(result);
                    }
                } catch (err) {
                    reject(new Error('Invalid response: ' + err.message));
                }
            });
            
            socket.on('error', (err) => {
                reject(err);
            });
            
            socket.on('timeout', () => {
                socket.destroy();
                reject(new Error('Command timeout'));
            });
        });
    }
    
    // Common ASIC API commands
    async getStats() {
        try {
            const result = await this.sendCommand('stats');
            
            if (result.STATS) {
                const stats = result.STATS[0];
                
                // Parse based on miner type
                if (this.config.type === 'antminer') {
                    this.stats = this.parseAntminerStats(stats);
                } else if (this.config.type === 'whatsminer') {
                    this.stats = this.parseWhatsminerStats(stats);
                } else if (this.config.type === 'avalon') {
                    this.stats = this.parseAvalonStats(stats);
                } else {
                    this.stats = this.parseGenericStats(stats);
                }
                
                this.emit('stats', this.stats);
                return this.stats;
            }
        } catch (err) {
            this.emit('error', err);
            throw err;
        }
    }
    
    async getSummary() {
        const result = await this.sendCommand('summary');
        return result.SUMMARY ? result.SUMMARY[0] : null;
    }
    
    async getPools() {
        const result = await this.sendCommand('pools');
        return result.POOLS || [];
    }
    
    async getDevices() {
        const result = await this.sendCommand('devs');
        return result.DEVS || [];
    }
    
    async getConfig() {
        const result = await this.sendCommand('config');
        return result.CONFIG ? result.CONFIG[0] : null;
    }
    
    // Pool management
    async addPool(url, user, pass) {
        return await this.sendCommand('addpool', `${url},${user},${pass}`);
    }
    
    async removePool(poolId) {
        return await this.sendCommand('removepool', poolId.toString());
    }
    
    async switchPool(poolId) {
        return await this.sendCommand('switchpool', poolId.toString());
    }
    
    async enablePool(poolId) {
        return await this.sendCommand('enablepool', poolId.toString());
    }
    
    async disablePool(poolId) {
        return await this.sendCommand('disablepool', poolId.toString());
    }
    
    // Device control
    async restart() {
        return await this.sendCommand('restart');
    }
    
    async reboot() {
        // Some miners use different commands
        try {
            return await this.sendCommand('reboot');
        } catch (err) {
            return await this.sendCommand('quit');
        }
    }
    
    async setFanSpeed(speed) {
        // Fan control varies by miner
        if (this.config.type === 'antminer') {
            return await this.setBitmainFan(speed);
        } else {
            return await this.sendCommand('fanspeed', speed.toString());
        }
    }
    
    // Bitmain specific
    async setBitmainFan(speed) {
        // Bitmain uses different API
        return await this.sendCommand('bitmain-fan-ctrl', speed.toString());
    }
    
    async getBitmainInfo() {
        return await this.sendCommand('get_miner_info');
    }
    
    // Monitoring
    startMonitoring() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
        }
        
        this.monitorInterval = setInterval(async () => {
            try {
                await this.getStats();
                
                // Check for issues
                this.checkHealth();
                
            } catch (err) {
                this.emit('error', err);
            }
        }, this.config.pollInterval);
    }
    
    stopMonitoring() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
    }
    
    // Health checks
    checkHealth() {
        const warnings = [];
        
        // Temperature check
        if (this.stats.temperature > 85) {
            warnings.push({
                type: 'temperature',
                severity: 'critical',
                message: `High temperature: ${this.stats.temperature}°C`
            });
        } else if (this.stats.temperature > 75) {
            warnings.push({
                type: 'temperature',
                severity: 'warning',
                message: `Elevated temperature: ${this.stats.temperature}°C`
            });
        }
        
        // Hashrate check
        if (this.stats.hashrate === 0) {
            warnings.push({
                type: 'hashrate',
                severity: 'critical',
                message: 'No hashrate detected'
            });
        }
        
        // Error rate check
        const errorRate = this.stats.rejected / (this.stats.accepted + this.stats.rejected);
        if (errorRate > 0.05) {
            warnings.push({
                type: 'errors',
                severity: 'warning',
                message: `High error rate: ${(errorRate * 100).toFixed(2)}%`
            });
        }
        
        if (warnings.length > 0) {
            this.emit('health-warning', warnings);
        }
    }
    
    // Stats parsing for different miner types
    parseAntminerStats(stats) {
        return {
            hashrate: parseFloat(stats['GHS 5s'] || stats['MHS 5s'] || 0) * (stats['GHS 5s'] ? 1e9 : 1e6),
            temperature: Math.max(
                parseFloat(stats.temp1 || 0),
                parseFloat(stats.temp2 || 0),
                parseFloat(stats.temp3 || 0)
            ),
            fanSpeed: parseInt(stats.fan1 || stats.fan2 || 0),
            accepted: parseInt(stats.Accepted || 0),
            rejected: parseInt(stats.Rejected || 0),
            errors: parseInt(stats['Hardware Errors'] || 0),
            uptime: parseInt(stats.Elapsed || 0),
            pools: stats.POOLS || 1,
            frequency: parseFloat(stats.frequency || 0)
        };
    }
    
    parseWhatsminerStats(stats) {
        return {
            hashrate: parseFloat(stats['MHS av'] || 0) * 1e6,
            temperature: parseFloat(stats['Temperature'] || 0),
            fanSpeed: parseInt(stats['Fan Speed In'] || 0),
            accepted: parseInt(stats['Accepted'] || 0),
            rejected: parseInt(stats['Rejected'] || 0),
            errors: parseInt(stats['Device Hardware%'] || 0),
            uptime: parseInt(stats['Elapsed'] || 0),
            powerUsage: parseFloat(stats['Power'] || 0)
        };
    }
    
    parseAvalonStats(stats) {
        return {
            hashrate: parseFloat(stats['GHS av'] || 0) * 1e9,
            temperature: parseFloat(stats['temp_max'] || 0),
            fanSpeed: parseInt(stats['fan_pct'] || 0),
            accepted: parseInt(stats['Accepted'] || 0),
            rejected: parseInt(stats['Rejected'] || 0),
            errors: parseInt(stats['Device Hardware%'] || 0),
            uptime: parseInt(stats['Elapsed'] || 0),
            voltage: parseFloat(stats['voltage'] || 0)
        };
    }
    
    parseGenericStats(stats) {
        // Generic parser for unknown miners
        return {
            hashrate: parseFloat(stats['GHS 5s'] || stats['MHS 5s'] || stats['KHS 5s'] || 0),
            temperature: parseFloat(stats.Temperature || stats.temp || 0),
            fanSpeed: parseInt(stats['Fan Speed'] || stats.fan || 0),
            accepted: parseInt(stats.Accepted || 0),
            rejected: parseInt(stats.Rejected || 0),
            errors: parseInt(stats['Hardware Errors'] || stats.HW || 0),
            uptime: parseInt(stats.Elapsed || 0)
        };
    }
    
    // Batch operations
    async executeCommands(commands) {
        const results = [];
        
        for (const cmd of commands) {
            try {
                const result = await this.sendCommand(cmd.command, cmd.parameter);
                results.push({ success: true, command: cmd, result });
            } catch (err) {
                results.push({ success: false, command: cmd, error: err.message });
            }
        }
        
        return results;
    }
    
    // Factory method for different ASIC types
    static createController(type, config) {
        const controllerConfig = {
            ...config,
            type: type.toLowerCase()
        };
        
        // Set default ports for different miners
        switch (type.toLowerCase()) {
            case 'antminer':
                controllerConfig.port = config.port || 4028;
                break;
            case 'whatsminer':
                controllerConfig.port = config.port || 4028;
                break;
            case 'avalon':
                controllerConfig.port = config.port || 4028;
                break;
            case 'innosilicon':
                controllerConfig.port = config.port || 4028;
                break;
        }
        
        return new ASICController(controllerConfig);
    }
    
    // Disconnect
    disconnect() {
        this.stopMonitoring();
        this.connected = false;
        this.emit('disconnected');
    }
}

// ASIC Farm Manager
class ASICFarmManager extends EventEmitter {
    constructor() {
        super();
        this.miners = new Map();
        this.groups = new Map();
    }
    
    addMiner(id, type, config) {
        const controller = ASICController.createController(type, config);
        
        controller.on('error', (err) => {
            this.emit('miner-error', { id, error: err });
        });
        
        controller.on('health-warning', (warnings) => {
            this.emit('health-alert', { id, warnings });
        });
        
        this.miners.set(id, controller);
        return controller;
    }
    
    async connectAll() {
        const results = [];
        
        for (const [id, controller] of this.miners) {
            try {
                await controller.connect();
                results.push({ id, success: true });
            } catch (err) {
                results.push({ id, success: false, error: err.message });
            }
        }
        
        return results;
    }
    
    getMiner(id) {
        return this.miners.get(id);
    }
    
    async getAllStats() {
        const stats = {};
        
        for (const [id, controller] of this.miners) {
            try {
                stats[id] = await controller.getStats();
            } catch (err) {
                stats[id] = { error: err.message };
            }
        }
        
        return stats;
    }
    
    getTotalHashrate() {
        let total = 0;
        
        for (const controller of this.miners.values()) {
            total += controller.stats.hashrate || 0;
        }
        
        return total;
    }
    
    // Group operations
    createGroup(name, minerIds) {
        this.groups.set(name, new Set(minerIds));
    }
    
    async executeOnGroup(groupName, command, parameter) {
        const group = this.groups.get(groupName);
        if (!group) return null;
        
        const results = [];
        
        for (const minerId of group) {
            const controller = this.miners.get(minerId);
            if (controller) {
                try {
                    const result = await controller.sendCommand(command, parameter);
                    results.push({ minerId, success: true, result });
                } catch (err) {
                    results.push({ minerId, success: false, error: err.message });
                }
            }
        }
        
        return results;
    }
    
    // Batch pool switching
    async switchAllPools(poolId) {
        const results = [];
        
        for (const [id, controller] of this.miners) {
            try {
                await controller.switchPool(poolId);
                results.push({ id, success: true });
            } catch (err) {
                results.push({ id, success: false, error: err.message });
            }
        }
        
        return results;
    }
    
    disconnectAll() {
        for (const controller of this.miners.values()) {
            controller.disconnect();
        }
    }
}

module.exports = {
    ASICController,
    ASICFarmManager
};