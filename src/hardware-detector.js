import * as os from 'os';
import * as fs from 'fs';

// ==================== Hardware Detector ====================
export class HardwareDetector {
  static detect() {
    const cpus = os.cpus();
    const info = {
      cpu: {
        model: cpus[0].model,
        cores: cpus.length,
        speed: cpus[0].speed,
        features: []
      },
      memory: {
        total: os.totalmem(),
        free: os.freemem()
      },
      gpu: [],
      asic: []
    };

    // Detect CPU features
    if (info.cpu.model.includes('AMD')) info.cpu.features.push('AVX2');
    if (info.cpu.model.includes('Intel')) info.cpu.features.push('AES-NI');
    
    // Basic GPU detection (simplified - full implementation in gpu.js)
    try {
      if (process.platform === 'win32') {
        // Windows: Check for common GPU indicators
        const gpuIndicators = [
          { env: 'CUDA_PATH', vendor: 'NVIDIA' },
          { env: 'ROCM_PATH', vendor: 'AMD' }
        ];
        
        for (const indicator of gpuIndicators) {
          if (process.env[indicator.env]) {
            info.gpu.push({
              name: `${indicator.vendor} GPU Detected`,
              vendor: indicator.vendor
            });
          }
        }
      } else if (process.platform === 'linux') {
        // Linux: Check for GPU device files
        if (fs.existsSync('/dev/nvidia0') || fs.existsSync('/dev/nvidiactl')) {
          info.gpu.push({ name: 'NVIDIA GPU Detected', vendor: 'NVIDIA' });
        }
        if (fs.existsSync('/dev/dri/renderD128')) {
          info.gpu.push({ name: 'AMD GPU Detected', vendor: 'AMD' });
        }
      }
    } catch (e) {
      // GPU detection failed, continue without GPU
    }
    
    return info;
  }

  static getOptimalThreads(algorithm) {
    const cpus = os.cpus().length;
    const reserved = 1; // Reserve cores for system
    
    const threadRatio = {
      sha256: 1.0,    // Use all available
      kawpow: 0.8,    // GPU-focused, less CPU
      randomx: 1.0,   // CPU-intensive
      ethash: 0.5,    // GPU primary
      scrypt: 0.9     // Memory-bound
    };
    
    const ratio = threadRatio[algorithm] || 1.0;
    return Math.max(1, Math.floor((cpus - reserved) * ratio));
  }
}
