/**
 * Automation Systems Index - Otedama
 * Central hub for all automation features
 */

export { AutomatedDeploymentSystem } from './auto-deploy.js';
export { BackupRecovery as AutomatedBackupSystem } from '../core/backup-recovery.js';
export { AutoPerformanceTuning } from './auto-performance-tuning.js';
export { AutomatedSecurityMonitor } from './auto-security-monitor.js';

// Convenience function to initialize all automation systems
export async function initializeAutomation(poolManager, config = {}) {
  const systems = {};
  
  // Deployment system
  if (config.enableAutoDeployment !== false) {
    const { AutomatedDeploymentSystem } = await import('./auto-deploy.js');
    systems.deployment = new AutomatedDeploymentSystem(config.deployment);
    await systems.deployment.initialize();
  }
  
  // Backup system
  if (config.enableAutoBackup !== false) {
    const { BackupRecovery: AutomatedBackupSystem } = await import('../core/backup-recovery.js');
    systems.backup = new AutomatedBackupSystem(config.backup);
    await systems.backup.initialize();
  }
  
  // Performance tuning
  if (config.enableAutoTuning !== false) {
    const { AutoPerformanceTuning } = await import('./auto-performance-tuning.js');
    systems.tuning = new AutoPerformanceTuning(poolManager, config.tuning);
    systems.tuning.start();
  }
  
  // Security monitoring
  if (config.enableSecurityMonitoring !== false) {
    const { AutomatedSecurityMonitor } = await import('./auto-security-monitor.js');
    systems.security = new AutomatedSecurityMonitor(poolManager, config.security);
    systems.security.start();
  }
  
  return systems;
}

export default {
  initializeAutomation
};
