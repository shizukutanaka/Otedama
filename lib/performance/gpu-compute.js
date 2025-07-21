/**
 * GPU Compute Module for Otedama
 * Offloads intensive computations to GPU using WebGL/WebGPU
 * Following Carmack's principles for maximum performance
 */

import { getLogger } from '../core/logger.js';

// Compute kernel types
export const KernelType = {
  HASH_COMPUTATION: 'hash_computation',
  MATRIX_MULTIPLY: 'matrix_multiply',
  VECTOR_OPERATIONS: 'vector_operations',
  NEURAL_NETWORK: 'neural_network',
  CRYPTOGRAPHIC: 'cryptographic',
  PRICE_CALCULATION: 'price_calculation'
};

/**
 * GPU Compute Engine
 */
export class GPUCompute {
  constructor(options = {}) {
    this.logger = getLogger('GPUCompute');
    this.options = {
      preferWebGPU: options.preferWebGPU !== false,
      maxBufferSize: options.maxBufferSize || 256 * 1024 * 1024, // 256MB
      kernelCacheSize: options.kernelCacheSize || 100,
      enableProfiling: options.enableProfiling || false,
      ...options
    };
    
    this.initialized = false;
    this.backend = null;
    this.device = null;
    this.context = null;
    
    // Kernel cache
    this.kernelCache = new Map();
    this.bufferCache = new Map();
    
    // Performance metrics
    this.metrics = {
      kernelsCompiled: 0,
      kernelsExecuted: 0,
      totalComputeTime: 0,
      totalTransferTime: 0,
      gpuUtilization: 0
    };
  }
  
  /**
   * Initialize GPU compute backend
   */
  async initialize() {
    try {
      // Try WebGPU first
      if (this.options.preferWebGPU && 'gpu' in navigator) {
        await this.initializeWebGPU();
      } else {
        // Fall back to WebGL
        await this.initializeWebGL();
      }
      
      this.initialized = true;
      this.logger.info(`GPU compute initialized with ${this.backend}`);
      
    } catch (error) {
      this.logger.error('Failed to initialize GPU compute:', error);
      throw error;
    }
  }
  
  /**
   * Initialize WebGPU backend
   */
  async initializeWebGPU() {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance'
    });
    
    if (!adapter) {
      throw new Error('WebGPU adapter not available');
    }
    
    this.device = await adapter.requestDevice({
      requiredLimits: {
        maxBufferSize: this.options.maxBufferSize,
        maxComputeWorkgroupStorageSize: 16384,
        maxComputeInvocationsPerWorkgroup: 256
      }
    });
    
    this.backend = 'webgpu';
    this.adapter = adapter;
    
    // Set up error handling
    this.device.addEventListener('uncapturederror', (event) => {
      this.logger.error('WebGPU error:', event.error);
    });
  }
  
  /**
   * Initialize WebGL backend
   */
  async initializeWebGL() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      preserveDrawingBuffer: false
    });
    
    if (!gl) {
      throw new Error('WebGL2 not available');
    }
    
    // Check for required extensions
    const requiredExtensions = [
      'EXT_color_buffer_float',
      'OES_texture_float_linear'
    ];
    
    for (const ext of requiredExtensions) {
      if (!gl.getExtension(ext)) {
        throw new Error(`Required WebGL extension ${ext} not available`);
      }
    }
    
    this.context = gl;
    this.backend = 'webgl2';
    
    // Set up WebGL state
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.BLEND);
  }
  
  /**
   * Execute compute kernel
   */
  async compute(kernelType, inputs, options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    const startTime = performance.now();
    
    try {
      // Get or compile kernel
      const kernel = await this.getKernel(kernelType, options);
      
      // Transfer input data to GPU
      const transferStart = performance.now();
      const gpuBuffers = await this.transferToGPU(inputs);
      const transferTime = performance.now() - transferStart;
      
      // Execute kernel
      const computeStart = performance.now();
      const result = await this.executeKernel(kernel, gpuBuffers, options);
      const computeTime = performance.now() - computeStart;
      
      // Transfer results back
      const readbackStart = performance.now();
      const output = await this.transferFromGPU(result);
      const readbackTime = performance.now() - readbackStart;
      
      // Update metrics
      this.metrics.kernelsExecuted++;
      this.metrics.totalComputeTime += computeTime;
      this.metrics.totalTransferTime += transferTime + readbackTime;
      
      const totalTime = performance.now() - startTime;
      
      return {
        output,
        performance: {
          totalTime,
          transferTime: transferTime + readbackTime,
          computeTime,
          speedup: this.calculateSpeedup(kernelType, inputs, totalTime)
        }
      };
      
    } catch (error) {
      this.logger.error(`Compute error for ${kernelType}:`, error);
      throw error;
    }
  }
  
  /**
   * Get or compile kernel
   */
  async getKernel(kernelType, options) {
    const cacheKey = `${kernelType}_${JSON.stringify(options)}`;
    
    if (this.kernelCache.has(cacheKey)) {
      return this.kernelCache.get(cacheKey);
    }
    
    const kernel = await this.compileKernel(kernelType, options);
    this.kernelCache.set(cacheKey, kernel);
    this.metrics.kernelsCompiled++;
    
    return kernel;
  }
  
  /**
   * Compile compute kernel
   */
  async compileKernel(kernelType, options) {
    if (this.backend === 'webgpu') {
      return this.compileWebGPUKernel(kernelType, options);
    } else {
      return this.compileWebGLKernel(kernelType, options);
    }
  }
  
  /**
   * Compile WebGPU kernel
   */
  async compileWebGPUKernel(kernelType, options) {
    const shaderCode = this.getWebGPUShaderCode(kernelType, options);
    
    const shaderModule = this.device.createShaderModule({
      code: shaderCode,
      hints: {
        main: { workgroupSize: [64, 1, 1] }
      }
    });
    
    const pipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: shaderModule,
        entryPoint: 'main'
      }
    });
    
    return {
      type: 'webgpu',
      pipeline,
      workgroupSize: [64, 1, 1]
    };
  }
  
  /**
   * Get WebGPU shader code
   */
  getWebGPUShaderCode(kernelType, options) {
    const shaders = {
      [KernelType.HASH_COMPUTATION]: `
        @group(0) @binding(0) var<storage, read> input: array<u32>;
        @group(0) @binding(1) var<storage, read_write> output: array<u32>;
        
        fn rotateLeft(x: u32, n: u32) -> u32 {
          return (x << n) | (x >> (32u - n));
        }
        
        @compute @workgroup_size(64)
        fn main(@builtin(global_invocation_id) id: vec3<u32>) {
          let index = id.x;
          if (index >= arrayLength(&input)) {
            return;
          }
          
          // SHA256-like computation
          var h: array<u32, 8> = array<u32, 8>(
            0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
            0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u
          );
          
          let data = input[index];
          
          // Simplified hash rounds
          for (var i = 0u; i < 64u; i++) {
            let temp1 = h[7] + rotateLeft(h[4], 6u) + (h[4] ^ h[5] ^ h[6]) + data;
            let temp2 = rotateLeft(h[0], 2u) + ((h[0] & h[1]) | (h[2] & (h[0] | h[1])));
            
            h[7] = h[6];
            h[6] = h[5];
            h[5] = h[4];
            h[4] = h[3] + temp1;
            h[3] = h[2];
            h[2] = h[1];
            h[1] = h[0];
            h[0] = temp1 + temp2;
          }
          
          output[index] = h[0];
        }
      `,
      
      [KernelType.MATRIX_MULTIPLY]: `
        @group(0) @binding(0) var<storage, read> matrixA: array<f32>;
        @group(0) @binding(1) var<storage, read> matrixB: array<f32>;
        @group(0) @binding(2) var<storage, read_write> result: array<f32>;
        @group(0) @binding(3) var<uniform> dimensions: vec3<u32>;
        
        @compute @workgroup_size(8, 8)
        fn main(@builtin(global_invocation_id) id: vec3<u32>) {
          let M = dimensions.x;
          let N = dimensions.y;
          let K = dimensions.z;
          
          let row = id.y;
          let col = id.x;
          
          if (row >= M || col >= N) {
            return;
          }
          
          var sum = 0.0;
          for (var k = 0u; k < K; k++) {
            sum += matrixA[row * K + k] * matrixB[k * N + col];
          }
          
          result[row * N + col] = sum;
        }
      `,
      
      [KernelType.PRICE_CALCULATION]: `
        @group(0) @binding(0) var<storage, read> prices: array<f32>;
        @group(0) @binding(1) var<storage, read> volumes: array<f32>;
        @group(0) @binding(2) var<storage, read_write> vwap: array<f32>;
        
        @compute @workgroup_size(256)
        fn main(@builtin(global_invocation_id) id: vec3<u32>) {
          let index = id.x;
          if (index >= arrayLength(&prices)) {
            return;
          }
          
          // Calculate VWAP for a window
          let windowSize = 20u;
          let start = max(0u, index - windowSize + 1u);
          
          var sumPV = 0.0;
          var sumV = 0.0;
          
          for (var i = start; i <= index; i++) {
            sumPV += prices[i] * volumes[i];
            sumV += volumes[i];
          }
          
          vwap[index] = select(prices[index], sumPV / sumV, sumV > 0.0);
        }
      `
    };
    
    return shaders[kernelType] || shaders[KernelType.HASH_COMPUTATION];
  }
  
  /**
   * Execute WebGPU kernel
   */
  async executeWebGPUKernel(kernel, buffers, options) {
    const commandEncoder = this.device.createCommandEncoder();
    
    // Create bind group
    const bindGroup = this.device.createBindGroup({
      layout: kernel.pipeline.getBindGroupLayout(0),
      entries: buffers.map((buffer, index) => ({
        binding: index,
        resource: { buffer: buffer.gpuBuffer }
      }))
    });
    
    // Record compute pass
    const computePass = commandEncoder.beginComputePass();
    computePass.setPipeline(kernel.pipeline);
    computePass.setBindGroup(0, bindGroup);
    
    // Calculate dispatch size
    const workgroups = Math.ceil(buffers[0].size / kernel.workgroupSize[0]);
    computePass.dispatchWorkgroups(workgroups);
    
    computePass.end();
    
    // Submit commands
    this.device.queue.submit([commandEncoder.finish()]);
    
    // Wait for completion
    await this.device.queue.onSubmittedWorkDone();
    
    return buffers[buffers.length - 1]; // Return output buffer
  }
  
  /**
   * Transfer data to GPU
   */
  async transferToGPU(inputs) {
    if (this.backend === 'webgpu') {
      return this.transferToWebGPU(inputs);
    } else {
      return this.transferToWebGL(inputs);
    }
  }
  
  /**
   * Transfer data to WebGPU
   */
  async transferToWebGPU(inputs) {
    const buffers = [];
    
    for (const input of inputs) {
      const size = input.byteLength;
      
      // Create GPU buffer
      const gpuBuffer = this.device.createBuffer({
        size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
      });
      
      // Write data
      this.device.queue.writeBuffer(gpuBuffer, 0, input);
      
      buffers.push({
        gpuBuffer,
        size: input.length,
        type: input.constructor.name
      });
    }
    
    return buffers;
  }
  
  /**
   * Transfer data from GPU
   */
  async transferFromGPU(buffer) {
    if (this.backend === 'webgpu') {
      return this.transferFromWebGPU(buffer);
    } else {
      return this.transferFromWebGL(buffer);
    }
  }
  
  /**
   * Transfer data from WebGPU
   */
  async transferFromWebGPU(buffer) {
    // Create staging buffer
    const stagingBuffer = this.device.createBuffer({
      size: buffer.gpuBuffer.size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    
    // Copy from compute buffer to staging buffer
    const commandEncoder = this.device.createCommandEncoder();
    commandEncoder.copyBufferToBuffer(
      buffer.gpuBuffer, 0,
      stagingBuffer, 0,
      buffer.gpuBuffer.size
    );
    
    this.device.queue.submit([commandEncoder.finish()]);
    
    // Map and read
    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const arrayBuffer = stagingBuffer.getMappedRange();
    
    // Create appropriate typed array
    const TypedArray = {
      'Float32Array': Float32Array,
      'Uint32Array': Uint32Array,
      'Int32Array': Int32Array
    }[buffer.type] || Uint8Array;
    
    const result = new TypedArray(arrayBuffer.slice(0));
    
    stagingBuffer.unmap();
    stagingBuffer.destroy();
    
    return result;
  }
  
  /**
   * Calculate speedup compared to CPU
   */
  calculateSpeedup(kernelType, inputs, gpuTime) {
    // Estimate CPU time based on operation complexity
    const complexityFactors = {
      [KernelType.HASH_COMPUTATION]: 100,
      [KernelType.MATRIX_MULTIPLY]: 1000,
      [KernelType.NEURAL_NETWORK]: 500,
      [KernelType.PRICE_CALCULATION]: 50
    };
    
    const factor = complexityFactors[kernelType] || 100;
    const dataSize = inputs.reduce((sum, input) => sum + input.length, 0);
    const estimatedCPUTime = dataSize * factor / 1000000; // ms
    
    return estimatedCPUTime / gpuTime;
  }
  
  /**
   * Batch compute for multiple operations
   */
  async batchCompute(operations) {
    const results = [];
    
    // Group by kernel type for better GPU utilization
    const grouped = new Map();
    
    for (const op of operations) {
      if (!grouped.has(op.kernel)) {
        grouped.set(op.kernel, []);
      }
      grouped.get(op.kernel).push(op);
    }
    
    // Execute each group
    for (const [kernel, ops] of grouped) {
      // Combine inputs
      const combinedInputs = this.combineInputs(ops);
      
      // Execute on GPU
      const result = await this.compute(kernel, combinedInputs, {
        batch: true,
        batchSize: ops.length
      });
      
      // Split results
      const splitResults = this.splitResults(result, ops);
      results.push(...splitResults);
    }
    
    return results;
  }
  
  /**
   * Combine inputs for batch processing
   */
  combineInputs(operations) {
    // Implementation depends on operation type
    // This is a simplified version
    const combined = [];
    
    for (let i = 0; i < operations[0].inputs.length; i++) {
      const arrays = operations.map(op => op.inputs[i]);
      const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
      
      const TypedArray = arrays[0].constructor;
      const combined = new TypedArray(totalLength);
      
      let offset = 0;
      for (const arr of arrays) {
        combined.set(arr, offset);
        offset += arr.length;
      }
      
      combined.push(combined);
    }
    
    return combined;
  }
  
  /**
   * Get GPU capabilities
   */
  async getCapabilities() {
    if (!this.initialized) {
      await this.initialize();
    }
    
    if (this.backend === 'webgpu') {
      const limits = this.device.limits;
      const features = Array.from(this.device.features);
      
      return {
        backend: 'webgpu',
        maxBufferSize: limits.maxBufferSize,
        maxComputeWorkgroupSize: [
          limits.maxComputeWorkgroupSizeX,
          limits.maxComputeWorkgroupSizeY,
          limits.maxComputeWorkgroupSizeZ
        ],
        maxComputeInvocationsPerWorkgroup: limits.maxComputeInvocationsPerWorkgroup,
        features
      };
    } else {
      const gl = this.context;
      
      return {
        backend: 'webgl2',
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        maxVertexTextureImageUnits: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
        maxFragmentUniformVectors: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
        renderer: gl.getParameter(gl.RENDERER),
        vendor: gl.getParameter(gl.VENDOR)
      };
    }
  }
  
  /**
   * Get performance metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      averageComputeTime: this.metrics.kernelsExecuted > 0 
        ? this.metrics.totalComputeTime / this.metrics.kernelsExecuted 
        : 0,
      averageTransferTime: this.metrics.kernelsExecuted > 0
        ? this.metrics.totalTransferTime / this.metrics.kernelsExecuted
        : 0,
      kernelCacheHitRate: this.metrics.kernelsExecuted > 0
        ? 1 - (this.metrics.kernelsCompiled / this.metrics.kernelsExecuted)
        : 0
    };
  }
  
  /**
   * Cleanup resources
   */
  async cleanup() {
    // Clear caches
    this.kernelCache.clear();
    this.bufferCache.clear();
    
    if (this.backend === 'webgpu' && this.device) {
      this.device.destroy();
    }
    
    this.initialized = false;
  }
}

// Singleton instance
let gpuComputeInstance = null;

/**
 * Get GPU compute instance
 */
export function getGPUCompute(options) {
  if (!gpuComputeInstance) {
    gpuComputeInstance = new GPUCompute(options);
  }
  return gpuComputeInstance;
}

export default GPUCompute;