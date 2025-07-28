const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');

class GPUCUDAMiner extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            gpuId: options.gpuId || 0,
            intensity: options.intensity || 20,
            threads: options.threads || 1,
            blocks: options.blocks || 0, // 0 = auto
            algorithm: options.algorithm || 'sha256',
            temperature: options.temperature || 85,
            powerLimit: options.powerLimit || 100,
            ...options
        };
        
        this.cudaProcess = null;
        this.isRunning = false;
        this.hashrate = 0;
        
        // Performance tracking
        this.stats = {
            shares: { accepted: 0, rejected: 0, stale: 0 },
            temperature: 0,
            fanSpeed: 0,
            powerDraw: 0,
            efficiency: 0,
            uptime: 0,
            errors: 0
        };
        
        // CUDA kernel configurations
        this.kernelConfigs = {
            sha256: {
                threadsPerBlock: 256,
                registers: 32,
                sharedMemory: 16384,
                constantMemory: 65536
            },
            ethash: {
                threadsPerBlock: 128,
                registers: 64,
                sharedMemory: 49152,
                constantMemory: 65536
            },
            kawpow: {
                threadsPerBlock: 64,
                registers: 128,
                sharedMemory: 49152,
                constantMemory: 65536
            }
        };
    }

    async initialize() {
        try {
            // Check CUDA availability
            const cudaAvailable = await this.checkCUDASupport();
            if (!cudaAvailable) {
                throw new Error('CUDA not available');
            }
            
            // Get GPU information
            const gpuInfo = await this.getGPUInfo();
            this.gpuInfo = gpuInfo;
            
            // Optimize kernel configuration
            this.optimizeKernelConfig();
            
            this.emit('initialized', { gpu: this.gpuInfo });
            return true;
        } catch (error) {
            this.emit('error', error);
            return false;
        }
    }

    async checkCUDASupport() {
        return new Promise((resolve) => {
            const proc = spawn('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']);
            
            proc.on('error', () => resolve(false));
            proc.on('exit', (code) => resolve(code === 0));
        });
    }

    async getGPUInfo() {
        return new Promise((resolve, reject) => {
            const proc = spawn('nvidia-smi', [
                '--query-gpu=index,name,compute_cap,memory.total,memory.free,temperature.gpu,fan.speed,power.draw',
                '--format=csv,noheader,nounits',
                `-i=${this.config.gpuId}`
            ]);
            
            let output = '';
            proc.stdout.on('data', (data) => { output += data; });
            
            proc.on('exit', (code) => {
                if (code === 0) {
                    const parts = output.trim().split(', ');
                    resolve({
                        index: parseInt(parts[0]),
                        name: parts[1],
                        computeCapability: parts[2],
                        memoryTotal: parseInt(parts[3]),
                        memoryFree: parseInt(parts[4]),
                        temperature: parseInt(parts[5]),
                        fanSpeed: parseInt(parts[6]),
                        powerDraw: parseFloat(parts[7])
                    });
                } else {
                    reject(new Error('Failed to get GPU info'));
                }
            });
        });
    }

    optimizeKernelConfig() {
        const gpu = this.gpuInfo;
        const kernelConfig = this.kernelConfigs[this.config.algorithm];
        
        // Adjust based on compute capability
        const computeVersion = parseFloat(gpu.computeCapability);
        
        if (computeVersion >= 8.0) {
            // Ampere and newer
            kernelConfig.threadsPerBlock = Math.min(1024, kernelConfig.threadsPerBlock * 2);
            kernelConfig.registers = Math.min(255, kernelConfig.registers * 1.5);
        } else if (computeVersion >= 7.0) {
            // Turing/Volta
            kernelConfig.threadsPerBlock = Math.min(1024, kernelConfig.threadsPerBlock * 1.5);
        }
        
        // Calculate optimal grid size
        const smCount = this.getMultiprocessorCount(gpu.name);
        const blocksPerSM = Math.floor(2048 / kernelConfig.threadsPerBlock);
        
        this.gridSize = smCount * blocksPerSM;
        this.blockSize = kernelConfig.threadsPerBlock;
    }

    getMultiprocessorCount(gpuName) {
        // Simplified SM count mapping
        const smCounts = {
            '3090': 82,
            '3080': 68,
            '3070': 46,
            '3060': 28,
            '2080': 46,
            '2070': 36,
            '2060': 30,
            '1080': 20,
            '1070': 15,
            '1060': 10
        };
        
        for (const [model, count] of Object.entries(smCounts)) {
            if (gpuName.includes(model)) return count;
        }
        
        return 16; // Default
    }

    async start(pool, wallet) {
        if (this.isRunning) return;
        
        this.pool = pool;
        this.wallet = wallet;
        this.isRunning = true;
        
        // Start CUDA miner process
        await this.startCUDAProcess();
        
        // Start monitoring
        this.startMonitoring();
        
        this.emit('started');
    }

    async startCUDAProcess() {
        const cudaBinary = this.getCUDABinaryPath();
        
        const args = [
            '--gpu', this.config.gpuId,
            '--algo', this.config.algorithm,
            '--pool', this.pool.url,
            '--user', this.wallet,
            '--pass', this.pool.password || 'x',
            '--intensity', this.config.intensity,
            '--threads', this.blockSize,
            '--blocks', this.gridSize
        ];
        
        this.cudaProcess = spawn(cudaBinary, args);
        
        this.cudaProcess.stdout.on('data', (data) => {
            this.parseOutput(data.toString());
        });
        
        this.cudaProcess.stderr.on('data', (data) => {
            this.handleError(data.toString());
        });
        
        this.cudaProcess.on('exit', (code) => {
            this.handleExit(code);
        });
    }

    getCUDABinaryPath() {
        // Return path to compiled CUDA miner binary
        return path.join(__dirname, 'cuda-miner', `${this.config.algorithm}-cuda`);
    }

    parseOutput(output) {
        // Parse hashrate
        const hashrateMatch = output.match(/hashrate:\s*([\d.]+)\s*([KMGT]?)H\/s/i);
        if (hashrateMatch) {
            this.hashrate = this.parseHashrate(hashrateMatch[1], hashrateMatch[2]);
            this.emit('hashrate', this.hashrate);
        }
        
        // Parse shares
        if (output.includes('accepted')) {
            this.stats.shares.accepted++;
            this.emit('share:accepted');
        } else if (output.includes('rejected')) {
            this.stats.shares.rejected++;
            this.emit('share:rejected');
        } else if (output.includes('stale')) {
            this.stats.shares.stale++;
            this.emit('share:stale');
        }
        
        // Parse temperatures
        const tempMatch = output.match(/temp:\s*(\d+)/i);
        if (tempMatch) {
            this.stats.temperature = parseInt(tempMatch[1]);
        }
    }

    parseHashrate(value, unit) {
        const multipliers = {
            '': 1,
            'K': 1000,
            'M': 1000000,
            'G': 1000000000,
            'T': 1000000000000
        };
        
        return parseFloat(value) * (multipliers[unit] || 1);
    }

    handleError(error) {
        this.stats.errors++;
        this.emit('error', new Error(error));
        
        // Auto-recover from common errors
        if (error.includes('CUDA out of memory')) {
            this.reduceIntensity();
        } else if (error.includes('temperature')) {
            this.throttle();
        }
    }

    handleExit(code) {
        this.isRunning = false;
        
        if (code !== 0) {
            this.emit('crashed', { code });
            
            // Auto-restart if not stopped manually
            if (this.shouldRestart) {
                setTimeout(() => this.start(this.pool, this.wallet), 5000);
            }
        }
    }

    startMonitoring() {
        this.monitorInterval = setInterval(async () => {
            try {
                const gpuInfo = await this.getGPUInfo();
                
                this.stats.temperature = gpuInfo.temperature;
                this.stats.fanSpeed = gpuInfo.fanSpeed;
                this.stats.powerDraw = gpuInfo.powerDraw;
                
                // Calculate efficiency
                if (this.hashrate > 0 && gpuInfo.powerDraw > 0) {
                    this.stats.efficiency = this.hashrate / gpuInfo.powerDraw;
                }
                
                // Temperature management
                if (gpuInfo.temperature > this.config.temperature) {
                    this.throttle();
                } else if (gpuInfo.temperature < this.config.temperature - 10) {
                    this.boost();
                }
                
                this.emit('stats', { ...this.stats });
            } catch (error) {
                // GPU query failed
            }
        }, 5000);
    }

    reduceIntensity() {
        if (this.config.intensity > 10) {
            this.config.intensity--;
            this.restart();
            this.emit('intensity:reduced', this.config.intensity);
        }
    }

    throttle() {
        if (this.config.powerLimit > 70) {
            this.config.powerLimit -= 5;
            this.applyPowerLimit();
            this.emit('throttled', this.config.powerLimit);
        }
    }

    boost() {
        if (this.config.powerLimit < 100) {
            this.config.powerLimit += 5;
            this.applyPowerLimit();
            this.emit('boosted', this.config.powerLimit);
        }
    }

    async applyPowerLimit() {
        return new Promise((resolve) => {
            const proc = spawn('nvidia-smi', [
                '-i', this.config.gpuId,
                '-pl', this.config.powerLimit
            ]);
            
            proc.on('exit', () => resolve());
        });
    }

    async stop() {
        this.shouldRestart = false;
        this.isRunning = false;
        
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
        }
        
        if (this.cudaProcess) {
            this.cudaProcess.kill('SIGTERM');
            
            // Force kill after timeout
            setTimeout(() => {
                if (this.cudaProcess) {
                    this.cudaProcess.kill('SIGKILL');
                }
            }, 5000);
        }
        
        this.emit('stopped');
    }

    restart() {
        this.shouldRestart = true;
        this.stop().then(() => {
            setTimeout(() => this.start(this.pool, this.wallet), 1000);
        });
    }

    async overclockSettings(coreOffset, memoryOffset) {
        const commands = [
            ['nvidia-settings', '-a', `[gpu:${this.config.gpuId}]/GPUGraphicsClockOffset[3]=${coreOffset}`],
            ['nvidia-settings', '-a', `[gpu:${this.config.gpuId}]/GPUMemoryTransferRateOffset[3]=${memoryOffset}`]
        ];
        
        for (const cmd of commands) {
            await new Promise((resolve) => {
                const proc = spawn(cmd[0], cmd.slice(1));
                proc.on('exit', resolve);
            });
        }
        
        this.emit('overclocked', { core: coreOffset, memory: memoryOffset });
    }

    getStats() {
        return {
            ...this.stats,
            hashrate: this.hashrate,
            uptime: this.isRunning ? process.uptime() : 0,
            config: { ...this.config }
        };
    }
}

module.exports = GPUCUDAMiner;