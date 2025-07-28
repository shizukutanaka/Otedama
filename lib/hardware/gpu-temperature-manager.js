const { EventEmitter } = require('events');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

class GPUTemperatureManager extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            pollingInterval: options.pollingInterval || 1000,
            criticalTemp: options.criticalTemp || 90,
            warningTemp: options.warningTemp || 85,
            targetTemp: options.targetTemp || 70,
            minFanSpeed: options.minFanSpeed || 30,
            maxFanSpeed: options.maxFanSpeed || 100,
            fanCurve: options.fanCurve || this.getDefaultFanCurve(),
            adaptiveCooling: options.adaptiveCooling !== false,
            emergencyShutdown: options.emergencyShutdown !== false,
            throttleTemp: options.throttleTemp || 87,
            resumeTemp: options.resumeTemp || 75,
            ...options
        };
        
        this.gpus = new Map();
        this.history = new Map();
        this.isMonitoring = false;
        this.platform = os.platform();
        this.lastThrottleTime = new Map();
        this.coolingProfiles = this.initializeCoolingProfiles();
        this.currentProfile = 'balanced';
        
        // Performance metrics
        this.metrics = {
            throttleEvents: 0,
            emergencyShutdowns: 0,
            avgTemperature: 0,
            peakTemperature: 0,
            totalUptime: 0
        };
    }

    getDefaultFanCurve() {
        return [
            { temp: 0, fan: 30 },
            { temp: 50, fan: 30 },
            { temp: 60, fan: 40 },
            { temp: 70, fan: 60 },
            { temp: 80, fan: 80 },
            { temp: 85, fan: 90 },
            { temp: 90, fan: 100 }
        ];
    }

    initializeCoolingProfiles() {
        return {
            silent: {
                fanCurve: [
                    { temp: 0, fan: 20 },
                    { temp: 60, fan: 25 },
                    { temp: 70, fan: 35 },
                    { temp: 80, fan: 50 },
                    { temp: 85, fan: 70 },
                    { temp: 90, fan: 100 }
                ],
                targetTemp: 75,
                throttleTemp: 90
            },
            balanced: {
                fanCurve: this.getDefaultFanCurve(),
                targetTemp: 70,
                throttleTemp: 87
            },
            performance: {
                fanCurve: [
                    { temp: 0, fan: 40 },
                    { temp: 50, fan: 45 },
                    { temp: 60, fan: 60 },
                    { temp: 70, fan: 75 },
                    { temp: 75, fan: 85 },
                    { temp: 80, fan: 95 },
                    { temp: 85, fan: 100 }
                ],
                targetTemp: 65,
                throttleTemp: 85
            },
            aggressive: {
                fanCurve: [
                    { temp: 0, fan: 50 },
                    { temp: 50, fan: 60 },
                    { temp: 60, fan: 75 },
                    { temp: 65, fan: 85 },
                    { temp: 70, fan: 95 },
                    { temp: 75, fan: 100 }
                ],
                targetTemp: 60,
                throttleTemp: 80
            }
        };
    }

    async startMonitoring() {
        if (this.isMonitoring) return;
        
        this.isMonitoring = true;
        this.emit('monitoring:started');
        
        // Initialize GPU detection
        await this.detectGPUs();
        
        // Start monitoring loop
        this.monitoringLoop();
    }

    async stopMonitoring() {
        this.isMonitoring = false;
        this.emit('monitoring:stopped');
    }

    async monitoringLoop() {
        while (this.isMonitoring) {
            try {
                await this.updateTemperatures();
                await this.adjustFanSpeeds();
                this.checkThresholds();
                this.updateMetrics();
                
                await this.sleep(this.config.pollingInterval);
            } catch (error) {
                this.emit('error', error);
            }
        }
    }

    async detectGPUs() {
        try {
            if (this.platform === 'win32') {
                await this.detectNvidiaGPUs();
                await this.detectAMDGPUs();
            } else if (this.platform === 'linux') {
                await this.detectLinuxGPUs();
            }
            
            this.emit('gpus:detected', Array.from(this.gpus.values()));
        } catch (error) {
            this.emit('error', { message: 'GPU detection failed', error });
        }
    }

    async detectNvidiaGPUs() {
        try {
            const { stdout } = await execAsync('nvidia-smi --query-gpu=index,name,temperature.gpu,fan.speed,power.draw,memory.used,memory.total --format=csv,noheader,nounits');
            const lines = stdout.trim().split('\n');
            
            for (const line of lines) {
                const [index, name, temp, fanSpeed, power, memUsed, memTotal] = line.split(', ');
                const gpu = {
                    index: parseInt(index),
                    name: name.trim(),
                    vendor: 'nvidia',
                    temperature: parseFloat(temp),
                    fanSpeed: parseFloat(fanSpeed),
                    powerDraw: parseFloat(power),
                    memoryUsed: parseFloat(memUsed),
                    memoryTotal: parseFloat(memTotal),
                    isThrottling: false
                };
                
                this.gpus.set(`nvidia-${index}`, gpu);
                this.initializeHistory(`nvidia-${index}`);
            }
        } catch (error) {
            // NVIDIA GPUs not available or nvidia-smi not installed
        }
    }

    async detectAMDGPUs() {
        try {
            // AMD GPU detection using rocm-smi or amdgpu commands
            const { stdout } = await execAsync('rocm-smi --showtemp --showfan');
            // Parse AMD GPU information
            // Implementation depends on AMD tools available
        } catch (error) {
            // AMD GPUs not available
        }
    }

    async detectLinuxGPUs() {
        try {
            // Try NVIDIA first
            await this.detectNvidiaGPUs();
            
            // Try AMD
            await this.detectAMDGPUs();
            
            // Fallback to hwmon
            const { stdout } = await execAsync('ls /sys/class/hwmon/');
            const devices = stdout.trim().split('\n');
            
            for (const device of devices) {
                try {
                    const name = await this.readFile(`/sys/class/hwmon/${device}/name`);
                    if (name.includes('gpu') || name.includes('amdgpu')) {
                        // Read temperature and fan data from hwmon
                        const temp = await this.readFile(`/sys/class/hwmon/${device}/temp1_input`);
                        const fanSpeed = await this.readFile(`/sys/class/hwmon/${device}/pwm1`);
                        
                        const gpu = {
                            index: this.gpus.size,
                            name: name.trim(),
                            vendor: 'generic',
                            temperature: parseInt(temp) / 1000,
                            fanSpeed: (parseInt(fanSpeed) / 255) * 100,
                            isThrottling: false
                        };
                        
                        this.gpus.set(`generic-${device}`, gpu);
                        this.initializeHistory(`generic-${device}`);
                    }
                } catch (error) {
                    // Skip non-GPU devices
                }
            }
        } catch (error) {
            this.emit('error', { message: 'Linux GPU detection failed', error });
        }
    }

    initializeHistory(gpuId) {
        this.history.set(gpuId, {
            temperatures: [],
            fanSpeeds: [],
            throttleEvents: [],
            maxTemp: 0,
            avgTemp: 0
        });
    }

    async updateTemperatures() {
        for (const [id, gpu] of this.gpus) {
            try {
                const newTemp = await this.readGPUTemperature(gpu);
                gpu.temperature = newTemp;
                
                // Update history
                const hist = this.history.get(id);
                hist.temperatures.push({ time: Date.now(), value: newTemp });
                
                // Keep only last hour of data
                const oneHourAgo = Date.now() - 3600000;
                hist.temperatures = hist.temperatures.filter(t => t.time > oneHourAgo);
                
                // Update statistics
                hist.maxTemp = Math.max(hist.maxTemp, newTemp);
                hist.avgTemp = hist.temperatures.reduce((sum, t) => sum + t.value, 0) / hist.temperatures.length;
                
                this.emit('temperature:updated', { gpuId: id, temperature: newTemp });
            } catch (error) {
                this.emit('error', { message: `Failed to read temperature for GPU ${id}`, error });
            }
        }
    }

    async readGPUTemperature(gpu) {
        if (gpu.vendor === 'nvidia') {
            const { stdout } = await execAsync(`nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits -i ${gpu.index}`);
            return parseFloat(stdout.trim());
        } else if (gpu.vendor === 'amd') {
            // AMD specific temperature reading
            return gpu.temperature; // Placeholder
        } else {
            // Generic temperature reading from hwmon
            return gpu.temperature; // Placeholder
        }
    }

    async adjustFanSpeeds() {
        if (!this.config.adaptiveCooling) return;
        
        for (const [id, gpu] of this.gpus) {
            try {
                const targetFanSpeed = this.calculateFanSpeed(gpu.temperature);
                
                // Apply hysteresis to prevent fan oscillation
                const currentFan = gpu.fanSpeed || 0;
                const fanDiff = Math.abs(targetFanSpeed - currentFan);
                
                if (fanDiff > 5 || gpu.temperature > this.config.warningTemp) {
                    await this.setGPUFanSpeed(gpu, targetFanSpeed);
                    gpu.fanSpeed = targetFanSpeed;
                    
                    // Update history
                    const hist = this.history.get(id);
                    hist.fanSpeeds.push({ time: Date.now(), value: targetFanSpeed });
                    
                    this.emit('fan:adjusted', { gpuId: id, fanSpeed: targetFanSpeed });
                }
            } catch (error) {
                this.emit('error', { message: `Failed to adjust fan speed for GPU ${id}`, error });
            }
        }
    }

    calculateFanSpeed(temperature) {
        const profile = this.coolingProfiles[this.currentProfile];
        const curve = profile.fanCurve || this.config.fanCurve;
        
        // Find the appropriate fan speed from curve
        for (let i = 0; i < curve.length - 1; i++) {
            if (temperature >= curve[i].temp && temperature <= curve[i + 1].temp) {
                // Linear interpolation
                const tempRange = curve[i + 1].temp - curve[i].temp;
                const fanRange = curve[i + 1].fan - curve[i].fan;
                const tempOffset = temperature - curve[i].temp;
                const fanSpeed = curve[i].fan + (tempOffset / tempRange) * fanRange;
                
                return Math.max(this.config.minFanSpeed, Math.min(this.config.maxFanSpeed, Math.round(fanSpeed)));
            }
        }
        
        // If temperature exceeds curve, use max fan speed
        return this.config.maxFanSpeed;
    }

    async setGPUFanSpeed(gpu, speed) {
        if (gpu.vendor === 'nvidia') {
            await execAsync(`nvidia-settings -a "[gpu:${gpu.index}]/GPUFanControlState=1"`);
            await execAsync(`nvidia-settings -a "[fan:${gpu.index}]/GPUTargetFanSpeed=${speed}"`);
        } else if (gpu.vendor === 'amd') {
            // AMD fan control implementation
        }
    }

    checkThresholds() {
        for (const [id, gpu] of this.gpus) {
            // Critical temperature check
            if (gpu.temperature >= this.config.criticalTemp) {
                this.handleCriticalTemperature(id, gpu);
            }
            // Throttle check
            else if (gpu.temperature >= this.config.throttleTemp) {
                this.handleThrottleTemperature(id, gpu);
            }
            // Resume check
            else if (gpu.isThrottling && gpu.temperature <= this.config.resumeTemp) {
                this.resumeNormalOperation(id, gpu);
            }
            // Warning check
            else if (gpu.temperature >= this.config.warningTemp) {
                this.emit('temperature:warning', { gpuId: id, temperature: gpu.temperature });
            }
        }
    }

    handleCriticalTemperature(gpuId, gpu) {
        this.emit('temperature:critical', { gpuId, temperature: gpu.temperature });
        
        if (this.config.emergencyShutdown) {
            this.metrics.emergencyShutdowns++;
            this.emit('gpu:emergency-shutdown', { gpuId, temperature: gpu.temperature });
            
            // Implement emergency shutdown logic
            // This would typically involve stopping mining on this GPU
        }
    }

    handleThrottleTemperature(gpuId, gpu) {
        if (!gpu.isThrottling) {
            gpu.isThrottling = true;
            this.lastThrottleTime.set(gpuId, Date.now());
            this.metrics.throttleEvents++;
            
            const hist = this.history.get(gpuId);
            hist.throttleEvents.push({ time: Date.now(), temperature: gpu.temperature });
            
            this.emit('gpu:throttled', { gpuId, temperature: gpu.temperature });
        }
    }

    resumeNormalOperation(gpuId, gpu) {
        if (gpu.isThrottling) {
            gpu.isThrottling = false;
            const throttleDuration = Date.now() - this.lastThrottleTime.get(gpuId);
            
            this.emit('gpu:resumed', { gpuId, temperature: gpu.temperature, throttleDuration });
        }
    }

    updateMetrics() {
        let totalTemp = 0;
        let gpuCount = 0;
        
        for (const gpu of this.gpus.values()) {
            totalTemp += gpu.temperature;
            gpuCount++;
            this.metrics.peakTemperature = Math.max(this.metrics.peakTemperature, gpu.temperature);
        }
        
        if (gpuCount > 0) {
            this.metrics.avgTemperature = totalTemp / gpuCount;
        }
        
        this.emit('metrics:updated', this.metrics);
    }

    setCoolingProfile(profileName) {
        if (this.coolingProfiles[profileName]) {
            this.currentProfile = profileName;
            const profile = this.coolingProfiles[profileName];
            
            this.config.fanCurve = profile.fanCurve;
            this.config.targetTemp = profile.targetTemp;
            this.config.throttleTemp = profile.throttleTemp;
            
            this.emit('profile:changed', { profile: profileName });
        }
    }

    async optimizeForWorkload(workloadType) {
        switch (workloadType) {
            case 'mining':
                this.setCoolingProfile('balanced');
                break;
            case 'compute':
                this.setCoolingProfile('performance');
                break;
            case 'idle':
                this.setCoolingProfile('silent');
                break;
            case 'overclock':
                this.setCoolingProfile('aggressive');
                break;
        }
    }

    getGPUStatus() {
        const status = [];
        
        for (const [id, gpu] of this.gpus) {
            const hist = this.history.get(id);
            status.push({
                id,
                name: gpu.name,
                temperature: gpu.temperature,
                fanSpeed: gpu.fanSpeed,
                isThrottling: gpu.isThrottling,
                avgTemperature: hist.avgTemp,
                maxTemperature: hist.maxTemp,
                throttleEvents: hist.throttleEvents.length
            });
        }
        
        return status;
    }

    async readFile(path) {
        const fs = require('fs').promises;
        const content = await fs.readFile(path, 'utf8');
        return content.trim();
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = GPUTemperatureManager;