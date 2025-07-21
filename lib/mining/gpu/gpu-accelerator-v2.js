/**
 * Advanced GPU Accelerator V2
 * Enhanced GPU mining with multi-platform support and optimizations
 */

import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import { logger } from '../../core/logger.js';

/**
 * GPU Platform support
 */
export const GPUPlatform = {
  CUDA: 'cuda',
  OPENCL: 'opencl',
  METAL: 'metal',
  VULKAN: 'vulkan',
  WEBGPU: 'webgpu'
};

/**
 * Advanced GPU device management
 */
export class GPUDeviceV2 {
  constructor(data) {
    this.id = data.id;
    this.name = data.name;
    this.platform = data.platform;
    this.computeUnits = data.computeUnits;
    this.memory = data.memory;
    this.clockSpeed = data.clockSpeed;
    
    // Performance metrics
    this.metrics = {
      temperature: 0,
      fanSpeed: 0,
      powerDraw: 0,
      utilization: 0,
      memoryUsed: 0,
      errors: 0
    };
    
    // Dynamic tuning parameters
    this.tuning = {
      intensity: data.intensity || 20,
      worksize: data.worksize || 256,
      threads: data.threads || 1,
      blocks: data.blocks || 1024,
      autoTune: true
    };
    
    // Thermal management
    this.thermal = {
      targetTemp: 75,
      maxTemp: 85,
      throttleTemp: 80,
      minFanSpeed: 30,
      maxFanSpeed: 100
    };
  }
  
  /**
   * Auto-tune for optimal performance
   */
  async autoTune(algorithm) {
    logger.info(`Auto-tuning GPU ${this.name} for ${algorithm}`);
    
    const results = [];
    const testDuration = 10000; // 10 seconds per test
    
    // Test different configurations
    const configurations = [
      { intensity: 18, worksize: 128 },
      { intensity: 19, worksize: 256 },
      { intensity: 20, worksize: 256 },
      { intensity: 21, worksize: 512 },
      { intensity: 22, worksize: 1024 }
    ];
    
    for (const config of configurations) {
      try {
        const result = await this.benchmarkConfig(algorithm, config, testDuration);
        results.push({ config, hashRate: result.hashRate, errors: result.errors });
      } catch (error) {
        logger.warn(`Benchmark failed for config ${JSON.stringify(config)}: ${error.message}`);
      }
    }
    
    // Select best configuration
    const best = results.reduce((prev, curr) => {
      // Prefer higher hash rate with no errors
      if (curr.errors === 0 && curr.hashRate > prev.hashRate) {
        return curr;
      }
      return prev;
    }, results[0]);
    
    // Apply best configuration
    this.tuning.intensity = best.config.intensity;
    this.tuning.worksize = best.config.worksize;
    
    logger.info(`Auto-tune complete: ${JSON.stringify(best.config)} - ${best.hashRate} H/s`);
    
    return best;
  }
  
  /**
   * Benchmark specific configuration
   */
  async benchmarkConfig(algorithm, config, duration) {
    // In real implementation, would run actual GPU kernel
    return new Promise((resolve) => {
      setTimeout(() => {
        // Simulate benchmark results
        const baseHashRate = this.computeUnits * this.clockSpeed * 1000;
        const configMultiplier = config.intensity / 20;
        const hashRate = baseHashRate * configMultiplier * Math.random() * 0.8 + 0.2;
        const errors = Math.random() > 0.9 ? Math.floor(Math.random() * 10) : 0;
        
        resolve({ hashRate, errors });
      }, duration);
    });
  }
  
  /**
   * Apply thermal throttling
   */
  applyThermalThrottling() {
    if (this.metrics.temperature >= this.thermal.throttleTemp) {
      const throttleRatio = (this.thermal.maxTemp - this.metrics.temperature) / 
                           (this.thermal.maxTemp - this.thermal.throttleTemp);
      
      const newIntensity = Math.max(15, Math.floor(this.tuning.intensity * throttleRatio));
      
      if (newIntensity < this.tuning.intensity) {
        logger.warn(`Thermal throttling GPU ${this.name}: ${this.tuning.intensity} -> ${newIntensity}`);
        this.tuning.intensity = newIntensity;
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * Update device metrics
   */
  updateMetrics(metrics) {
    Object.assign(this.metrics, metrics);
    
    // Check thermal limits
    if (this.metrics.temperature > this.thermal.maxTemp) {
      logger.error(`GPU ${this.name} exceeding max temperature: ${this.metrics.temperature}°C`);
    }
  }
}

/**
 * GPU kernel compiler for different platforms
 */
export class GPUKernelCompiler {
  constructor() {
    this.compiledKernels = new Map();
  }
  
  /**
   * Compile kernel for specific platform and algorithm
   */
  async compileKernel(platform, algorithm, options = {}) {
    const key = `${platform}-${algorithm}`;
    
    if (this.compiledKernels.has(key)) {
      return this.compiledKernels.get(key);
    }
    
    let kernel;
    
    switch (platform) {
      case GPUPlatform.CUDA:
        kernel = await this.compileCUDAKernel(algorithm, options);
        break;
      case GPUPlatform.OPENCL:
        kernel = await this.compileOpenCLKernel(algorithm, options);
        break;
      case GPUPlatform.METAL:
        kernel = await this.compileMetalKernel(algorithm, options);
        break;
      case GPUPlatform.VULKAN:
        kernel = await this.compileVulkanKernel(algorithm, options);
        break;
      case GPUPlatform.WEBGPU:
        kernel = await this.compileWebGPUKernel(algorithm, options);
        break;
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
    
    this.compiledKernels.set(key, kernel);
    return kernel;
  }
  
  /**
   * Compile CUDA kernel with PTX optimization
   */
  async compileCUDAKernel(algorithm, options) {
    const kernelSource = this.generateCUDASource(algorithm, options);
    
    return {
      platform: GPUPlatform.CUDA,
      algorithm,
      source: kernelSource,
      launchConfig: {
        gridDim: options.blocks || 1024,
        blockDim: options.threads || 256,
        sharedMem: options.sharedMem || 0
      }
    };
  }
  
  /**
   * Generate optimized CUDA source
   */
  generateCUDASource(algorithm, options) {
    // Base template with optimizations
    return `
    #include <cuda_runtime.h>
    #include <device_launch_parameters.h>
    
    // Optimized constants in constant memory
    __constant__ uint32_t c_target[8];
    __constant__ uint32_t c_blockHeader[20];
    
    // Texture memory for lookup tables
    texture<uint32_t, 1, cudaReadModeElementType> tex_lookupTable;
    
    __global__ void ${algorithm}_kernel(
      uint32_t* g_nonces,
      uint32_t* g_results,
      uint32_t nonce_base,
      uint32_t threads_per_block
    ) {
      // Shared memory for collaboration
      extern __shared__ uint32_t s_data[];
      
      const uint32_t tid = blockIdx.x * blockDim.x + threadIdx.x;
      const uint32_t nonce = nonce_base + tid;
      
      // Algorithm-specific computation
      uint32_t hash[8];
      compute_${algorithm}(c_blockHeader, nonce, hash);
      
      // Collaborative reduction to check target
      if (check_target(hash, c_target)) {
        atomicExch(&g_results[0], nonce);
      }
    }
    
    __device__ void compute_${algorithm}(
      const uint32_t* header,
      uint32_t nonce,
      uint32_t* hash
    ) {
      // Optimized algorithm implementation
      ${this.getAlgorithmImplementation(algorithm)}
    }
    
    __device__ bool check_target(
      const uint32_t* hash,
      const uint32_t* target
    ) {
      // Optimized target comparison
      #pragma unroll
      for (int i = 7; i >= 0; i--) {
        if (hash[i] > target[i]) return false;
        if (hash[i] < target[i]) return true;
      }
      return true;
    }
    `;
  }
  
  /**
   * Get optimized algorithm implementation
   */
  getAlgorithmImplementation(algorithm) {
    const implementations = {
      sha256: `
        // SHA-256 with CUDA optimizations
        uint32_t w[64];
        uint32_t state[8] = {
          0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
          0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
        };
        
        // Message schedule with memory coalescing
        #pragma unroll 16
        for (int i = 0; i < 16; i++) {
          w[i] = (i < 15) ? header[i] : nonce;
        }
        
        #pragma unroll 48
        for (int i = 16; i < 64; i++) {
          uint32_t s0 = __byte_perm(w[i-15], 0, 0x2103) ^ 
                       __byte_perm(w[i-15], 0, 0x0321) ^ 
                       (w[i-15] >> 3);
          uint32_t s1 = __byte_perm(w[i-2], 0, 0x1032) ^ 
                       __byte_perm(w[i-2], 0, 0x2103) ^ 
                       (w[i-2] >> 10);
          w[i] = w[i-16] + s0 + w[i-7] + s1;
        }
        
        // Compression with register optimization
        uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
        uint32_t e = state[4], f = state[5], g = state[6], h = state[7];
        
        #pragma unroll 64
        for (int i = 0; i < 64; i++) {
          uint32_t S1 = __byte_perm(e, 0, 0x2103) ^ 
                       __byte_perm(e, 0, 0x0321) ^ 
                       __byte_perm(e, 0, 0x1032);
          uint32_t ch = (e & f) ^ (~e & g);
          uint32_t temp1 = h + S1 + ch + tex1Dfetch(tex_lookupTable, i) + w[i];
          
          uint32_t S0 = __byte_perm(a, 0, 0x0321) ^ 
                       __byte_perm(a, 0, 0x2103) ^ 
                       __byte_perm(a, 0, 0x1032);
          uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
          uint32_t temp2 = S0 + maj;
          
          h = g; g = f; f = e; e = d + temp1;
          d = c; c = b; b = a; a = temp1 + temp2;
        }
        
        // Final hash
        hash[0] = state[0] + a;
        hash[1] = state[1] + b;
        hash[2] = state[2] + c;
        hash[3] = state[3] + d;
        hash[4] = state[4] + e;
        hash[5] = state[5] + f;
        hash[6] = state[6] + g;
        hash[7] = state[7] + h;
      `,
      
      scrypt: `
        // Optimized scrypt with shared memory
        // Implementation details...
      `,
      
      ethash: `
        // Ethash with texture memory for DAG
        // Implementation details...
      `
    };
    
    return implementations[algorithm] || '// Algorithm not implemented';
  }
  
  /**
   * Compile OpenCL kernel
   */
  async compileOpenCLKernel(algorithm, options) {
    return {
      platform: GPUPlatform.OPENCL,
      algorithm,
      source: this.generateOpenCLSource(algorithm, options)
    };
  }
  
  /**
   * Generate OpenCL source
   */
  generateOpenCLSource(algorithm, options) {
    return `
    __kernel void ${algorithm}_kernel(
      __global uint* nonces,
      __global uint* results,
      __constant uint* target,
      __constant uint* header,
      uint nonce_base
    ) {
      const uint gid = get_global_id(0);
      const uint nonce = nonce_base + gid;
      
      uint hash[8];
      compute_${algorithm}(header, nonce, hash);
      
      if (check_target(hash, target)) {
        atomic_xchg(&results[0], nonce);
      }
    }
    `;
  }
  
  /**
   * Compile Metal kernel
   */
  async compileMetalKernel(algorithm, options) {
    return {
      platform: GPUPlatform.METAL,
      algorithm,
      source: this.generateMetalSource(algorithm, options)
    };
  }
  
  /**
   * Generate Metal source
   */
  generateMetalSource(algorithm, options) {
    return `
    #include <metal_stdlib>
    using namespace metal;
    
    kernel void ${algorithm}_kernel(
      device uint* nonces [[buffer(0)]],
      device uint* results [[buffer(1)]],
      constant uint* target [[buffer(2)]],
      constant uint* header [[buffer(3)]],
      uint gid [[thread_position_in_grid]]
    ) {
      const uint nonce = nonces[0] + gid;
      
      uint hash[8];
      compute_${algorithm}(header, nonce, hash);
      
      if (check_target(hash, target)) {
        atomic_exchange_explicit(
          (device atomic_uint*)&results[0], 
          nonce, 
          memory_order_relaxed
        );
      }
    }
    `;
  }
  
  /**
   * Compile Vulkan compute shader
   */
  async compileVulkanKernel(algorithm, options) {
    return {
      platform: GPUPlatform.VULKAN,
      algorithm,
      source: this.generateVulkanSource(algorithm, options),
      spirv: true // Indicate SPIR-V compilation needed
    };
  }
  
  /**
   * Generate Vulkan GLSL compute shader
   */
  generateVulkanSource(algorithm, options) {
    return `
    #version 450
    
    layout(local_size_x = ${options.worksize || 256}) in;
    
    layout(set = 0, binding = 0) buffer Nonces {
      uint nonces[];
    };
    
    layout(set = 0, binding = 1) buffer Results {
      uint results[];
    };
    
    layout(set = 0, binding = 2) uniform Target {
      uint target[8];
    };
    
    layout(set = 0, binding = 3) uniform Header {
      uint header[20];
    };
    
    void main() {
      uint gid = gl_GlobalInvocationID.x;
      uint nonce = nonces[0] + gid;
      
      uint hash[8];
      compute_${algorithm}(header, nonce, hash);
      
      if (check_target(hash, target)) {
        atomicExchange(results[0], nonce);
      }
    }
    `;
  }
  
  /**
   * Compile WebGPU kernel
   */
  async compileWebGPUKernel(algorithm, options) {
    return {
      platform: GPUPlatform.WEBGPU,
      algorithm,
      source: this.generateWebGPUSource(algorithm, options)
    };
  }
  
  /**
   * Generate WebGPU WGSL source
   */
  generateWebGPUSource(algorithm, options) {
    return `
    struct Params {
      nonce_base: u32,
      target: array<u32, 8>,
      header: array<u32, 20>
    };
    
    @group(0) @binding(0) var<storage, read_write> results: array<u32>;
    @group(0) @binding(1) var<uniform> params: Params;
    
    @compute @workgroup_size(${options.worksize || 256})
    fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
      let nonce = params.nonce_base + global_id.x;
      
      var hash: array<u32, 8>;
      compute_${algorithm}(&params.header, nonce, &hash);
      
      if (check_target(&hash, &params.target)) {
        atomicStore(&results[0], nonce);
      }
    }
    `;
  }
}

/**
 * Advanced GPU mining orchestrator
 */
export class GPUMiningOrchestratorV2 extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      maxGPUs: options.maxGPUs || 8,
      autoTune: options.autoTune !== false,
      thermalManagement: options.thermalManagement !== false,
      powerLimit: options.powerLimit || 0, // 0 = no limit
      targetEfficiency: options.targetEfficiency || 0.9, // 90% efficiency target
      ...options
    };
    
    this.devices = new Map();
    this.workers = new Map();
    this.compiler = new GPUKernelCompiler();
    
    this.metrics = {
      totalHashRate: 0,
      totalPower: 0,
      efficiency: 0,
      solutions: 0,
      errors: 0,
      uptime: 0
    };
    
    this.isRunning = false;
    this.startTime = null;
  }
  
  /**
   * Initialize and detect GPUs
   */
  async initialize() {
    logger.info('Initializing GPU mining orchestrator V2');
    
    // Detect GPUs across all platforms
    const detectedDevices = await this.detectAllGPUs();
    
    // Filter and rank devices
    const rankedDevices = this.rankDevices(detectedDevices);
    
    // Select best devices up to limit
    const selectedDevices = rankedDevices.slice(0, this.options.maxGPUs);
    
    // Initialize selected devices
    for (const deviceData of selectedDevices) {
      const device = new GPUDeviceV2(deviceData);
      this.devices.set(device.id, device);
      
      logger.info(`Initialized GPU: ${device.name} (${device.platform})`);
    }
    
    // Auto-tune if enabled
    if (this.options.autoTune && this.devices.size > 0) {
      await this.autoTuneAllDevices();
    }
    
    this.emit('initialized', { deviceCount: this.devices.size });
  }
  
  /**
   * Detect GPUs across all platforms
   */
  async detectAllGPUs() {
    const devices = [];
    
    // Platform-specific detection
    const detectors = [
      this.detectCUDADevices(),
      this.detectOpenCLDevices(),
      this.detectMetalDevices(),
      this.detectVulkanDevices(),
      this.detectWebGPUDevices()
    ];
    
    const results = await Promise.allSettled(detectors);
    
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        devices.push(...result.value);
      }
    }
    
    return devices;
  }
  
  /**
   * Detect CUDA devices
   */
  async detectCUDADevices() {
    // In real implementation, would use CUDA runtime API
    try {
      // Simulated CUDA detection
      if (process.platform === 'win32' || process.platform === 'linux') {
        return [{
          id: 'cuda-0',
          name: 'NVIDIA RTX 4090',
          platform: GPUPlatform.CUDA,
          computeUnits: 16384,
          memory: { total: 24 * 1024 * 1024 * 1024, available: 23 * 1024 * 1024 * 1024 },
          clockSpeed: 2520,
          powerLimit: 450
        }];
      }
    } catch (error) {
      logger.debug('CUDA detection failed:', error.message);
    }
    
    return [];
  }
  
  /**
   * Detect OpenCL devices
   */
  async detectOpenCLDevices() {
    // In real implementation, would use OpenCL API
    try {
      return [{
        id: 'opencl-0',
        name: 'AMD RX 7900 XTX',
        platform: GPUPlatform.OPENCL,
        computeUnits: 6144,
        memory: { total: 24 * 1024 * 1024 * 1024, available: 23 * 1024 * 1024 * 1024 },
        clockSpeed: 2500,
        powerLimit: 355
      }];
    } catch (error) {
      logger.debug('OpenCL detection failed:', error.message);
    }
    
    return [];
  }
  
  /**
   * Detect Metal devices
   */
  async detectMetalDevices() {
    if (process.platform === 'darwin') {
      return [{
        id: 'metal-0',
        name: 'Apple M2 Ultra',
        platform: GPUPlatform.METAL,
        computeUnits: 76,
        memory: { total: 192 * 1024 * 1024 * 1024, available: 180 * 1024 * 1024 * 1024 },
        clockSpeed: 1398,
        powerLimit: 60
      }];
    }
    
    return [];
  }
  
  /**
   * Detect Vulkan devices
   */
  async detectVulkanDevices() {
    // Vulkan can work on multiple platforms
    return [];
  }
  
  /**
   * Detect WebGPU devices
   */
  async detectWebGPUDevices() {
    // WebGPU for browser-based mining
    return [];
  }
  
  /**
   * Rank devices by estimated performance
   */
  rankDevices(devices) {
    return devices.sort((a, b) => {
      // Simple ranking based on compute units and clock speed
      const scoreA = a.computeUnits * a.clockSpeed;
      const scoreB = b.computeUnits * b.clockSpeed;
      return scoreB - scoreA;
    });
  }
  
  /**
   * Auto-tune all devices
   */
  async autoTuneAllDevices() {
    logger.info('Auto-tuning all GPU devices...');
    
    const tuningPromises = [];
    
    for (const device of this.devices.values()) {
      tuningPromises.push(device.autoTune(this.options.algorithm));
    }
    
    await Promise.all(tuningPromises);
    
    logger.info('Auto-tuning complete');
  }
  
  /**
   * Start mining on all devices
   */
  async startMining(workData) {
    if (this.isRunning) {
      throw new Error('Mining already running');
    }
    
    this.isRunning = true;
    this.startTime = Date.now();
    
    logger.info(`Starting GPU mining on ${this.devices.size} devices`);
    
    // Compile kernels for each platform
    await this.compileKernels();
    
    // Start mining on each device
    for (const device of this.devices.values()) {
      await this.startDeviceMining(device, workData);
    }
    
    // Start monitoring
    this.startMonitoring();
    
    this.emit('mining:started');
  }
  
  /**
   * Compile kernels for all platforms
   */
  async compileKernels() {
    const platforms = new Set();
    
    for (const device of this.devices.values()) {
      platforms.add(device.platform);
    }
    
    const compilePromises = [];
    
    for (const platform of platforms) {
      compilePromises.push(
        this.compiler.compileKernel(platform, this.options.algorithm)
      );
    }
    
    await Promise.all(compilePromises);
    
    logger.info(`Compiled kernels for ${platforms.size} platforms`);
  }
  
  /**
   * Start mining on specific device
   */
  async startDeviceMining(device, workData) {
    const worker = new Worker('./lib/mining/gpu/gpu-worker-v2.js', {
      workerData: {
        deviceId: device.id,
        platform: device.platform,
        algorithm: this.options.algorithm,
        kernel: await this.compiler.compileKernel(device.platform, this.options.algorithm),
        tuning: device.tuning,
        workData
      }
    });
    
    worker.on('message', (msg) => this.handleWorkerMessage(device.id, msg));
    worker.on('error', (err) => this.handleWorkerError(device.id, err));
    
    this.workers.set(device.id, worker);
  }
  
  /**
   * Handle worker messages
   */
  handleWorkerMessage(deviceId, message) {
    const device = this.devices.get(deviceId);
    if (!device) return;
    
    switch (message.type) {
      case 'solution':
        this.metrics.solutions++;
        this.emit('solution:found', {
          deviceId,
          nonce: message.nonce,
          hash: message.hash
        });
        break;
        
      case 'metrics':
        device.updateMetrics(message.metrics);
        this.updateTotalMetrics();
        break;
        
      case 'error':
        this.metrics.errors++;
        logger.error(`Device ${deviceId} error: ${message.error}`);
        break;
    }
  }
  
  /**
   * Handle worker errors
   */
  handleWorkerError(deviceId, error) {
    logger.error(`Worker error for device ${deviceId}:`, error);
    this.metrics.errors++;
    
    // Attempt to restart worker
    this.restartWorker(deviceId);
  }
  
  /**
   * Restart worker for device
   */
  async restartWorker(deviceId) {
    const worker = this.workers.get(deviceId);
    if (worker) {
      await worker.terminate();
    }
    
    const device = this.devices.get(deviceId);
    if (device && this.isRunning) {
      logger.info(`Restarting worker for device ${deviceId}`);
      await this.startDeviceMining(device, this.currentWorkData);
    }
  }
  
  /**
   * Start monitoring loop
   */
  startMonitoring() {
    this.monitoringInterval = setInterval(() => {
      this.performMonitoring();
    }, 5000);
  }
  
  /**
   * Perform monitoring tasks
   */
  async performMonitoring() {
    // Update metrics
    this.updateTotalMetrics();
    
    // Thermal management
    if (this.options.thermalManagement) {
      this.performThermalManagement();
    }
    
    // Power management
    if (this.options.powerLimit > 0) {
      this.performPowerManagement();
    }
    
    // Efficiency optimization
    this.optimizeEfficiency();
    
    // Emit metrics
    this.emit('metrics:updated', this.getMetrics());
  }
  
  /**
   * Update total metrics
   */
  updateTotalMetrics() {
    let totalHashRate = 0;
    let totalPower = 0;
    
    for (const device of this.devices.values()) {
      const deviceHashRate = this.calculateDeviceHashRate(device);
      totalHashRate += deviceHashRate;
      totalPower += device.metrics.powerDraw;
    }
    
    this.metrics.totalHashRate = totalHashRate;
    this.metrics.totalPower = totalPower;
    this.metrics.efficiency = totalPower > 0 ? totalHashRate / totalPower : 0;
    this.metrics.uptime = Date.now() - this.startTime;
  }
  
  /**
   * Calculate device hash rate
   */
  calculateDeviceHashRate(device) {
    // Estimate based on device specs and current settings
    const baseRate = device.computeUnits * device.clockSpeed * 1000;
    const intensityMultiplier = Math.pow(2, device.tuning.intensity) / Math.pow(2, 20);
    const utilizationMultiplier = device.metrics.utilization / 100;
    
    return baseRate * intensityMultiplier * utilizationMultiplier;
  }
  
  /**
   * Perform thermal management
   */
  performThermalManagement() {
    for (const device of this.devices.values()) {
      if (device.applyThermalThrottling()) {
        // Update worker with new intensity
        const worker = this.workers.get(device.id);
        if (worker) {
          worker.postMessage({
            type: 'update_intensity',
            intensity: device.tuning.intensity
          });
        }
      }
    }
  }
  
  /**
   * Perform power management
   */
  performPowerManagement() {
    if (this.metrics.totalPower > this.options.powerLimit) {
      const reductionRatio = this.options.powerLimit / this.metrics.totalPower;
      
      logger.warn(`Power limit exceeded: ${this.metrics.totalPower}W > ${this.options.powerLimit}W`);
      
      // Reduce intensity on all devices proportionally
      for (const device of this.devices.values()) {
        const newIntensity = Math.floor(device.tuning.intensity * reductionRatio);
        if (newIntensity < device.tuning.intensity) {
          device.tuning.intensity = Math.max(15, newIntensity);
          
          const worker = this.workers.get(device.id);
          if (worker) {
            worker.postMessage({
              type: 'update_intensity',
              intensity: device.tuning.intensity
            });
          }
        }
      }
    }
  }
  
  /**
   * Optimize for efficiency
   */
  optimizeEfficiency() {
    if (this.metrics.efficiency < this.options.targetEfficiency) {
      // Find least efficient device
      let leastEfficient = null;
      let lowestEfficiency = Infinity;
      
      for (const device of this.devices.values()) {
        const deviceHashRate = this.calculateDeviceHashRate(device);
        const deviceEfficiency = device.metrics.powerDraw > 0 ? 
          deviceHashRate / device.metrics.powerDraw : 0;
        
        if (deviceEfficiency < lowestEfficiency) {
          lowestEfficiency = deviceEfficiency;
          leastEfficient = device;
        }
      }
      
      // Adjust least efficient device
      if (leastEfficient && leastEfficient.tuning.autoTune) {
        logger.info(`Optimizing efficiency for device ${leastEfficient.id}`);
        leastEfficient.autoTune(this.options.algorithm);
      }
    }
  }
  
  /**
   * Update work for all devices
   */
  async updateWork(workData) {
    this.currentWorkData = workData;
    
    for (const worker of this.workers.values()) {
      worker.postMessage({
        type: 'update_work',
        workData
      });
    }
    
    this.emit('work:updated');
  }
  
  /**
   * Get current metrics
   */
  getMetrics() {
    const deviceMetrics = {};
    
    for (const [id, device] of this.devices) {
      deviceMetrics[id] = {
        name: device.name,
        platform: device.platform,
        hashRate: this.calculateDeviceHashRate(device),
        temperature: device.metrics.temperature,
        power: device.metrics.powerDraw,
        utilization: device.metrics.utilization,
        intensity: device.tuning.intensity,
        errors: device.metrics.errors
      };
    }
    
    return {
      ...this.metrics,
      devices: deviceMetrics,
      avgTemperature: this.calculateAverageTemperature(),
      hashPerWatt: this.metrics.totalPower > 0 ? 
        this.metrics.totalHashRate / this.metrics.totalPower : 0
    };
  }
  
  /**
   * Calculate average temperature
   */
  calculateAverageTemperature() {
    let sum = 0;
    let count = 0;
    
    for (const device of this.devices.values()) {
      sum += device.metrics.temperature;
      count++;
    }
    
    return count > 0 ? sum / count : 0;
  }
  
  /**
   * Stop mining
   */
  async stopMining() {
    this.isRunning = false;
    
    // Stop monitoring
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    
    // Terminate all workers
    const terminatePromises = [];
    
    for (const worker of this.workers.values()) {
      terminatePromises.push(worker.terminate());
    }
    
    await Promise.all(terminatePromises);
    
    this.workers.clear();
    
    logger.info('GPU mining stopped');
    
    this.emit('mining:stopped');
  }
  
  /**
   * Shutdown
   */
  async shutdown() {
    await this.stopMining();
    this.devices.clear();
    this.emit('shutdown');
  }
}

export default GPUMiningOrchestratorV2;