/**
 * CPU Affinity Manager for Otedama
 * Optimizes CPU usage by binding processes to specific cores
 */

import { cpus } from 'os';
import cluster from 'cluster';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../core/logger.js';

const execAsync = promisify(exec);

export class CPUAffinityManager {
    constructor(options = {}) {
        this.options = {
            enableAffinity: options.enableAffinity !== false,
            reserveManagementCore: options.reserveManagementCore !== false,
            coreAllocation: options.coreAllocation || 'balanced',
            priorityBoost: options.priorityBoost !== false,
            ...options
        };

        this.cpuInfo = cpus();
        this.coreCount = this.cpuInfo.length;
        this.platform = process.platform;
        this.isSupported = this.checkSupport();
        this.coreAssignments = new Map();
        this.processRoles = new Map();
    }

    /**
     * Check if CPU affinity is supported on this platform
     */
    checkSupport() {
        // CPU affinity is primarily supported on Linux
        // Windows has some support via start /affinity
        // macOS doesn't have direct affinity support
        return this.platform === 'linux' || this.platform === 'win32';
    }

    /**
     * Initialize CPU affinity management
     */
    async initialize() {
        if (!this.isSupported || !this.options.enableAffinity) {
            logger.info(`CPU affinity not ${this.isSupported ? 'enabled' : 'supported'} on ${this.platform}`);
            return false;
        }

        try {
            // Detect CPU topology
            await this.detectTopology();

            // Plan core allocation
            this.planCoreAllocation();

            // Apply affinity to main process
            if (cluster.isPrimary || cluster.isMaster) {
                await this.setProcessAffinity(process.pid, this.coreAssignments.get('master'));
            }

            logger.info('CPU affinity manager initialized', {
                cores: this.coreCount,
                allocation: this.options.coreAllocation,
                assignments: Object.fromEntries(this.coreAssignments)
            });

            return true;
        } catch (error) {
            logger.error('Failed to initialize CPU affinity:', error);
            return false;
        }
    }

    /**
     * Detect CPU topology (NUMA nodes, cache levels, etc.)
     */
    async detectTopology() {
        this.topology = {
            cores: this.coreCount,
            physicalCores: this.coreCount / 2, // Assume hyperthreading
            numaNodes: 1,
            cacheInfo: {}
        };

        if (this.platform === 'linux') {
            try {
                // Check for NUMA nodes
                const { stdout: numaOutput } = await execAsync('lscpu | grep "NUMA node" | wc -l').catch(() => ({ stdout: '1' }));
                this.topology.numaNodes = parseInt(numaOutput.trim()) || 1;

                // Get cache information
                const { stdout: cacheOutput } = await execAsync('lscpu | grep cache').catch(() => ({ stdout: '' }));
                if (cacheOutput) {
                    const lines = cacheOutput.split('\n');
                    lines.forEach(line => {
                        const match = line.match(/L(\d+)\s+cache:\s+(\d+)K/);
                        if (match) {
                            this.topology.cacheInfo[`L${match[1]}`] = parseInt(match[2]) * 1024;
                        }
                    });
                }

                // Detect physical vs logical cores
                const { stdout: coreOutput } = await execAsync('lscpu | grep "Core(s) per socket"').catch(() => ({ stdout: '' }));
                if (coreOutput) {
                    const match = coreOutput.match(/(\d+)/);
                    if (match) {
                        this.topology.physicalCores = parseInt(match[1]);
                    }
                }
            } catch (error) {
                logger.debug('Could not detect detailed CPU topology:', error.message);
            }
        }
    }

    /**
     * Plan core allocation based on strategy
     */
    planCoreAllocation() {
        const availableCores = [];
        const startCore = this.options.reserveManagementCore ? 1 : 0;

        for (let i = startCore; i < this.coreCount; i++) {
            availableCores.push(i);
        }

        switch (this.options.coreAllocation) {
            case 'dedicated':
                this.planDedicatedAllocation(availableCores);
                break;
            
            case 'numa-aware':
                this.planNumaAwareAllocation(availableCores);
                break;
            
            case 'cache-aware':
                this.planCacheAwareAllocation(availableCores);
                break;
            
            case 'balanced':
            default:
                this.planBalancedAllocation(availableCores);
                break;
        }

        // Reserve core 0 for management if requested
        if (this.options.reserveManagementCore) {
            this.coreAssignments.set('master', [0]);
            this.coreAssignments.set('management', [0]);
        }
    }

    /**
     * Plan balanced core allocation
     */
    planBalancedAllocation(availableCores) {
        const coresPerRole = {
            mining: Math.floor(availableCores.length * 0.4),
            dex: Math.floor(availableCores.length * 0.3),
            api: Math.floor(availableCores.length * 0.2),
            background: Math.floor(availableCores.length * 0.1)
        };

        let coreIndex = 0;
        
        // Allocate cores for each role
        for (const [role, count] of Object.entries(coresPerRole)) {
            const cores = [];
            for (let i = 0; i < count && coreIndex < availableCores.length; i++) {
                cores.push(availableCores[coreIndex++]);
            }
            if (cores.length > 0) {
                this.coreAssignments.set(role, cores);
            }
        }

        // Assign remaining cores to mining
        if (coreIndex < availableCores.length) {
            const miningCores = this.coreAssignments.get('mining') || [];
            while (coreIndex < availableCores.length) {
                miningCores.push(availableCores[coreIndex++]);
            }
            this.coreAssignments.set('mining', miningCores);
        }
    }

    /**
     * Plan dedicated core allocation (one service per core)
     */
    planDedicatedAllocation(availableCores) {
        const roles = ['mining', 'dex', 'api', 'websocket', 'database', 'background'];
        let coreIndex = 0;

        for (const role of roles) {
            if (coreIndex < availableCores.length) {
                this.coreAssignments.set(role, [availableCores[coreIndex++]]);
            }
        }

        // Assign remaining cores to mining
        if (coreIndex < availableCores.length) {
            const miningCores = this.coreAssignments.get('mining');
            while (coreIndex < availableCores.length) {
                miningCores.push(availableCores[coreIndex++]);
            }
        }
    }

    /**
     * Plan NUMA-aware allocation
     */
    planNumaAwareAllocation(availableCores) {
        if (this.topology.numaNodes <= 1) {
            return this.planBalancedAllocation(availableCores);
        }

        // Distribute cores across NUMA nodes
        const coresPerNode = Math.floor(availableCores.length / this.topology.numaNodes);
        const nodeAssignments = [];

        for (let node = 0; node < this.topology.numaNodes; node++) {
            const nodeCores = [];
            for (let i = 0; i < coresPerNode; i++) {
                const coreIndex = node * coresPerNode + i;
                if (coreIndex < availableCores.length) {
                    nodeCores.push(availableCores[coreIndex]);
                }
            }
            nodeAssignments.push(nodeCores);
        }

        // Assign critical services to first NUMA node
        this.coreAssignments.set('mining', nodeAssignments[0]);
        if (nodeAssignments.length > 1) {
            this.coreAssignments.set('dex', nodeAssignments[1].slice(0, Math.floor(nodeAssignments[1].length / 2)));
            this.coreAssignments.set('api', nodeAssignments[1].slice(Math.floor(nodeAssignments[1].length / 2)));
        }
    }

    /**
     * Plan cache-aware allocation (group related services)
     */
    planCacheAwareAllocation(availableCores) {
        // Group services that share data
        const groups = [
            ['mining', 'share-validation'],
            ['dex', 'order-matching'],
            ['api', 'websocket'],
            ['database', 'cache']
        ];

        let coreIndex = 0;
        const coresPerGroup = Math.floor(availableCores.length / groups.length);

        for (const group of groups) {
            const groupCores = [];
            for (let i = 0; i < coresPerGroup && coreIndex < availableCores.length; i++) {
                groupCores.push(availableCores[coreIndex++]);
            }

            // Distribute cores among services in the group
            const coresPerService = Math.floor(groupCores.length / group.length);
            let serviceCoreIndex = 0;

            for (const service of group) {
                const serviceCores = [];
                for (let i = 0; i < coresPerService && serviceCoreIndex < groupCores.length; i++) {
                    serviceCores.push(groupCores[serviceCoreIndex++]);
                }
                if (serviceCores.length > 0) {
                    this.coreAssignments.set(service, serviceCores);
                }
            }
        }
    }

    /**
     * Set CPU affinity for a process
     */
    async setProcessAffinity(pid, cores) {
        if (!cores || cores.length === 0) return false;

        try {
            if (this.platform === 'linux') {
                // Use taskset command on Linux
                const coreMask = this.createCoreMask(cores);
                await execAsync(`taskset -cp ${cores.join(',')} ${pid}`);
                
                // Set nice priority if requested
                if (this.options.priorityBoost) {
                    const nice = this.getNiceValue(this.getProcessRole(pid));
                    await execAsync(`renice -n ${nice} -p ${pid}`).catch(() => {});
                }
                
                return true;
            } else if (this.platform === 'win32') {
                // Use PowerShell on Windows
                const affinity = this.createAffinityMask(cores);
                await execAsync(
                    `powershell -Command "$p = Get-Process -Id ${pid}; $p.ProcessorAffinity = ${affinity}"`
                );
                return true;
            }
        } catch (error) {
            logger.error(`Failed to set affinity for PID ${pid}:`, error.message);
        }

        return false;
    }

    /**
     * Register a process with a role
     */
    registerProcess(pid, role) {
        this.processRoles.set(pid, role);
        const cores = this.coreAssignments.get(role);
        
        if (cores && cores.length > 0) {
            this.setProcessAffinity(pid, cores);
            logger.debug(`Assigned PID ${pid} (${role}) to cores ${cores.join(',')}`);
        }
    }

    /**
     * Get process role
     */
    getProcessRole(pid) {
        return this.processRoles.get(pid) || 'default';
    }

    /**
     * Get nice value for role
     */
    getNiceValue(role) {
        const priorities = {
            mining: -5,      // Higher priority
            dex: -3,         // High priority
            api: 0,          // Normal priority
            websocket: 0,    // Normal priority
            database: -2,    // Slightly higher priority
            background: 10,  // Lower priority
            default: 0
        };

        return priorities[role] || 0;
    }

    /**
     * Create core mask for Linux
     */
    createCoreMask(cores) {
        let mask = 0;
        for (const core of cores) {
            mask |= (1 << core);
        }
        return mask.toString(16);
    }

    /**
     * Create affinity mask for Windows
     */
    createAffinityMask(cores) {
        let mask = 0;
        for (const core of cores) {
            mask |= (1 << core);
        }
        return mask;
    }

    /**
     * Get affinity recommendations
     */
    getRecommendations() {
        const recommendations = [];

        // Check if hyperthreading is being used efficiently
        if (this.topology.physicalCores < this.coreCount) {
            recommendations.push({
                type: 'hyperthreading',
                message: 'Hyperthreading detected. Consider disabling for consistent performance.',
                impact: 'medium'
            });
        }

        // Check for NUMA nodes
        if (this.topology.numaNodes > 1) {
            recommendations.push({
                type: 'numa',
                message: `${this.topology.numaNodes} NUMA nodes detected. Use numa-aware allocation.`,
                impact: 'high'
            });
        }

        // Check core allocation
        const totalAllocated = Array.from(this.coreAssignments.values())
            .reduce((sum, cores) => sum + cores.length, 0);
        
        if (totalAllocated < this.coreCount * 0.8) {
            recommendations.push({
                type: 'underutilization',
                message: 'Some CPU cores are not allocated. Consider increasing allocation.',
                impact: 'low'
            });
        }

        return recommendations;
    }

    /**
     * Get current CPU statistics per role
     */
    async getCPUStats() {
        const stats = {};

        for (const [role, cores] of this.coreAssignments) {
            stats[role] = {
                cores: cores,
                count: cores.length,
                usage: await this.getCoreUsage(cores)
            };
        }

        return stats;
    }

    /**
     * Get CPU usage for specific cores
     */
    async getCoreUsage(cores) {
        // This would need platform-specific implementation
        // For now, return mock data
        return {
            average: Math.random() * 100,
            max: Math.random() * 100,
            min: Math.random() * 100
        };
    }

    /**
     * Rebalance core allocation based on current load
     */
    async rebalance() {
        const stats = await this.getCPUStats();
        const rebalanceNeeded = false;

        // Analyze current usage and determine if rebalancing is needed
        for (const [role, stat] of Object.entries(stats)) {
            if (stat.usage.average > 90) {
                logger.warn(`High CPU usage for ${role}: ${stat.usage.average}%`);
                // Could trigger rebalancing logic here
            }
        }

        if (rebalanceNeeded) {
            logger.info('CPU rebalancing initiated');
            // Implement rebalancing logic
        }

        return stats;
    }
}

export default CPUAffinityManager;