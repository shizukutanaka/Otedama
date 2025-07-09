/**
 * CPU Affinity Manager
 * Optimizes performance by binding processes to specific CPU cores
 * Following Carmack's principle: "Optimize where it matters"
 */

import * as os from 'os';
import * as cluster from 'cluster';
import { Logger } from '../../logging/logger';

export interface CPUAffinityConfig {
  enabled: boolean;
  strategy: 'round-robin' | 'dedicated' | 'numa-aware' | 'load-balanced';
  reservedCores?: number[]; // Cores to reserve for system processes
  workerTypes: {
    shareValidation: number;    // Number of cores for share validation
    paymentProcessing: number;  // Number of cores for payment processing
    networking: number;         // Number of cores for network I/O
    database: number;          // Number of cores for database operations
  };
}

export interface CPUTopology {
  totalCores: number;
  physicalCores: number;
  threadsPerCore: number;
  numaNodes: number;
  coreMapping: Map<number, {
    physicalCore: number;
    numaNode: number;
    siblings: number[];
  }>;
}

export class CPUAffinityManager {
  private logger = new Logger('CPUAffinity');
  private topology: CPUTopology;
  private affinityMap = new Map<string, number[]>();
  private nextCoreIndex = 0;

  constructor(private config: CPUAffinityConfig) {
    this.topology = this.detectCPUTopology();
    this.initializeAffinityMapping();
  }

  /**
   * Detect CPU topology for optimal core assignment
   */
  private detectCPUTopology(): CPUTopology {
    const cpus = os.cpus();
    const totalCores = cpus.length;
    
    // Simplified topology detection
    // In a real implementation, we'd use /proc/cpuinfo on Linux
    const physicalCores = Math.max(1, Math.floor(totalCores / 2));
    const threadsPerCore = Math.floor(totalCores / physicalCores);
    const numaNodes = Math.max(1, Math.floor(physicalCores / 4));
    
    const coreMapping = new Map<number, {
      physicalCore: number;
      numaNode: number;
      siblings: number[];
    }>();
    
    for (let i = 0; i < totalCores; i++) {
      const physicalCore = Math.floor(i / threadsPerCore);
      const numaNode = Math.floor(physicalCore / (physicalCores / numaNodes));
      const siblings = [];
      
      // Find sibling threads (hyperthreads)
      for (let j = 0; j < totalCores; j++) {
        if (Math.floor(j / threadsPerCore) === physicalCore && j !== i) {
          siblings.push(j);
        }
      }
      
      coreMapping.set(i, {
        physicalCore,
        numaNode,
        siblings
      });
    }
    
    const topology: CPUTopology = {
      totalCores,
      physicalCores,
      threadsPerCore,
      numaNodes,
      coreMapping
    };
    
    this.logger.info('CPU topology detected', {
      totalCores,
      physicalCores,
      threadsPerCore,
      numaNodes
    });
    
    return topology;
  }

  /**
   * Initialize CPU affinity mapping based on strategy
   */
  private initializeAffinityMapping(): void {
    if (!this.config.enabled) {
      this.logger.info('CPU affinity disabled');
      return;
    }

    const availableCores = this.getAvailableCores();
    
    switch (this.config.strategy) {
      case 'dedicated':
        this.setupDedicatedCores(availableCores);
        break;
      case 'numa-aware':
        this.setupNUMAAwareCores(availableCores);
        break;
      case 'load-balanced':
        this.setupLoadBalancedCores(availableCores);
        break;
      default:
        this.setupRoundRobinCores(availableCores);
    }

    this.logger.info('CPU affinity mapping initialized', {
      strategy: this.config.strategy,
      mapping: Object.fromEntries(this.affinityMap)
    });
  }

  /**
   * Get available CPU cores excluding reserved ones
   */
  private getAvailableCores(): number[] {
    const allCores = Array.from({ length: this.topology.totalCores }, (_, i) => i);
    const reservedCores = this.config.reservedCores || [];
    return allCores.filter(core => !reservedCores.includes(core));
  }

  /**
   * Setup dedicated cores for each worker type
   */
  private setupDedicatedCores(availableCores: number[]): void {
    let coreIndex = 0;
    
    // Assign cores for share validation (most critical)
    const shareValidationCores = availableCores.slice(
      coreIndex, 
      coreIndex + this.config.workerTypes.shareValidation
    );
    this.affinityMap.set('shareValidation', shareValidationCores);
    coreIndex += this.config.workerTypes.shareValidation;
    
    // Assign cores for networking
    const networkingCores = availableCores.slice(
      coreIndex,
      coreIndex + this.config.workerTypes.networking
    );
    this.affinityMap.set('networking', networkingCores);
    coreIndex += this.config.workerTypes.networking;
    
    // Assign cores for payment processing
    const paymentCores = availableCores.slice(
      coreIndex,
      coreIndex + this.config.workerTypes.paymentProcessing
    );
    this.affinityMap.set('paymentProcessing', paymentCores);
    coreIndex += this.config.workerTypes.paymentProcessing;
    
    // Assign remaining cores for database
    const databaseCores = availableCores.slice(coreIndex);
    this.affinityMap.set('database', databaseCores);
  }

  /**
   * Set CPU affinity for current process (Linux/macOS only)
   */
  setProcessAffinity(workerType: string, processId?: number): boolean {
    if (!this.config.enabled) return false;
    
    const cores = this.getCoresForWorker(workerType);
    if (cores.length === 0) return false;
    
    try {
      // On Linux, we would use taskset or sched_setaffinity
      // This is a simplified version for demonstration
      if (process.platform === 'linux') {
        const { execSync } = require('child_process');
        const pid = processId || process.pid;
        const coreList = cores.join(',');
        
        execSync(`taskset -cp ${coreList} ${pid}`, { stdio: 'ignore' });
        
        this.logger.info('CPU affinity set', {
          workerType,
          processId: pid,
          cores: coreList
        });
        
        return true;
      }
    } catch (error) {
      this.logger.warn('Failed to set CPU affinity', {
        workerType,
        error: (error as Error).message
      });
    }
    
    return false;
  }

  /**
   * Get CPU cores for a specific worker type
   */
  getCoresForWorker(workerType: string): number[] {
    return this.affinityMap.get(workerType) || [];
  }

  /**
   * Setup NUMA-aware core allocation
   */
  private setupNUMAAwareCores(availableCores: number[]): void {
    const numaNodes = new Map<number, number[]>();
    
    // Group cores by NUMA node
    for (const core of availableCores) {
      const topology = this.topology.coreMapping.get(core);
      if (topology) {
        const numaNode = topology.numaNode;
        if (!numaNodes.has(numaNode)) {
          numaNodes.set(numaNode, []);
        }
        numaNodes.get(numaNode)!.push(core);
      }
    }
    
    // Distribute worker types across NUMA nodes for memory locality
    const workerTypes = Object.keys(this.config.workerTypes) as (keyof typeof this.config.workerTypes)[];
    let nodeIndex = 0;
    
    for (const workerType of workerTypes) {
      const requiredCores = this.config.workerTypes[workerType];
      const nodeArray = Array.from(numaNodes.keys());
      const selectedNode = nodeArray[nodeIndex % nodeArray.length];
      const nodeCores = numaNodes.get(selectedNode) || [];
      
      const assignedCores = nodeCores.slice(0, requiredCores);
      this.affinityMap.set(workerType, assignedCores);
      
      // Remove assigned cores from the node
      numaNodes.set(selectedNode, nodeCores.slice(requiredCores));
      nodeIndex++;
    }
  }

  /**
   * Setup load-balanced core allocation
   */
  private setupLoadBalancedCores(availableCores: number[]): void {
    // All worker types share all available cores for maximum flexibility
    for (const workerType of Object.keys(this.config.workerTypes)) {
      this.affinityMap.set(workerType, [...availableCores]);
    }
  }

  /**
   * Setup round-robin core allocation
   */
  private setupRoundRobinCores(availableCores: number[]): void {
    const coresPerWorker = Math.floor(availableCores.length / Object.keys(this.config.workerTypes).length);
    let coreIndex = 0;
    
    for (const workerType of Object.keys(this.config.workerTypes)) {
      const assignedCores = availableCores.slice(coreIndex, coreIndex + coresPerWorker);
      this.affinityMap.set(workerType, assignedCores);
      coreIndex += coresPerWorker;
    }
  }
}

/**
 * Create CPU affinity manager with optimal configuration
 */
export function createCPUAffinityManager(config?: Partial<CPUAffinityConfig>): CPUAffinityManager {
  const cpuCount = os.cpus().length;
  
  const defaultConfig: CPUAffinityConfig = {
    enabled: process.env.CPU_AFFINITY_ENABLED !== 'false',
    strategy: (process.env.CPU_AFFINITY_STRATEGY as any) || 'numa-aware',
    reservedCores: process.env.CPU_RESERVED_CORES ? 
      process.env.CPU_RESERVED_CORES.split(',').map(Number) : 
      [0], // Reserve core 0 for system
    workerTypes: {
      shareValidation: Math.max(1, Math.floor(cpuCount * 0.4)), // 40% for share validation
      networking: Math.max(1, Math.floor(cpuCount * 0.2)),      // 20% for networking
      paymentProcessing: Math.max(1, Math.floor(cpuCount * 0.2)), // 20% for payments
      database: Math.max(1, Math.floor(cpuCount * 0.2))          // 20% for database
    }
  };
  
  const finalConfig = { ...defaultConfig, ...config };
  
  return new CPUAffinityManager(finalConfig);
}
