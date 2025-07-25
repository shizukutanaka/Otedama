#!/usr/bin/env node
/**
 * System Performance Tuner for Otedama
 * Automatically applies system-level optimizations
 */

import { createStructuredLogger } from '../lib/core/structured-logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import fs from 'fs/promises';

const execAsync = promisify(exec);
const logger = createStructuredLogger('SystemTuner');

/**
 * System optimizations for mining pool
 */
class SystemTuner {
  constructor() {
    this.platform = os.platform();
    this.cpuCount = os.cpus().length;
    this.totalMemory = os.totalmem();
    this.optimizations = [];
  }
  
  /**
   * Apply all optimizations
   */
  async applyOptimizations() {
    logger.info('Starting system optimization...');
    
    try {
      // Check platform
      if (this.platform !== 'linux') {
        logger.warn(`System optimizations are only available for Linux. Current platform: ${this.platform}`);
        return;
      }
      
      // Check if running as root (required for some optimizations)
      const isRoot = process.getuid && process.getuid() === 0;
      
      if (!isRoot) {
        logger.warn('Some optimizations require root privileges. Run with sudo for full optimization.');
      }
      
      // Apply optimizations
      await this.optimizeNetworking();
      await this.optimizeFileSystem();
      await this.optimizeMemory();
      await this.optimizeCPU();
      
      // Report results
      this.reportResults();
      
    } catch (error) {
      logger.error('Optimization failed:', error);
    }
  }
  
  /**
   * Optimize networking settings
   */
  async optimizeNetworking() {
    logger.info('Optimizing network settings...');
    
    const networkSettings = [
      // Increase network buffer sizes
      { path: '/proc/sys/net/core/rmem_max', value: '134217728' },
      { path: '/proc/sys/net/core/wmem_max', value: '134217728' },
      { path: '/proc/sys/net/core/netdev_max_backlog', value: '5000' },
      
      // TCP optimizations
      { path: '/proc/sys/net/ipv4/tcp_fin_timeout', value: '30' },
      { path: '/proc/sys/net/ipv4/tcp_keepalive_time', value: '600' },
      { path: '/proc/sys/net/ipv4/tcp_max_syn_backlog', value: '8192' },
      { path: '/proc/sys/net/ipv4/tcp_tw_reuse', value: '1' },
      { path: '/proc/sys/net/ipv4/tcp_max_tw_buckets', value: '2000000' },
      
      // Connection tracking
      { path: '/proc/sys/net/netfilter/nf_conntrack_max', value: '2000000' },
      
      // Enable TCP BBR congestion control if available
      { path: '/proc/sys/net/ipv4/tcp_congestion_control', value: 'bbr' }
    ];
    
    for (const setting of networkSettings) {
      try {
        await fs.writeFile(setting.path, setting.value);
        this.optimizations.push(`Network: ${setting.path} = ${setting.value}`);
      } catch (error) {
        // Ignore errors for non-existent paths
      }
    }
    
    // Load TCP BBR module if available
    try {
      await execAsync('modprobe tcp_bbr');
      this.optimizations.push('Network: TCP BBR module loaded');
    } catch (error) {
      // BBR not available
    }
  }
  
  /**
   * Optimize file system settings
   */
  async optimizeFileSystem() {
    logger.info('Optimizing file system settings...');
    
    const fsSettings = [
      // Increase file descriptor limits
      { path: '/proc/sys/fs/file-max', value: '2000000' },
      
      // Reduce swappiness for better performance
      { path: '/proc/sys/vm/swappiness', value: '10' },
      
      // Optimize dirty page handling
      { path: '/proc/sys/vm/dirty_ratio', value: '15' },
      { path: '/proc/sys/vm/dirty_background_ratio', value: '5' }
    ];
    
    for (const setting of fsSettings) {
      try {
        await fs.writeFile(setting.path, setting.value);
        this.optimizations.push(`FileSystem: ${setting.path} = ${setting.value}`);
      } catch (error) {
        // Ignore errors
      }
    }
  }
  
  /**
   * Optimize memory settings
   */
  async optimizeMemory() {
    logger.info('Optimizing memory settings...');
    
    // Calculate huge page settings
    const hugePageSize = 2 * 1024 * 1024; // 2MB
    const desiredHugePages = Math.floor(this.totalMemory * 0.4 / hugePageSize);
    
    const memorySettings = [
      // Enable transparent huge pages
      { path: '/sys/kernel/mm/transparent_hugepage/enabled', value: 'always' },
      
      // Set number of huge pages
      { path: '/proc/sys/vm/nr_hugepages', value: desiredHugePages.toString() },
      
      // Memory overcommit
      { path: '/proc/sys/vm/overcommit_memory', value: '1' }
    ];
    
    for (const setting of memorySettings) {
      try {
        await fs.writeFile(setting.path, setting.value);
        this.optimizations.push(`Memory: ${setting.path} = ${setting.value}`);
      } catch (error) {
        // Ignore errors
      }
    }
  }
  
  /**
   * Optimize CPU settings
   */
  async optimizeCPU() {
    logger.info('Optimizing CPU settings...');
    
    // Set CPU governor to performance
    try {
      for (let i = 0; i < this.cpuCount; i++) {
        const governorPath = `/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_governor`;
        await fs.writeFile(governorPath, 'performance');
      }
      this.optimizations.push('CPU: Governor set to performance mode');
    } catch (error) {
      // CPU frequency scaling not available
    }
    
    // Disable CPU frequency scaling
    try {
      await execAsync('systemctl stop ondemand');
      this.optimizations.push('CPU: Disabled ondemand service');
    } catch (error) {
      // Service not found
    }
  }
  
  /**
   * Report optimization results
   */
  reportResults() {
    console.log('\n=== System Optimization Results ===\n');
    
    if (this.optimizations.length === 0) {
      console.log('No optimizations were applied.');
      console.log('Make sure to run as root on a Linux system.\n');
      return;
    }
    
    console.log('Applied optimizations:');
    this.optimizations.forEach(opt => {
      console.log(`  ✓ ${opt}`);
    });
    
    console.log('\nTo make these changes permanent, add them to /etc/sysctl.conf');
    console.log('\nRecommended limits for /etc/security/limits.conf:');
    console.log('  * soft nofile 1000000');
    console.log('  * hard nofile 1000000');
    console.log('  * soft nproc 1000000');
    console.log('  * hard nproc 1000000\n');
  }
  
  /**
   * Generate optimization script
   */
  async generateScript() {
    const script = `#!/bin/bash
# Otedama System Optimization Script
# Generated on ${new Date().toISOString()}

echo "Applying Otedama system optimizations..."

# Network optimizations
echo 134217728 > /proc/sys/net/core/rmem_max
echo 134217728 > /proc/sys/net/core/wmem_max
echo 5000 > /proc/sys/net/core/netdev_max_backlog
echo 30 > /proc/sys/net/ipv4/tcp_fin_timeout
echo 600 > /proc/sys/net/ipv4/tcp_keepalive_time
echo 8192 > /proc/sys/net/ipv4/tcp_max_syn_backlog
echo 1 > /proc/sys/net/ipv4/tcp_tw_reuse
echo 2000000 > /proc/sys/net/ipv4/tcp_max_tw_buckets
echo 2000000 > /proc/sys/net/netfilter/nf_conntrack_max

# Try to enable BBR
modprobe tcp_bbr 2>/dev/null
echo bbr > /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null

# File system optimizations
echo 2000000 > /proc/sys/fs/file-max
echo 10 > /proc/sys/vm/swappiness
echo 15 > /proc/sys/vm/dirty_ratio
echo 5 > /proc/sys/vm/dirty_background_ratio

# Memory optimizations
echo always > /sys/kernel/mm/transparent_hugepage/enabled
echo ${Math.floor(this.totalMemory * 0.4 / (2 * 1024 * 1024))} > /proc/sys/vm/nr_hugepages
echo 1 > /proc/sys/vm/overcommit_memory

# CPU optimizations
for i in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
  echo performance > $i 2>/dev/null
done

echo "Optimizations applied!"
`;
    
    await fs.writeFile('optimize-system.sh', script, { mode: 0o755 });
    logger.info('Generated optimization script: optimize-system.sh');
  }
}

// Run optimization
async function main() {
  const tuner = new SystemTuner();
  await tuner.applyOptimizations();
  await tuner.generateScript();
}

main().catch(error => {
  logger.error('System tuning failed:', error);
  process.exit(1);
});
