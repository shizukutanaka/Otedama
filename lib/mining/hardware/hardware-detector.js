/**
 * Hardware Detector - Otedama
 * Detects available mining hardware (CPU/GPU/ASIC)
 * 
 * Design principles:
 * - Platform-agnostic detection (Carmack)
 * - Clean hardware abstraction (Martin)
 * - Simple, reliable implementation (Pike)
 */

import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../../core/logger.js';

const execAsync = promisify(exec);
const logger = createLogger('HardwareDetector');

export class HardwareDetector {
  constructor() {
    this.platform = process.platform;
  }
  
  /**
   * Detect all available hardware
   */
  async detect() {
    const hardware = {
      cpu: null,
      gpus: [],
      asics: []
    };
    
    // Detect CPU
    hardware.cpu = await this.detectCPU();
    
    // Detect GPUs
    hardware.gpus = await this.detectGPUs();
    
    // Detect ASICs
    hardware.asics = await this.detectASICs();
    
    return hardware;
  }
  
  /**
   * Detect CPU information
   */
  async detectCPU() {
    const cpus = os.cpus();
    
    if (cpus.length === 0) {
      return null;
    }
    
    const cpu = {
      model: cpus[0].model,
      cores: cpus.length,
      speed: cpus[0].speed,
      architecture: os.arch(),
      features: await this.detectCPUFeatures()
    };
    
    return cpu;
  }
  
  /**
   * Detect CPU features (AVX, SSE, etc.)
   */
  async detectCPUFeatures() {
    const features = {
      sse2: false,
      sse4: false,
      avx: false,
      avx2: false,
      aes: false
    };
    
    try {
      if (this.platform === 'win32') {
        // Windows: Use wmic
        const { stdout } = await execAsync('wmic cpu get description /value');
        const description = stdout.toLowerCase();
        
        features.sse2 = true; // Almost all modern CPUs have SSE2
        features.avx = description.includes('avx');
        features.aes = description.includes('aes');
      } else if (this.platform === 'linux') {
        // Linux: Parse /proc/cpuinfo
        const { stdout } = await execAsync('cat /proc/cpuinfo | grep flags | head -1');
        const flags = stdout.toLowerCase();
        
        features.sse2 = flags.includes('sse2');
        features.sse4 = flags.includes('sse4');
        features.avx = flags.includes('avx');
        features.avx2 = flags.includes('avx2');
        features.aes = flags.includes('aes');
      } else if (this.platform === 'darwin') {
        // macOS: Use sysctl
        const { stdout } = await execAsync('sysctl -a | grep cpu.features');
        const cpuFeatures = stdout.toLowerCase();
        
        features.sse2 = cpuFeatures.includes('sse2');
        features.avx = cpuFeatures.includes('avx');
        features.aes = cpuFeatures.includes('aes');
      }
    } catch (error) {
      logger.debug('Could not detect CPU features:', error.message);
    }
    
    return features;
  }
  
  /**
   * Detect GPUs
   */
  async detectGPUs() {
    const gpus = [];
    
    // Try NVIDIA detection
    const nvidiaGPUs = await this.detectNVIDIAGPUs();
    gpus.push(...nvidiaGPUs);
    
    // Try AMD detection
    const amdGPUs = await this.detectAMDGPUs();
    gpus.push(...amdGPUs);
    
    // Try Intel detection
    const intelGPUs = await this.detectIntelGPUs();
    gpus.push(...intelGPUs);
    
    return gpus;
  }
  
  /**
   * Detect NVIDIA GPUs
   */
  async detectNVIDIAGPUs() {
    const gpus = [];
    
    try {
      // Try nvidia-smi
      const { stdout } = await execAsync('nvidia-smi --query-gpu=index,name,memory.total,compute_cap --format=csv,noheader');
      
      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const [index, name, memory, computeCap] = line.split(',').map(s => s.trim());
        
        gpus.push({
          id: parseInt(index),
          vendor: 'NVIDIA',
          name: name,
          memory: parseInt(memory), // in MB
          computeCapability: computeCap,
          type: 'cuda'
        });
      }
      
      logger.debug(`Detected ${gpus.length} NVIDIA GPUs`);
    } catch (error) {
      // nvidia-smi not available
      logger.debug('NVIDIA detection failed:', error.message);
    }
    
    return gpus;
  }
  
  /**
   * Detect AMD GPUs
   */
  async detectAMDGPUs() {
    const gpus = [];
    
    try {
      // Try rocm-smi
      const { stdout } = await execAsync('rocm-smi --showid --showname --showmeminfo vram');
      
      // Parse rocm-smi output
      // This is simplified - actual parsing would be more complex
      const matches = stdout.match(/GPU\[(\d+)\].*?:\s*(.+)/g);
      
      if (matches) {
        matches.forEach((match, index) => {
          gpus.push({
            id: index,
            vendor: 'AMD',
            name: 'AMD GPU',
            memory: 4096, // Default, would parse actual value
            type: 'opencl'
          });
        });
      }
      
      logger.debug(`Detected ${gpus.length} AMD GPUs`);
    } catch (error) {
      // rocm-smi not available
      logger.debug('AMD detection failed:', error.message);
    }
    
    return gpus;
  }
  
  /**
   * Detect Intel GPUs
   */
  async detectIntelGPUs() {
    const gpus = [];
    
    try {
      // Try to detect Intel integrated graphics
      if (this.platform === 'win32') {
        const { stdout } = await execAsync('wmic path win32_VideoController get name');
        
        if (stdout.toLowerCase().includes('intel')) {
          gpus.push({
            id: 0,
            vendor: 'Intel',
            name: 'Intel Integrated Graphics',
            memory: 512, // Shared memory
            type: 'opencl'
          });
        }
      }
    } catch (error) {
      logger.debug('Intel GPU detection failed:', error.message);
    }
    
    return gpus;
  }
  
  /**
   * Detect ASICs
   */
  async detectASICs() {
    const asics = [];
    
    // Detect USB ASICs
    const usbASICs = await this.detectUSBASICs();
    asics.push(...usbASICs);
    
    // Detect network ASICs
    const networkASICs = await this.detectNetworkASICs();
    asics.push(...networkASICs);
    
    return asics;
  }
  
  /**
   * Detect USB-connected ASICs
   */
  async detectUSBASICs() {
    const asics = [];
    
    try {
      // Common ASIC USB vendor/product IDs
      const knownASICs = [
        { vendor: '10c4', product: 'ea60', name: 'Antminer U1/U2' },
        { vendor: '0403', product: '6014', name: 'BFL ASIC' },
        { vendor: '198c', product: '0001', name: 'Avalon ASIC' }
      ];
      
      let usbDevices = '';
      
      if (this.platform === 'linux') {
        const { stdout } = await execAsync('lsusb');
        usbDevices = stdout.toLowerCase();
      } else if (this.platform === 'win32') {
        try {
          const { stdout } = await execAsync('wmic path Win32_USBControllerDevice get Dependent');
          usbDevices = stdout.toLowerCase();
        } catch {
          // wmic might not be available
        }
      }
      
      // Check for known ASICs
      for (const known of knownASICs) {
        if (usbDevices.includes(known.vendor) && usbDevices.includes(known.product)) {
          asics.push({
            type: 'usb',
            model: known.name,
            vendor: known.vendor,
            product: known.product
          });
        }
      }
      
    } catch (error) {
      logger.debug('USB ASIC detection failed:', error.message);
    }
    
    return asics;
  }
  
  /**
   * Detect network-connected ASICs
   */
  async detectNetworkASICs() {
    const asics = [];
    
    // This would scan for known ASIC IP ranges or use discovery protocols
    // For now, return empty array
    
    return asics;
  }
  
  /**
   * Get hardware capabilities
   */
  static getCapabilities(hardware) {
    const capabilities = {
      algorithms: [],
      totalHashPower: 0,
      totalMemory: 0,
      totalCores: 0
    };
    
    // CPU capabilities
    if (hardware.cpu) {
      capabilities.totalCores = hardware.cpu.cores;
      capabilities.algorithms.push('randomx', 'cryptonight', 'yescrypt');
      
      if (hardware.cpu.features.aes) {
        capabilities.algorithms.push('cryptonight-aes');
      }
    }
    
    // GPU capabilities
    for (const gpu of hardware.gpus) {
      capabilities.totalMemory += gpu.memory;
      
      if (gpu.vendor === 'NVIDIA') {
        capabilities.algorithms.push('ethash', 'kawpow', 'octopus', 'autolykos2');
      } else if (gpu.vendor === 'AMD') {
        capabilities.algorithms.push('ethash', 'kawpow', 'cryptonight-gpu');
      }
    }
    
    // ASIC capabilities
    for (const asic of hardware.asics) {
      capabilities.algorithms.push('sha256', 'scrypt');
    }
    
    // Remove duplicates
    capabilities.algorithms = [...new Set(capabilities.algorithms)];
    
    return capabilities;
  }
}

export default HardwareDetector;