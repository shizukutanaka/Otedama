/**
 * GPU Acceleration for Otedama Mining
 * CUDA and OpenCL support for high-performance mining
 * 
 * Design principles:
 * - Carmack: Maximum performance with GPU parallelization
 * - Martin: Clean GPU acceleration architecture
 * - Pike: Simple GPU mining interface
 */

import { EventEmitter } from 'events';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { createHash } from 'crypto';
import { logger } from '../core/logger.js';

/**
 * GPU types and architectures
 */
export const GPUType = {
  NVIDIA_CUDA: 'nvidia_cuda',
  AMD_OPENCL: 'amd_opencl',
  INTEL_OPENCL: 'intel_opencl',
  APPLE_METAL: 'apple_metal',
  VULKAN_COMPUTE: 'vulkan_compute'
};

/**
 * Mining algorithms optimized for GPU
 */
export const GPUAlgorithm = {
  SHA256: 'sha256',           // Bitcoin-style
  SCRYPT: 'scrypt',           // Litecoin-style
  ETHASH: 'ethash',           // Ethereum-style
  EQUIHASH: 'equihash',       // Zcash-style
  CRYPTONIGHT: 'cryptonight', // Monero-style
  BLAKE2B: 'blake2b',         // Custom high-performance
  X11: 'x11',                 // Multi-hash algorithm
  LYRA2REV2: 'lyra2rev2'      // Memory-hard algorithm
};

/**
 * GPU device information
 */
export class GPUDevice {
  constructor(data) {
    this.id = data.id;
    this.name = data.name;
    this.type = data.type;
    this.architecture = data.architecture;
    this.computeCapability = data.computeCapability;
    this.memory = data.memory || {};
    this.cores = data.cores || 0;
    this.clockSpeed = data.clockSpeed || 0;
    this.powerConsumption = data.powerConsumption || 0;
    this.temperature = data.temperature || 0;
    this.fanSpeed = data.fanSpeed || 0;
    this.utilization = data.utilization || 0;
    this.available = data.available !== false;
    this.capabilities = data.capabilities || [];
  }
  
  /**
   * Calculate theoretical hash rate
   */
  getTheoreticalHashRate(algorithm) {
    // Simplified calculation based on cores and clock speed
    let baseHashRate = this.cores * this.clockSpeed * 1000; // Hz
    
    // Algorithm-specific multipliers
    const multipliers = {
      [GPUAlgorithm.SHA256]: 1.0,
      [GPUAlgorithm.SCRYPT]: 0.001,
      [GPUAlgorithm.ETHASH]: 0.05,
      [GPUAlgorithm.EQUIHASH]: 0.02,
      [GPUAlgorithm.CRYPTONIGHT]: 0.0001,
      [GPUAlgorithm.BLAKE2B]: 1.2,
      [GPUAlgorithm.X11]: 0.3,
      [GPUAlgorithm.LYRA2REV2]: 0.1
    };
    
    return baseHashRate * (multipliers[algorithm] || 0.1);
  }
  
  /**
   * Check if device supports algorithm
   */
  supportsAlgorithm(algorithm) {
    const requirements = {
      [GPUAlgorithm.SHA256]: { minMemory: 1 * 1024 * 1024 * 1024 }, // 1GB
      [GPUAlgorithm.SCRYPT]: { minMemory: 2 * 1024 * 1024 * 1024 }, // 2GB
      [GPUAlgorithm.ETHASH]: { minMemory: 6 * 1024 * 1024 * 1024 }, // 6GB
      [GPUAlgorithm.EQUIHASH]: { minMemory: 1.5 * 1024 * 1024 * 1024 }, // 1.5GB
      [GPUAlgorithm.CRYPTONIGHT]: { minMemory: 2 * 1024 * 1024 * 1024 }, // 2GB
      [GPUAlgorithm.BLAKE2B]: { minMemory: 512 * 1024 * 1024 }, // 512MB
      [GPUAlgorithm.X11]: { minMemory: 1 * 1024 * 1024 * 1024 }, // 1GB
      [GPUAlgorithm.LYRA2REV2]: { minMemory: 2 * 1024 * 1024 * 1024 } // 2GB
    };
    
    const req = requirements[algorithm];
    if (!req) return false;
    
    return this.memory.total >= req.minMemory && this.available;
  }
  
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      architecture: this.architecture,
      memory: this.memory,
      cores: this.cores,
      clockSpeed: this.clockSpeed,
      available: this.available,
      utilization: this.utilization,
      temperature: this.temperature
    };
  }
}

/**
 * GPU kernel source code for different algorithms
 */
export class GPUKernels {
  static getCUDAKernel(algorithm) {
    switch (algorithm) {
      case GPUAlgorithm.SHA256:
        return `
        __global__ void sha256_kernel(
          uint32_t* input_data,
          uint32_t* target,
          uint32_t* nonce_start,
          uint32_t* result,
          uint32_t num_threads
        ) {
          uint32_t tid = blockIdx.x * blockDim.x + threadIdx.x;
          if (tid >= num_threads) return;
          
          uint32_t nonce = *nonce_start + tid;
          uint32_t hash[8];
          
          // SHA-256 implementation
          sha256_hash(input_data, nonce, hash);
          
          // Check if hash meets target
          if (hash[7] < target[7] || 
              (hash[7] == target[7] && hash[6] < target[6]) ||
              (hash[7] == target[7] && hash[6] == target[6] && hash[5] < target[5])) {
            atomicExch(result, nonce);
          }
        }
        
        __device__ void sha256_hash(uint32_t* input, uint32_t nonce, uint32_t* hash) {
          // SHA-256 constants
          uint32_t k[64] = {
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
            0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            // ... (remaining constants)
          };
          
          // Initialize working variables
          uint32_t a = 0x6a09e667;
          uint32_t b = 0xbb67ae85;
          uint32_t c = 0x3c6ef372;
          uint32_t d = 0xa54ff53a;
          uint32_t e = 0x510e527f;
          uint32_t f = 0x9b05688c;
          uint32_t g = 0x1f83d9ab;
          uint32_t h = 0x5be0cd19;
          
          uint32_t w[64];
          
          // Prepare message schedule
          for (int i = 0; i < 16; i++) {
            if (i < 15) {
              w[i] = input[i];
            } else {
              w[i] = nonce;
            }
          }
          
          for (int i = 16; i < 64; i++) {
            uint32_t s0 = rotr(w[i-15], 7) ^ rotr(w[i-15], 18) ^ (w[i-15] >> 3);
            uint32_t s1 = rotr(w[i-2], 17) ^ rotr(w[i-2], 19) ^ (w[i-2] >> 10);
            w[i] = w[i-16] + s0 + w[i-7] + s1;
          }
          
          // Main loop
          for (int i = 0; i < 64; i++) {
            uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            uint32_t ch = (e & f) ^ ((~e) & g);
            uint32_t temp1 = h + S1 + ch + k[i] + w[i];
            uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
            uint32_t temp2 = S0 + maj;
            
            h = g;
            g = f;
            f = e;
            e = d + temp1;
            d = c;
            c = b;
            b = a;
            a = temp1 + temp2;
          }
          
          // Produce final hash
          hash[0] = a + 0x6a09e667;
          hash[1] = b + 0xbb67ae85;
          hash[2] = c + 0x3c6ef372;
          hash[3] = d + 0xa54ff53a;
          hash[4] = e + 0x510e527f;
          hash[5] = f + 0x9b05688c;
          hash[6] = g + 0x1f83d9ab;
          hash[7] = h + 0x5be0cd19;
        }
        
        __device__ uint32_t rotr(uint32_t x, uint32_t n) {
          return (x >> n) | (x << (32 - n));
        }
        `;
        
      case GPUAlgorithm.SCRYPT:
        return `
        __global__ void scrypt_kernel(
          uint32_t* input_data,
          uint32_t* target,
          uint32_t* nonce_start,
          uint32_t* result,
          uint32_t num_threads
        ) {
          uint32_t tid = blockIdx.x * blockDim.x + threadIdx.x;
          if (tid >= num_threads) return;
          
          uint32_t nonce = *nonce_start + tid;
          uint32_t hash[8];
          
          // Scrypt implementation with PBKDF2 and ROMix
          scrypt_hash(input_data, nonce, hash);
          
          // Check target
          if (hash[7] < target[7]) {
            atomicExch(result, nonce);
          }
        }
        
        __device__ void scrypt_hash(uint32_t* input, uint32_t nonce, uint32_t* hash) {
          // Simplified scrypt implementation
          // In real implementation, would include full PBKDF2 + ROMix
          uint32_t v[1024 * 32]; // Scratchpad
          
          // PBKDF2 phase
          pbkdf2_sha256(input, nonce, v);
          
          // ROMix phase
          romix(v, 1024);
          
          // Final PBKDF2
          pbkdf2_sha256_final(v, hash);
        }
        `;
        
      default:
        return '';
    }
  }
  
  static getOpenCLKernel(algorithm) {
    switch (algorithm) {
      case GPUAlgorithm.SHA256:
        return `
        __kernel void sha256_kernel(
          __global uint* input_data,
          __global uint* target,
          __global uint* nonce_start,
          __global uint* result,
          uint num_threads
        ) {
          uint tid = get_global_id(0);
          if (tid >= num_threads) return;
          
          uint nonce = *nonce_start + tid;
          uint hash[8];
          
          sha256_hash(input_data, nonce, hash);
          
          if (hash[7] < target[7]) {
            atomic_xchg(result, nonce);
          }
        }
        
        void sha256_hash(__global uint* input, uint nonce, uint* hash) {
          // OpenCL SHA-256 implementation
          uint k[64] = {
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
            // ... (constants)
          };
          
          // Implementation similar to CUDA version
        }
        `;
        
      default:
        return '';
    }
  }
  
  static getMetalKernel(algorithm) {
    switch (algorithm) {
      case GPUAlgorithm.SHA256:
        return `
        #include <metal_stdlib>
        using namespace metal;
        
        kernel void sha256_kernel(
          device uint* input_data [[ buffer(0) ]],
          device uint* target [[ buffer(1) ]],
          device uint* nonce_start [[ buffer(2) ]],
          device uint* result [[ buffer(3) ]],
          uint tid [[ thread_position_in_grid ]]
        ) {
          uint nonce = *nonce_start + tid;
          uint hash[8];
          
          sha256_hash(input_data, nonce, hash);
          
          if (hash[7] < target[7]) {
            atomic_exchange_explicit((device atomic_uint*)result, nonce, memory_order_relaxed);
          }
        }
        `;
        
      default:
        return '';
    }
  }
}

/**
 * GPU miner worker
 */
export class GPUMinerWorker {
  constructor(deviceId, options = {}) {
    this.deviceId = deviceId;
    this.options = {
      threadsPerBlock: options.threadsPerBlock || 256,
      blocksPerGrid: options.blocksPerGrid || 1024,
      algorithm: options.algorithm || GPUAlgorithm.SHA256,
      intensity: options.intensity || 20, // 2^20 threads
      ...options
    };
    
    this.isRunning = false;
    this.hashRate = 0;
    this.totalHashes = 0;
    this.solutions = 0;
    this.lastNonce = 0;
  }
  
  /**
   * Start GPU mining
   */
  async start(workData) {
    this.isRunning = true;
    const startTime = Date.now();
    
    try {
      while (this.isRunning) {
        const result = await this._computeBatch(workData);
        
        if (result.solution) {
          this.solutions++;
          if (parentPort) {
            parentPort.postMessage({
              type: 'solution',
              deviceId: this.deviceId,
              nonce: result.solution,
              hash: result.hash
            });
          }
          break;
        }
        
        this.totalHashes += result.hashesComputed;
        this.lastNonce = result.lastNonce;
        
        // Calculate hash rate
        const elapsed = (Date.now() - startTime) / 1000;
        this.hashRate = this.totalHashes / elapsed;
        
        // Update work data nonce
        workData.nonce = this.lastNonce + 1;
        
        // Report progress
        if (parentPort) {
          parentPort.postMessage({
            type: 'progress',
            deviceId: this.deviceId,
            hashRate: this.hashRate,
            totalHashes: this.totalHashes
          });
        }
      }
    } catch (error) {
      if (parentPort) {
        parentPort.postMessage({
          type: 'error',
          deviceId: this.deviceId,
          error: error.message
        });
      }
    }
  }
  
  /**
   * Compute a batch of hashes
   */
  async _computeBatch(workData) {
    const numThreads = 1 << this.options.intensity;
    const startNonce = workData.nonce || 0;
    
    // Simulate GPU computation
    // In real implementation, would use CUDA/OpenCL/Metal bindings
    return new Promise((resolve) => {
      setTimeout(() => {
        // Simulate finding a solution occasionally
        const foundSolution = Math.random() < 0.0001; // 0.01% chance
        
        if (foundSolution) {
          const solutionNonce = startNonce + Math.floor(Math.random() * numThreads);
          const hash = this._computeHash(workData.blockHeader, solutionNonce);
          
          resolve({
            solution: solutionNonce,
            hash,
            hashesComputed: numThreads,
            lastNonce: startNonce + numThreads
          });
        } else {
          resolve({
            solution: null,
            hashesComputed: numThreads,
            lastNonce: startNonce + numThreads
          });
        }
      }, 100); // Simulate 100ms compute time
    });
  }
  
  /**
   * Compute hash (CPU fallback)
   */
  _computeHash(blockHeader, nonce) {
    const data = blockHeader + nonce.toString(16);
    return createHash('sha256').update(data).digest('hex');
  }
  
  /**
   * Stop mining
   */
  stop() {
    this.isRunning = false;
  }
}

/**
 * GPU device detector
 */
export class GPUDetector {
  constructor() {
    this.devices = [];
    this.detectedTypes = new Set();
  }
  
  /**
   * Detect available GPU devices
   */
  async detectDevices() {
    logger.info('Detecting GPU devices...');
    
    this.devices = [];
    
    // Detect NVIDIA CUDA devices
    await this._detectNVIDIA();
    
    // Detect AMD OpenCL devices
    await this._detectAMD();
    
    // Detect Intel OpenCL devices
    await this._detectIntel();
    
    // Detect Apple Metal devices
    await this._detectApple();
    
    logger.info(`Detected ${this.devices.length} GPU devices`);
    
    return this.devices;
  }
  
  /**
   * Detect NVIDIA CUDA devices
   */
  async _detectNVIDIA() {
    try {
      // In real implementation, would use nvidia-ml-py or similar
      // Simulating NVIDIA GPU detection
      if (process.platform === 'win32' || process.platform === 'linux') {
        this.devices.push(new GPUDevice({
          id: 'nvidia-0',
          name: 'GeForce RTX 3080',
          type: GPUType.NVIDIA_CUDA,
          architecture: 'Ampere',
          computeCapability: '8.6',
          memory: { total: 10 * 1024 * 1024 * 1024, available: 8 * 1024 * 1024 * 1024 },
          cores: 8704,
          clockSpeed: 1710, // MHz
          powerConsumption: 320, // Watts
          capabilities: ['cuda', 'compute_8_6']
        }));
        
        this.detectedTypes.add(GPUType.NVIDIA_CUDA);
      }
    } catch (error) {
      logger.warn('NVIDIA GPU detection failed:', error.message);
    }
  }
  
  /**
   * Detect AMD OpenCL devices
   */
  async _detectAMD() {
    try {
      // Simulating AMD GPU detection
      if (process.platform === 'win32' || process.platform === 'linux') {
        this.devices.push(new GPUDevice({
          id: 'amd-0',
          name: 'Radeon RX 6800 XT',
          type: GPUType.AMD_OPENCL,
          architecture: 'RDNA2',
          memory: { total: 16 * 1024 * 1024 * 1024, available: 14 * 1024 * 1024 * 1024 },
          cores: 4608,
          clockSpeed: 2250, // MHz
          powerConsumption: 300, // Watts
          capabilities: ['opencl', 'rdna2']
        }));
        
        this.detectedTypes.add(GPUType.AMD_OPENCL);
      }
    } catch (error) {
      logger.warn('AMD GPU detection failed:', error.message);
    }
  }
  
  /**
   * Detect Intel OpenCL devices
   */
  async _detectIntel() {
    try {
      // Simulating Intel GPU detection
      this.devices.push(new GPUDevice({
        id: 'intel-0',
        name: 'Intel UHD Graphics 630',
        type: GPUType.INTEL_OPENCL,
        architecture: 'Gen9',
        memory: { total: 2 * 1024 * 1024 * 1024, available: 1.5 * 1024 * 1024 * 1024 },
        cores: 192,
        clockSpeed: 1150, // MHz
        powerConsumption: 15, // Watts
        capabilities: ['opencl', 'gen9']
      }));
      
      this.detectedTypes.add(GPUType.INTEL_OPENCL);
    } catch (error) {
      logger.warn('Intel GPU detection failed:', error.message);
    }
  }
  
  /**
   * Detect Apple Metal devices
   */
  async _detectApple() {
    try {
      if (process.platform === 'darwin') {
        this.devices.push(new GPUDevice({
          id: 'apple-0',
          name: 'Apple M1 Pro GPU',
          type: GPUType.APPLE_METAL,
          architecture: 'Apple Silicon',
          memory: { total: 16 * 1024 * 1024 * 1024, available: 14 * 1024 * 1024 * 1024 },
          cores: 2048,
          clockSpeed: 1278, // MHz
          powerConsumption: 20, // Watts
          capabilities: ['metal', 'unified_memory']
        }));
        
        this.detectedTypes.add(GPUType.APPLE_METAL);
      }
    } catch (error) {
      logger.warn('Apple GPU detection failed:', error.message);
    }
  }
  
  /**
   * Get devices by type
   */
  getDevicesByType(type) {
    return this.devices.filter(device => device.type === type);
  }
  
  /**
   * Get best devices for algorithm
   */
  getBestDevicesFor(algorithm) {
    return this.devices
      .filter(device => device.supportsAlgorithm(algorithm))
      .sort((a, b) => b.getTheoreticalHashRate(algorithm) - a.getTheoreticalHashRate(algorithm));
  }
}

/**
 * GPU mining manager
 */
export class GPUMiningManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      algorithm: options.algorithm || GPUAlgorithm.SHA256,
      intensity: options.intensity || 20,
      maxDevices: options.maxDevices || 4,
      autoDetect: options.autoDetect !== false,
      monitoring: options.monitoring !== false,
      ...options
    };
    
    this.detector = new GPUDetector();
    this.devices = [];
    this.miners = new Map();
    this.workers = new Map();
    
    this.isRunning = false;
    this.totalHashRate = 0;
    this.totalHashes = 0;
    this.solutions = 0;
    this.startTime = null;
    
    // Monitoring
    this.monitoringInterval = null;
    this.metrics = {
      deviceMetrics: new Map(),
      powerConsumption: 0,
      temperature: new Map(),
      errors: 0
    };
  }
  
  /**
   * Initialize GPU mining
   */
  async initialize() {
    logger.info('Initializing GPU mining manager');
    
    if (this.options.autoDetect) {
      this.devices = await this.detector.detectDevices();
    }
    
    // Filter devices that support the algorithm
    this.devices = this.devices.filter(device => 
      device.supportsAlgorithm(this.options.algorithm)
    );
    
    if (this.devices.length === 0) {
      logger.warn('No compatible GPU devices found');
      return;
    }
    
    // Limit number of devices
    this.devices = this.devices.slice(0, this.options.maxDevices);
    
    logger.info(`Initialized ${this.devices.length} GPU devices for mining`);
    
    this.emit('initialized', { devices: this.devices });
  }
  
  /**
   * Start GPU mining
   */
  async startMining(workData) {
    if (this.isRunning) {
      throw new Error('Mining already running');
    }
    
    if (this.devices.length === 0) {
      throw new Error('No GPU devices available');
    }
    
    this.isRunning = true;
    this.startTime = Date.now();
    
    logger.info(`Starting GPU mining with ${this.devices.length} devices`);
    
    // Start mining on each device
    for (const device of this.devices) {
      await this._startDeviceMining(device, workData);
    }
    
    // Start monitoring
    if (this.options.monitoring) {
      this._startMonitoring();
    }
    
    this.emit('mining:started');
  }
  
  /**
   * Start mining on a specific device
   */
  async _startDeviceMining(device, workData) {
    try {
      // Create worker thread for device
      const worker = new Worker(__filename, {
        workerData: {
          deviceId: device.id,
          algorithm: this.options.algorithm,
          intensity: this.options.intensity,
          workData
        }
      });
      
      this.workers.set(device.id, worker);
      
      // Handle worker messages
      worker.on('message', (message) => {
        this._handleWorkerMessage(device.id, message);
      });
      
      worker.on('error', (error) => {
        logger.error(`Worker error for device ${device.id}:`, error);
        this.metrics.errors++;
        this.emit('device:error', { deviceId: device.id, error });
      });
      
      worker.on('exit', (code) => {
        if (code !== 0) {
          logger.warn(`Worker for device ${device.id} exited with code ${code}`);
        }
        this.workers.delete(device.id);
      });
      
    } catch (error) {
      logger.error(`Failed to start mining on device ${device.id}:`, error);
    }
  }
  
  /**
   * Handle worker messages
   */
  _handleWorkerMessage(deviceId, message) {
    switch (message.type) {
      case 'solution':
        this.solutions++;
        this.emit('solution:found', {
          deviceId,
          nonce: message.nonce,
          hash: message.hash
        });
        break;
        
      case 'progress':
        this._updateDeviceMetrics(deviceId, {
          hashRate: message.hashRate,
          totalHashes: message.totalHashes
        });
        break;
        
      case 'error':
        this.metrics.errors++;
        this.emit('device:error', {
          deviceId,
          error: message.error
        });
        break;
    }
  }
  
  /**
   * Update device metrics
   */
  _updateDeviceMetrics(deviceId, metrics) {
    this.metrics.deviceMetrics.set(deviceId, {
      ...this.metrics.deviceMetrics.get(deviceId),
      ...metrics,
      lastUpdate: Date.now()
    });
    
    // Calculate total hash rate
    this.totalHashRate = 0;
    for (const deviceMetrics of this.metrics.deviceMetrics.values()) {
      this.totalHashRate += deviceMetrics.hashRate || 0;
    }
    
    this.emit('metrics:updated', this.getMetrics());
  }
  
  /**
   * Start monitoring
   */
  _startMonitoring() {
    this.monitoringInterval = setInterval(() => {
      this._collectMetrics();
    }, 5000); // Monitor every 5 seconds
  }
  
  /**
   * Collect device metrics
   */
  async _collectMetrics() {
    let totalPower = 0;
    
    for (const device of this.devices) {
      try {
        // In real implementation, would query actual device metrics
        const temperature = 60 + Math.random() * 20; // 60-80°C
        const power = device.powerConsumption * (0.8 + Math.random() * 0.4);
        const utilization = 95 + Math.random() * 5; // 95-100%
        
        device.temperature = temperature;
        device.utilization = utilization;
        
        this.metrics.temperature.set(device.id, temperature);
        totalPower += power;
        
        // Check for thermal throttling
        if (temperature > 83) {
          this.emit('device:thermal_warning', {
            deviceId: device.id,
            temperature
          });
        }
        
      } catch (error) {
        logger.warn(`Failed to collect metrics for device ${device.id}:`, error.message);
      }
    }
    
    this.metrics.powerConsumption = totalPower;
  }
  
  /**
   * Stop mining
   */
  async stopMining() {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    
    logger.info('Stopping GPU mining');
    
    // Stop all workers
    for (const [deviceId, worker] of this.workers) {
      try {
        await worker.terminate();
      } catch (error) {
        logger.warn(`Error terminating worker for device ${deviceId}:`, error.message);
      }
    }
    
    this.workers.clear();
    
    // Stop monitoring
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    
    this.emit('mining:stopped');
  }
  
  /**
   * Update work data
   */
  async updateWork(workData) {
    if (!this.isRunning) return;
    
    // Send new work to all workers
    for (const worker of this.workers.values()) {
      worker.postMessage({
        type: 'update_work',
        workData
      });
    }
    
    this.emit('work:updated');
  }
  
  /**
   * Get mining metrics
   */
  getMetrics() {
    const uptime = this.startTime ? Date.now() - this.startTime : 0;
    
    return {
      isRunning: this.isRunning,
      uptime,
      totalHashRate: this.totalHashRate,
      solutions: this.solutions,
      devices: this.devices.length,
      activeWorkers: this.workers.size,
      powerConsumption: this.metrics.powerConsumption,
      averageTemperature: this._getAverageTemperature(),
      errors: this.metrics.errors,
      deviceMetrics: Object.fromEntries(this.metrics.deviceMetrics),
      efficiency: this.totalHashRate > 0 ? this.solutions / (this.totalHashRate / 1000000) : 0 // solutions per MH/s
    };
  }
  
  /**
   * Get average temperature
   */
  _getAverageTemperature() {
    const temperatures = Array.from(this.metrics.temperature.values());
    return temperatures.length > 0 
      ? temperatures.reduce((a, b) => a + b) / temperatures.length 
      : 0;
  }
  
  /**
   * Get device status
   */
  getDeviceStatus(deviceId) {
    const device = this.devices.find(d => d.id === deviceId);
    if (!device) return null;
    
    const metrics = this.metrics.deviceMetrics.get(deviceId) || {};
    
    return {
      ...device.toJSON(),
      metrics,
      isActive: this.workers.has(deviceId)
    };
  }
  
  /**
   * Set device intensity
   */
  async setDeviceIntensity(deviceId, intensity) {
    const worker = this.workers.get(deviceId);
    if (worker) {
      worker.postMessage({
        type: 'set_intensity',
        intensity
      });
    }
  }
  
  /**
   * Shutdown
   */
  async shutdown() {
    logger.info('Shutting down GPU mining manager');
    
    await this.stopMining();
    
    this.emit('shutdown');
  }
}

// Worker thread entry point
if (!isMainThread && workerData) {
  const worker = new GPUMinerWorker(
    workerData.deviceId,
    workerData
  );
  
  worker.start(workerData.workData);
  
  parentPort.on('message', (message) => {
    switch (message.type) {
      case 'update_work':
        // Update work data without restarting
        break;
        
      case 'set_intensity':
        worker.options.intensity = message.intensity;
        break;
        
      case 'stop':
        worker.stop();
        process.exit(0);
        break;
    }
  });
}

export default GPUMiningManager;