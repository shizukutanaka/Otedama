/**
 * Hardware Detection and Auto-Recognition
 * Following Carmack/Martin/Pike principles:
 * - Comprehensive hardware detection
 * - Clean abstraction of hardware capabilities
 * - Efficient resource allocation
 */

import * as os from 'os';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';

const execAsync = promisify(exec);

interface CPUInfo {
  model: string;
  vendor: string;
  family: number;
  cores: number;
  threads: number;
  speed: number; // MHz
  cache: {
    l1: number;
    l2: number;
    l3: number;
  };
  features: string[];
  temperature?: number;
}

interface GPUInfo {
  id: number;
  vendor: 'nvidia' | 'amd' | 'intel' | 'unknown';
  model: string;
  memory: number; // MB
  busId: string;
  driver: string;
  computeCapability?: string;
  temperature?: number;
  utilization?: number;
  powerLimit?: number;
  clockSpeed?: {
    core: number;
    memory: number;
  };
}

interface MemoryInfo {
  total: number;
  free: number;
  used: number;
  cached?: number;
  buffers?: number;
  swapTotal?: number;
  swapFree?: number;
}

interface NetworkInterface {
  name: string;
  address: string;
  netmask: string;
  mac: string;
  speed?: number; // Mbps
  type: 'ethernet' | 'wifi' | 'virtual' | 'unknown';
}

interface SystemInfo {
  platform: string;
  arch: string;
  kernel: string;
  hostname: string;
  uptime: number;
}

interface HardwareProfile {
  system: SystemInfo;
  cpu: CPUInfo;
  gpus: GPUInfo[];
  memory: MemoryInfo;
  network: NetworkInterface[];
  storage: StorageInfo[];
  capabilities: MiningCapabilities;
}

interface StorageInfo {
  device: string;
  mountpoint: string;
  fstype: string;
  size: number;
  used: number;
  available: number;
  usePercent: number;
}

interface MiningCapabilities {
  algorithms: {
    [algorithm: string]: {
      supported: boolean;
      hardware: ('cpu' | 'gpu' | 'asic')[];
      estimatedHashRate: number;
      powerConsumption: number;
    };
  };
  maxThreads: number;
  maxGPUs: number;
  totalMemory: number;
  recommendedSettings: {
    cpuThreads: number;
    gpuIntensity: number;
    memoryBuffer: number;
  };
}

export class HardwareDetector extends EventEmitter {
  private profile?: HardwareProfile;
  private monitoringInterval?: NodeJS.Timer;

  /**
   * Detect all hardware
   */
  async detect(): Promise<HardwareProfile> {
    this.emit('detection:start');

    const [system, cpu, gpus, memory, network, storage] = await Promise.all([
      this.detectSystem(),
      this.detectCPU(),
      this.detectGPUs(),
      this.detectMemory(),
      this.detectNetwork(),
      this.detectStorage()
    ]);

    const capabilities = this.analyzeMiningCapabilities({
      system, cpu, gpus, memory, network, storage
    });

    this.profile = {
      system,
      cpu,
      gpus,
      memory,
      network,
      storage,
      capabilities
    };

    this.emit('detection:complete', this.profile);
    return this.profile;
  }

  /**
   * Detect system information
   */
  private async detectSystem(): Promise<SystemInfo> {
    return {
      platform: os.platform(),
      arch: os.arch(),
      kernel: os.release(),
      hostname: os.hostname(),
      uptime: os.uptime()
    };
  }

  /**
   * Detect CPU information
   */
  private async detectCPU(): Promise<CPUInfo> {
    const cpus = os.cpus();
    const cpu = cpus[0];

    // Get CPU features
    const features = await this.getCPUFeatures();
    
    // Get cache sizes
    const cache = await this.getCPUCache();

    // Detect actual core count (physical vs logical)
    const coreInfo = await this.getCPUCoreInfo();

    return {
      model: cpu.model,
      vendor: this.detectCPUVendor(cpu.model),
      family: 0, // Would be parsed from cpuid
      cores: coreInfo.physical,
      threads: coreInfo.logical,
      speed: cpu.speed,
      cache,
      features,
      temperature: await this.getCPUTemperature()
    };
  }

  /**
   * Detect CPU vendor
   */
  private detectCPUVendor(model: string): string {
    const modelLower = model.toLowerCase();
    if (modelLower.includes('intel')) return 'Intel';
    if (modelLower.includes('amd')) return 'AMD';
    if (modelLower.includes('arm')) return 'ARM';
    return 'Unknown';
  }

  /**
   * Get CPU features
   */
  private async getCPUFeatures(): Promise<string[]> {
    const features: string[] = [];

    if (os.platform() === 'linux') {
      try {
        const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
        const flagsMatch = cpuinfo.match(/^flags\s*:\s*(.+)$/m);
        if (flagsMatch) {
          features.push(...flagsMatch[1].split(/\s+/));
        }
      } catch {
        // Fallback
      }
    } else if (os.platform() === 'win32') {
      try {
        const { stdout } = await execAsync('wmic cpu get description /value');
        // Parse Windows CPU features
      } catch {
        // Fallback
      }
    }

    // Check for important mining features
    const importantFeatures = ['aes', 'avx', 'avx2', 'sse4_1', 'sse4_2', 'ssse3'];
    return features.filter(f => importantFeatures.includes(f));
  }

  /**
   * Get CPU cache sizes
   */
  private async getCPUCache(): Promise<{ l1: number; l2: number; l3: number }> {
    // Default values
    let cache = { l1: 32, l2: 256, l3: 8192 }; // KB

    if (os.platform() === 'linux') {
      try {
        const l1 = await execAsync('getconf LEVEL1_DCACHE_SIZE 2>/dev/null || echo 32768');
        const l2 = await execAsync('getconf LEVEL2_CACHE_SIZE 2>/dev/null || echo 262144');
        const l3 = await execAsync('getconf LEVEL3_CACHE_SIZE 2>/dev/null || echo 8388608');

        cache = {
          l1: parseInt(l1.stdout) / 1024,
          l2: parseInt(l2.stdout) / 1024,
          l3: parseInt(l3.stdout) / 1024
        };
      } catch {
        // Use defaults
      }
    }

    return cache;
  }

  /**
   * Get CPU core information
   */
  private async getCPUCoreInfo(): Promise<{ physical: number; logical: number }> {
    const logical = os.cpus().length;
    let physical = logical;

    if (os.platform() === 'linux') {
      try {
        const { stdout } = await execAsync('grep "^physical id" /proc/cpuinfo | sort -u | wc -l');
        const physicalCPUs = parseInt(stdout.trim());
        const { stdout: coresPerCPU } = await execAsync('grep "^cpu cores" /proc/cpuinfo | head -1 | cut -d: -f2');
        physical = physicalCPUs * parseInt(coresPerCPU.trim());
      } catch {
        // Estimate
        physical = logical / 2;
      }
    }

    return { physical, logical };
  }

  /**
   * Get CPU temperature
   */
  private async getCPUTemperature(): Promise<number | undefined> {
    if (os.platform() === 'linux') {
      try {
        const files = fs.readdirSync('/sys/class/thermal/');
        for (const file of files) {
          if (file.startsWith('thermal_zone')) {
            const temp = fs.readFileSync(`/sys/class/thermal/${file}/temp`, 'utf8');
            return parseInt(temp) / 1000;
          }
        }
      } catch {
        // No temperature sensors
      }
    }

    return undefined;
  }

  /**
   * Detect GPUs
   */
  private async detectGPUs(): Promise<GPUInfo[]> {
    const gpus: GPUInfo[] = [];

    // Try NVIDIA detection
    try {
      const nvidiaGPUs = await this.detectNVIDIAGPUs();
      gpus.push(...nvidiaGPUs);
    } catch {
      // No NVIDIA GPUs
    }

    // Try AMD detection
    try {
      const amdGPUs = await this.detectAMDGPUs();
      gpus.push(...amdGPUs);
    } catch {
      // No AMD GPUs
    }

    // Try Intel detection
    try {
      const intelGPUs = await this.detectIntelGPUs();
      gpus.push(...intelGPUs);
    } catch {
      // No Intel GPUs
    }

    return gpus;
  }

  /**
   * Detect NVIDIA GPUs
   */
  private async detectNVIDIAGPUs(): Promise<GPUInfo[]> {
    const { stdout } = await execAsync('nvidia-smi --query-gpu=index,name,memory.total,driver_version,pci.bus_id,compute_cap,temperature.gpu,utilization.gpu,power.limit,clocks.gr,clocks.mem --format=csv,noheader,nounits');
    
    return stdout.trim().split('\n').map(line => {
      const [
        index, name, memory, driver, busId, computeCap,
        temperature, utilization, powerLimit, coreClock, memClock
      ] = line.split(', ').map(v => v.trim());

      return {
        id: parseInt(index),
        vendor: 'nvidia' as const,
        model: name,
        memory: parseInt(memory),
        busId,
        driver,
        computeCapability: computeCap,
        temperature: parseFloat(temperature),
        utilization: parseFloat(utilization),
        powerLimit: parseFloat(powerLimit),
        clockSpeed: {
          core: parseInt(coreClock),
          memory: parseInt(memClock)
        }
      };
    });
  }

  /**
   * Detect AMD GPUs
   */
  private async detectAMDGPUs(): Promise<GPUInfo[]> {
    try {
      const { stdout } = await execAsync('rocm-smi --showid --showname --showmeminfo vram --showtemp --showuse --json');
      const data = JSON.parse(stdout);
      
      // Parse AMD GPU data
      return []; // Simplified - would parse actual data
    } catch {
      // Try alternative method
      if (os.platform() === 'linux') {
        const gpus: GPUInfo[] = [];
        const pciDevices = fs.readdirSync('/sys/bus/pci/devices/');
        
        for (const device of pciDevices) {
          try {
            const vendor = fs.readFileSync(`/sys/bus/pci/devices/${device}/vendor`, 'utf8').trim();
            if (vendor === '0x1002') { // AMD vendor ID
              // This is an AMD device
              gpus.push({
                id: gpus.length,
                vendor: 'amd',
                model: 'AMD GPU',
                memory: 0,
                busId: device,
                driver: 'amdgpu',
                temperature: undefined,
                utilization: undefined
              });
            }
          } catch {
            // Skip device
          }
        }
        
        return gpus;
      }
    }
    
    return [];
  }

  /**
   * Detect Intel GPUs
   */
  private async detectIntelGPUs(): Promise<GPUInfo[]> {
    // Intel GPU detection
    return [];
  }

  /**
   * Detect memory information
   */
  private async detectMemory(): Promise<MemoryInfo> {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    const info: MemoryInfo = {
      total: totalMem,
      free: freeMem,
      used: totalMem - freeMem
    };

    // Get more detailed memory info on Linux
    if (os.platform() === 'linux') {
      try {
        const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
        const cached = meminfo.match(/^Cached:\s+(\d+)/m);
        const buffers = meminfo.match(/^Buffers:\s+(\d+)/m);
        const swapTotal = meminfo.match(/^SwapTotal:\s+(\d+)/m);
        const swapFree = meminfo.match(/^SwapFree:\s+(\d+)/m);

        if (cached) info.cached = parseInt(cached[1]) * 1024;
        if (buffers) info.buffers = parseInt(buffers[1]) * 1024;
        if (swapTotal) info.swapTotal = parseInt(swapTotal[1]) * 1024;
        if (swapFree) info.swapFree = parseInt(swapFree[1]) * 1024;
      } catch {
        // Ignore errors
      }
    }

    return info;
  }

  /**
   * Detect network interfaces
   */
  private async detectNetwork(): Promise<NetworkInterface[]> {
    const interfaces = os.networkInterfaces();
    const result: NetworkInterface[] = [];

    for (const [name, addrs] of Object.entries(interfaces)) {
      if (!addrs) continue;

      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          result.push({
            name,
            address: addr.address,
            netmask: addr.netmask,
            mac: addr.mac,
            type: this.detectNetworkType(name)
          });
        }
      }
    }

    return result;
  }

  /**
   * Detect network interface type
   */
  private detectNetworkType(name: string): 'ethernet' | 'wifi' | 'virtual' | 'unknown' {
    const nameLower = name.toLowerCase();
    
    if (nameLower.includes('eth') || nameLower.includes('en')) return 'ethernet';
    if (nameLower.includes('wlan') || nameLower.includes('wifi')) return 'wifi';
    if (nameLower.includes('vir') || nameLower.includes('br') || 
        nameLower.includes('docker') || nameLower.includes('lo')) return 'virtual';
    
    return 'unknown';
  }

  /**
   * Detect storage information
   */
  private async detectStorage(): Promise<StorageInfo[]> {
    const storage: StorageInfo[] = [];

    if (os.platform() === 'linux' || os.platform() === 'darwin') {
      try {
        const { stdout } = await execAsync('df -B1 -T | grep -v "^Filesystem"');
        const lines = stdout.trim().split('\n');

        for (const line of lines) {
          const parts = line.split(/\s+/);
          if (parts.length >= 7) {
            const [device, fstype, size, used, available, usePercent, mountpoint] = parts;
            
            storage.push({
              device,
              mountpoint,
              fstype,
              size: parseInt(size),
              used: parseInt(used),
              available: parseInt(available),
              usePercent: parseInt(usePercent)
            });
          }
        }
      } catch {
        // Fallback
      }
    } else if (os.platform() === 'win32') {
      try {
        const { stdout } = await execAsync('wmic logicaldisk get size,freespace,caption /value');
        // Parse Windows disk info
      } catch {
        // Fallback
      }
    }

    return storage;
  }

  /**
   * Analyze mining capabilities
   */
  private analyzeMiningCapabilities(hardware: Omit<HardwareProfile, 'capabilities'>): MiningCapabilities {
    const capabilities: MiningCapabilities = {
      algorithms: {},
      maxThreads: hardware.cpu.threads,
      maxGPUs: hardware.gpus.length,
      totalMemory: hardware.memory.total,
      recommendedSettings: {
        cpuThreads: Math.max(1, hardware.cpu.threads - 1),
        gpuIntensity: 80,
        memoryBuffer: hardware.memory.total * 0.2 // Keep 20% free
      }
    };

    // Analyze algorithm support
    const algorithms = [
      'sha256', 'scrypt', 'ethash', 'randomx', 'cryptonight',
      'x11', 'equihash', 'blake2s', 'argon2'
    ];

    for (const algo of algorithms) {
      capabilities.algorithms[algo] = this.analyzeAlgorithmSupport(algo, hardware);
    }

    return capabilities;
  }

  /**
   * Analyze algorithm support
   */
  private analyzeAlgorithmSupport(
    algorithm: string,
    hardware: Omit<HardwareProfile, 'capabilities'>
  ): {
    supported: boolean;
    hardware: ('cpu' | 'gpu' | 'asic')[];
    estimatedHashRate: number;
    powerConsumption: number;
  } {
    const support = {
      supported: false,
      hardware: [] as ('cpu' | 'gpu' | 'asic')[],
      estimatedHashRate: 0,
      powerConsumption: 0
    };

    // CPU support analysis
    const cpuHashRates: { [algo: string]: number } = {
      sha256: 50, // MH/s per thread
      scrypt: 0.1, // MH/s per thread
      randomx: 500, // H/s per thread
      cryptonight: 100, // H/s per thread
      argon2: 1000 // H/s per thread
    };

    if (cpuHashRates[algorithm]) {
      support.supported = true;
      support.hardware.push('cpu');
      support.estimatedHashRate += cpuHashRates[algorithm] * hardware.cpu.threads;
      support.powerConsumption += hardware.cpu.threads * 15; // 15W per thread estimate
    }

    // GPU support analysis
    if (hardware.gpus.length > 0 && algorithm !== 'randomx' && algorithm !== 'argon2') {
      support.supported = true;
      support.hardware.push('gpu');

      const gpuHashRates: { [algo: string]: number } = {
        sha256: 1000, // MH/s per GPU
        scrypt: 1, // MH/s per GPU
        ethash: 30, // MH/s per GPU
        cryptonight: 1000, // H/s per GPU
        x11: 10, // MH/s per GPU
        equihash: 300, // Sol/s per GPU
        blake2s: 2000 // MH/s per GPU
      };

      for (const gpu of hardware.gpus) {
        support.estimatedHashRate += gpuHashRates[algorithm] || 0;
        support.powerConsumption += 150; // 150W per GPU estimate
      }
    }

    return support;
  }

  /**
   * Start hardware monitoring
   */
  startMonitoring(interval: number = 5000): void {
    this.stopMonitoring();

    this.monitoringInterval = setInterval(async () => {
      if (!this.profile) return;

      // Update CPU temperature
      this.profile.cpu.temperature = await this.getCPUTemperature();

      // Update GPU stats
      for (let i = 0; i < this.profile.gpus.length; i++) {
        const gpu = this.profile.gpus[i];
        if (gpu.vendor === 'nvidia') {
          try {
            const { stdout } = await execAsync(
              `nvidia-smi -i ${gpu.id} --query-gpu=temperature.gpu,utilization.gpu --format=csv,noheader,nounits`
            );
            const [temp, util] = stdout.trim().split(', ').map(v => parseFloat(v));
            gpu.temperature = temp;
            gpu.utilization = util;
          } catch {
            // Ignore errors
          }
        }
      }

      // Update memory
      this.profile.memory = await this.detectMemory();

      this.emit('monitoring:update', this.profile);
    }, interval);
  }

  /**
   * Stop hardware monitoring
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }
  }

  /**
   * Get current hardware profile
   */
  getProfile(): HardwareProfile | undefined {
    return this.profile;
  }

  /**
   * Generate hardware report
   */
  generateReport(): string {
    if (!this.profile) {
      return 'No hardware profile available. Run detect() first.';
    }

    const p = this.profile;
    
    return `
# Hardware Detection Report

## System Information
- Platform: ${p.system.platform}
- Architecture: ${p.system.arch}
- Kernel: ${p.system.kernel}
- Hostname: ${p.system.hostname}
- Uptime: ${Math.floor(p.system.uptime / 3600)} hours

## CPU Information
- Model: ${p.cpu.model}
- Vendor: ${p.cpu.vendor}
- Physical Cores: ${p.cpu.cores}
- Logical Threads: ${p.cpu.threads}
- Speed: ${p.cpu.speed} MHz
- Cache: L1=${p.cpu.cache.l1}KB, L2=${p.cpu.cache.l2}KB, L3=${p.cpu.cache.l3}KB
- Features: ${p.cpu.features.join(', ')}
- Temperature: ${p.cpu.temperature ? p.cpu.temperature + '°C' : 'N/A'}

## GPU Information
${p.gpus.length === 0 ? 'No GPUs detected' : p.gpus.map(gpu => `
- GPU ${gpu.id}: ${gpu.model}
  - Vendor: ${gpu.vendor}
  - Memory: ${gpu.memory} MB
  - Driver: ${gpu.driver}
  - Temperature: ${gpu.temperature ? gpu.temperature + '°C' : 'N/A'}
  - Utilization: ${gpu.utilization ? gpu.utilization + '%' : 'N/A'}
`).join('\n')}

## Memory Information
- Total: ${(p.memory.total / 1024 / 1024 / 1024).toFixed(2)} GB
- Used: ${(p.memory.used / 1024 / 1024 / 1024).toFixed(2)} GB
- Free: ${(p.memory.free / 1024 / 1024 / 1024).toFixed(2)} GB

## Mining Capabilities
- Max CPU Threads: ${p.capabilities.maxThreads}
- Max GPUs: ${p.capabilities.maxGPUs}
- Recommended CPU Threads: ${p.capabilities.recommendedSettings.cpuThreads}
- Recommended GPU Intensity: ${p.capabilities.recommendedSettings.gpuIntensity}%

## Supported Algorithms
${Object.entries(p.capabilities.algorithms)
  .filter(([_, info]) => info.supported)
  .map(([algo, info]) => `- ${algo}: ${info.hardware.join(', ')} (Est. ${info.estimatedHashRate} H/s)`)
  .join('\n')}
`;
  }
}

// Export types
export { HardwareProfile, CPUInfo, GPUInfo, MiningCapabilities };
