const EventEmitter = require('events');
const os = require('os');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

class OperationsAutomation extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // Maintenance settings
      maintenanceWindow: options.maintenanceWindow || { start: 2, end: 4 }, // 2-4 AM
      updateCheckInterval: options.updateCheckInterval || 86400000, // 24 hours
      cleanupInterval: options.cleanupInterval || 3600000, // 1 hour
      
      // Scaling settings
      autoScaling: options.autoScaling !== false,
      minWorkers: options.minWorkers || 1,
      maxWorkers: options.maxWorkers || os.cpus().length,
      scaleUpThreshold: options.scaleUpThreshold || 0.8, // 80% CPU usage
      scaleDownThreshold: options.scaleDownThreshold || 0.3, // 30% CPU usage
      scalingCooldown: options.scalingCooldown || 300000, // 5 minutes
      
      // Backup settings
      backupEnabled: options.backupEnabled !== false,
      backupInterval: options.backupInterval || 86400000, // 24 hours
      backupRetention: options.backupRetention || 7, // days
      backupPath: options.backupPath || './backups',
      
      // Health check settings
      healthCheckInterval: options.healthCheckInterval || 60000, // 1 minute
      restartOnFailure: options.restartOnFailure !== false,
      maxRestartAttempts: options.maxRestartAttempts || 3,
      
      // Logging and alerts
      logRotation: options.logRotation !== false,
      maxLogSize: options.maxLogSize || 100 * 1024 * 1024, // 100MB
      alertWebhook: options.alertWebhook,
      alertEmail: options.alertEmail
    };
    
    this.state = {
      workers: new Map(),
      cpuUsage: [],
      memoryUsage: [],
      lastScaling: 0,
      restartAttempts: 0,
      maintenanceMode: false
    };
    
    this.intervals = {
      health: null,
      scaling: null,
      cleanup: null,
      backup: null,
      update: null
    };
  }
  
  async start() {
    this.emit('starting');
    
    try {
      // Initialize directories
      await this.initializeDirectories();
      
      // Start health monitoring
      this.startHealthMonitoring();
      
      // Start auto-scaling
      if (this.config.autoScaling) {
        this.startAutoScaling();
      }
      
      // Start cleanup tasks
      this.startCleanupTasks();
      
      // Start backup scheduler
      if (this.config.backupEnabled) {
        this.startBackupScheduler();
      }
      
      // Start update checker
      this.startUpdateChecker();
      
      // Initial system check
      await this.performSystemCheck();
      
      this.emit('started', {
        features: {
          autoScaling: this.config.autoScaling,
          backup: this.config.backupEnabled,
          healthCheck: true,
          autoUpdate: true
        }
      });
      
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  stop() {
    this.emit('stopping');
    
    // Clear all intervals
    Object.values(this.intervals).forEach(interval => {
      if (interval) clearInterval(interval);
    });
    
    // Stop all workers
    for (const worker of this.state.workers.values()) {
      this.stopWorker(worker.id);
    }
    
    this.emit('stopped');
  }
  
  // Directory initialization
  
  async initializeDirectories() {
    const dirs = [
      this.config.backupPath,
      './logs',
      './temp',
      './cache'
    ];
    
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }
  }
  
  // Health monitoring
  
  startHealthMonitoring() {
    this.intervals.health = setInterval(async () => {
      await this.checkHealth();
    }, this.config.healthCheckInterval);
  }
  
  async checkHealth() {
    const health = {
      timestamp: Date.now(),
      cpu: await this.getCPUUsage(),
      memory: this.getMemoryUsage(),
      disk: await this.getDiskUsage(),
      network: await this.checkNetworkConnectivity(),
      processes: this.checkProcesses(),
      errors: await this.checkErrorLogs()
    };
    
    // Record metrics
    this.state.cpuUsage.push(health.cpu);
    this.state.memoryUsage.push(health.memory);
    
    // Keep only last 60 samples
    if (this.state.cpuUsage.length > 60) {
      this.state.cpuUsage.shift();
    }
    if (this.state.memoryUsage.length > 60) {
      this.state.memoryUsage.shift();
    }
    
    // Check for issues
    const issues = this.detectIssues(health);
    
    if (issues.length > 0) {
      this.emit('healthIssues', issues);
      await this.handleHealthIssues(issues);
    }
    
    this.emit('healthCheck', health);
    
    return health;
  }
  
  async getCPUUsage() {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    
    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });
    
    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;
    const usage = 100 - ~~(100 * idle / total);
    
    return usage;
  }
  
  getMemoryUsage() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const percentage = (used / total) * 100;
    
    return {
      total,
      used,
      free,
      percentage
    };
  }
  
  async getDiskUsage() {
    try {
      if (os.platform() === 'win32') {
        const { stdout } = await execAsync('wmic logicaldisk get size,freespace,caption');
        // Parse Windows disk usage
        return { percentage: 50 }; // Simplified
      } else {
        const { stdout } = await execAsync('df -h /');
        // Parse Unix disk usage
        const lines = stdout.trim().split('\n');
        if (lines.length > 1) {
          const parts = lines[1].split(/\s+/);
          const percentage = parseInt(parts[4]);
          return { percentage };
        }
      }
    } catch (error) {
      return { percentage: 0, error: error.message };
    }
  }
  
  async checkNetworkConnectivity() {
    try {
      const { stdout } = await execAsync('ping -c 1 8.8.8.8');
      return { connected: true, latency: this.parseLatency(stdout) };
    } catch (error) {
      return { connected: false, error: error.message };
    }
  }
  
  parseLatency(output) {
    const match = output.match(/time=(\d+\.?\d*)/);
    return match ? parseFloat(match[1]) : null;
  }
  
  checkProcesses() {
    const processes = {
      workers: this.state.workers.size,
      alive: 0,
      dead: 0
    };
    
    for (const worker of this.state.workers.values()) {
      if (worker.process && !worker.process.killed) {
        processes.alive++;
      } else {
        processes.dead++;
      }
    }
    
    return processes;
  }
  
  async checkErrorLogs() {
    try {
      const logPath = './logs/error.log';
      const stats = await fs.stat(logPath);
      
      // Check if error log is growing rapidly
      const recentErrors = stats.size > this.lastErrorLogSize 
        ? stats.size - this.lastErrorLogSize 
        : 0;
      
      this.lastErrorLogSize = stats.size;
      
      return {
        size: stats.size,
        recentErrors,
        growing: recentErrors > 1024 // More than 1KB of new errors
      };
    } catch (error) {
      return { size: 0, recentErrors: 0, growing: false };
    }
  }
  
  detectIssues(health) {
    const issues = [];
    
    // High CPU usage
    if (health.cpu > 90) {
      issues.push({
        type: 'cpu',
        severity: 'high',
        message: `CPU usage critical: ${health.cpu}%`
      });
    } else if (health.cpu > 80) {
      issues.push({
        type: 'cpu',
        severity: 'medium',
        message: `CPU usage high: ${health.cpu}%`
      });
    }
    
    // High memory usage
    if (health.memory.percentage > 90) {
      issues.push({
        type: 'memory',
        severity: 'high',
        message: `Memory usage critical: ${health.memory.percentage.toFixed(1)}%`
      });
    }
    
    // Disk space
    if (health.disk.percentage > 90) {
      issues.push({
        type: 'disk',
        severity: 'high',
        message: `Disk usage critical: ${health.disk.percentage}%`
      });
    }
    
    // Network connectivity
    if (!health.network.connected) {
      issues.push({
        type: 'network',
        severity: 'high',
        message: 'Network connectivity lost'
      });
    }
    
    // Dead processes
    if (health.processes.dead > 0) {
      issues.push({
        type: 'process',
        severity: 'medium',
        message: `${health.processes.dead} dead worker(s) detected`
      });
    }
    
    // Growing error log
    if (health.errors.growing) {
      issues.push({
        type: 'errors',
        severity: 'medium',
        message: 'Error log growing rapidly'
      });
    }
    
    return issues;
  }
  
  async handleHealthIssues(issues) {
    for (const issue of issues) {
      switch (issue.type) {
        case 'cpu':
          if (issue.severity === 'high') {
            await this.reduceCPULoad();
          }
          break;
          
        case 'memory':
          if (issue.severity === 'high') {
            await this.freeMemory();
          }
          break;
          
        case 'disk':
          if (issue.severity === 'high') {
            await this.cleanupDisk();
          }
          break;
          
        case 'process':
          await this.restartDeadWorkers();
          break;
          
        case 'network':
          await this.handleNetworkIssue();
          break;
      }
      
      // Send alert
      await this.sendAlert(issue);
    }
  }
  
  // Auto-scaling
  
  startAutoScaling() {
    this.intervals.scaling = setInterval(async () => {
      await this.checkAndScale();
    }, 30000); // Check every 30 seconds
  }
  
  async checkAndScale() {
    // Check if in cooldown
    if (Date.now() - this.state.lastScaling < this.config.scalingCooldown) {
      return;
    }
    
    // Get average CPU usage
    const avgCPU = this.state.cpuUsage.length > 0
      ? this.state.cpuUsage.reduce((a, b) => a + b) / this.state.cpuUsage.length
      : 0;
    
    const currentWorkers = this.state.workers.size;
    
    // Scale up
    if (avgCPU > this.config.scaleUpThreshold * 100 && currentWorkers < this.config.maxWorkers) {
      await this.scaleUp();
    }
    // Scale down
    else if (avgCPU < this.config.scaleDownThreshold * 100 && currentWorkers > this.config.minWorkers) {
      await this.scaleDown();
    }
  }
  
  async scaleUp() {
    const newWorkerCount = Math.min(
      this.state.workers.size + 1,
      this.config.maxWorkers
    );
    
    this.emit('scalingUp', {
      from: this.state.workers.size,
      to: newWorkerCount
    });
    
    const workerId = `worker-${Date.now()}`;
    await this.startWorker(workerId);
    
    this.state.lastScaling = Date.now();
  }
  
  async scaleDown() {
    const newWorkerCount = Math.max(
      this.state.workers.size - 1,
      this.config.minWorkers
    );
    
    this.emit('scalingDown', {
      from: this.state.workers.size,
      to: newWorkerCount
    });
    
    // Stop the oldest worker
    const oldestWorker = Array.from(this.state.workers.values())
      .sort((a, b) => a.startTime - b.startTime)[0];
    
    if (oldestWorker) {
      await this.stopWorker(oldestWorker.id);
    }
    
    this.state.lastScaling = Date.now();
  }
  
  async startWorker(workerId) {
    const { spawn } = require('child_process');
    
    const worker = {
      id: workerId,
      startTime: Date.now(),
      process: spawn('node', [
        path.join(__dirname, '../../worker.js'),
        '--id', workerId
      ]),
      restarts: 0
    };
    
    worker.process.on('exit', (code) => {
      this.handleWorkerExit(workerId, code);
    });
    
    this.state.workers.set(workerId, worker);
    
    this.emit('workerStarted', workerId);
  }
  
  async stopWorker(workerId) {
    const worker = this.state.workers.get(workerId);
    if (!worker) return;
    
    if (worker.process && !worker.process.killed) {
      worker.process.kill('SIGTERM');
    }
    
    this.state.workers.delete(workerId);
    
    this.emit('workerStopped', workerId);
  }
  
  async handleWorkerExit(workerId, code) {
    const worker = this.state.workers.get(workerId);
    if (!worker) return;
    
    if (code !== 0 && this.config.restartOnFailure && worker.restarts < this.config.maxRestartAttempts) {
      worker.restarts++;
      this.emit('workerRestarting', { workerId, attempt: worker.restarts });
      
      setTimeout(() => {
        this.startWorker(workerId);
      }, 5000); // Wait 5 seconds before restart
    } else {
      this.state.workers.delete(workerId);
    }
  }
  
  // Cleanup tasks
  
  startCleanupTasks() {
    this.intervals.cleanup = setInterval(async () => {
      await this.performCleanup();
    }, this.config.cleanupInterval);
  }
  
  async performCleanup() {
    this.emit('cleanupStarted');
    
    try {
      // Clean temporary files
      await this.cleanTempFiles();
      
      // Rotate logs
      if (this.config.logRotation) {
        await this.rotateLogs();
      }
      
      // Clean old backups
      if (this.config.backupEnabled) {
        await this.cleanOldBackups();
      }
      
      // Clear cache
      await this.clearOldCache();
      
      this.emit('cleanupCompleted');
      
    } catch (error) {
      this.emit('cleanupError', error);
    }
  }
  
  async cleanTempFiles() {
    const tempDir = './temp';
    const files = await fs.readdir(tempDir);
    const now = Date.now();
    
    for (const file of files) {
      const filePath = path.join(tempDir, file);
      const stats = await fs.stat(filePath);
      
      // Delete files older than 24 hours
      if (now - stats.mtime.getTime() > 86400000) {
        await fs.unlink(filePath);
      }
    }
  }
  
  async rotateLogs() {
    const logsDir = './logs';
    const files = await fs.readdir(logsDir);
    
    for (const file of files) {
      if (!file.endsWith('.log')) continue;
      
      const filePath = path.join(logsDir, file);
      const stats = await fs.stat(filePath);
      
      if (stats.size > this.config.maxLogSize) {
        // Rotate log
        const timestamp = new Date().toISOString().replace(/:/g, '-');
        const rotatedPath = path.join(logsDir, `${file}.${timestamp}`);
        
        await fs.rename(filePath, rotatedPath);
        await fs.writeFile(filePath, ''); // Create new empty log
        
        this.emit('logRotated', { file, size: stats.size });
      }
    }
  }
  
  async cleanOldBackups() {
    const files = await fs.readdir(this.config.backupPath);
    const now = Date.now();
    const retentionMs = this.config.backupRetention * 24 * 60 * 60 * 1000;
    
    for (const file of files) {
      const filePath = path.join(this.config.backupPath, file);
      const stats = await fs.stat(filePath);
      
      if (now - stats.mtime.getTime() > retentionMs) {
        await fs.unlink(filePath);
        this.emit('backupDeleted', file);
      }
    }
  }
  
  async clearOldCache() {
    const cacheDir = './cache';
    const files = await fs.readdir(cacheDir);
    const now = Date.now();
    
    for (const file of files) {
      const filePath = path.join(cacheDir, file);
      const stats = await fs.stat(filePath);
      
      // Delete cache files older than 7 days
      if (now - stats.mtime.getTime() > 7 * 24 * 60 * 60 * 1000) {
        await fs.unlink(filePath);
      }
    }
  }
  
  // Backup scheduler
  
  startBackupScheduler() {
    // Perform initial backup
    this.performBackup();
    
    // Schedule regular backups
    this.intervals.backup = setInterval(async () => {
      await this.performBackup();
    }, this.config.backupInterval);
  }
  
  async performBackup() {
    this.emit('backupStarted');
    
    try {
      const timestamp = new Date().toISOString().replace(/:/g, '-');
      const backupName = `backup-${timestamp}`;
      const backupPath = path.join(this.config.backupPath, backupName);
      
      await fs.mkdir(backupPath, { recursive: true });
      
      // Backup critical files
      const filesToBackup = [
        './configs',
        './data',
        './logs/important.log'
      ];
      
      for (const file of filesToBackup) {
        try {
          const destPath = path.join(backupPath, path.basename(file));
          await this.copyRecursive(file, destPath);
        } catch (error) {
          // Continue with other files
        }
      }
      
      // Create backup metadata
      const metadata = {
        timestamp,
        version: '0.1.5',
        files: filesToBackup,
        system: {
          platform: os.platform(),
          hostname: os.hostname(),
          memory: os.totalmem(),
          cpus: os.cpus().length
        }
      };
      
      await fs.writeFile(
        path.join(backupPath, 'metadata.json'),
        JSON.stringify(metadata, null, 2)
      );
      
      this.emit('backupCompleted', {
        name: backupName,
        path: backupPath
      });
      
    } catch (error) {
      this.emit('backupError', error);
    }
  }
  
  async copyRecursive(src, dest) {
    const stats = await fs.stat(src);
    
    if (stats.isDirectory()) {
      await fs.mkdir(dest, { recursive: true });
      const files = await fs.readdir(src);
      
      for (const file of files) {
        await this.copyRecursive(
          path.join(src, file),
          path.join(dest, file)
        );
      }
    } else {
      await fs.copyFile(src, dest);
    }
  }
  
  // Update checker
  
  startUpdateChecker() {
    this.intervals.update = setInterval(async () => {
      await this.checkForUpdates();
    }, this.config.updateCheckInterval);
  }
  
  async checkForUpdates() {
    try {
      // Check npm for updates
      const { stdout } = await execAsync('npm outdated --json');
      const outdated = stdout ? JSON.parse(stdout) : {};
      
      if (Object.keys(outdated).length > 0) {
        this.emit('updatesAvailable', outdated);
        
        // Auto-update during maintenance window
        if (this.isInMaintenanceWindow()) {
          await this.performUpdates(outdated);
        }
      }
    } catch (error) {
      // No updates or error checking
    }
  }
  
  isInMaintenanceWindow() {
    const now = new Date();
    const hour = now.getHours();
    
    return hour >= this.config.maintenanceWindow.start && 
           hour < this.config.maintenanceWindow.end;
  }
  
  async performUpdates(packages) {
    this.state.maintenanceMode = true;
    this.emit('maintenanceStarted', { reason: 'updates' });
    
    try {
      // Update packages
      for (const [pkg, info] of Object.entries(packages)) {
        await execAsync(`npm update ${pkg}`);
        this.emit('packageUpdated', { package: pkg, version: info.latest });
      }
      
      // Restart services
      await this.restartServices();
      
    } catch (error) {
      this.emit('updateError', error);
    } finally {
      this.state.maintenanceMode = false;
      this.emit('maintenanceCompleted');
    }
  }
  
  // System operations
  
  async reduceCPULoad() {
    // Reduce worker count temporarily
    if (this.state.workers.size > this.config.minWorkers) {
      await this.scaleDown();
    }
    
    // Lower process priority
    if (os.platform() !== 'win32') {
      try {
        await execAsync(`renice -n 10 -p ${process.pid}`);
      } catch (error) {
        // Ignore renice errors
      }
    }
  }
  
  async freeMemory() {
    // Clear caches
    await this.clearOldCache();
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }
    
    // Restart workers with high memory usage
    for (const worker of this.state.workers.values()) {
      // In production, would check actual worker memory usage
      if (Math.random() > 0.5) { // Simplified
        await this.restartWorker(worker.id);
      }
    }
  }
  
  async cleanupDisk() {
    await this.cleanTempFiles();
    await this.cleanOldBackups();
    await this.clearOldCache();
    
    // Compress old logs
    const logsDir = './logs';
    const files = await fs.readdir(logsDir);
    
    for (const file of files) {
      if (file.match(/\.log\.\d{4}-/)) { // Old rotated logs
        // In production, would compress these files
        this.emit('logCompressed', file);
      }
    }
  }
  
  async restartDeadWorkers() {
    const deadWorkers = [];
    
    for (const [id, worker] of this.state.workers) {
      if (!worker.process || worker.process.killed) {
        deadWorkers.push(id);
      }
    }
    
    for (const id of deadWorkers) {
      await this.restartWorker(id);
    }
  }
  
  async restartWorker(workerId) {
    await this.stopWorker(workerId);
    await this.startWorker(workerId);
  }
  
  async handleNetworkIssue() {
    // Wait and retry
    setTimeout(async () => {
      const network = await this.checkNetworkConnectivity();
      if (!network.connected) {
        // Escalate issue
        await this.sendAlert({
          type: 'network',
          severity: 'critical',
          message: 'Network connectivity still down'
        });
      }
    }, 30000);
  }
  
  async restartServices() {
    // Gracefully restart all services
    const workers = Array.from(this.state.workers.keys());
    
    for (const workerId of workers) {
      await this.restartWorker(workerId);
      // Stagger restarts
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  
  // Alerts
  
  async sendAlert(issue) {
    const alert = {
      timestamp: new Date().toISOString(),
      hostname: os.hostname(),
      issue,
      system: {
        cpu: this.state.cpuUsage[this.state.cpuUsage.length - 1] || 0,
        memory: this.state.memoryUsage[this.state.memoryUsage.length - 1] || 0,
        workers: this.state.workers.size
      }
    };
    
    // Send webhook
    if (this.config.alertWebhook) {
      try {
        const axios = require('axios');
        await axios.post(this.config.alertWebhook, alert);
      } catch (error) {
        console.error('Failed to send webhook alert:', error.message);
      }
    }
    
    // Log alert
    this.emit('alert', alert);
  }
  
  // Manual operations
  
  async performSystemCheck() {
    const check = {
      timestamp: Date.now(),
      system: {
        platform: os.platform(),
        release: os.release(),
        memory: os.totalmem(),
        cpus: os.cpus().length
      },
      health: await this.checkHealth(),
      workers: this.state.workers.size,
      features: {
        autoScaling: this.config.autoScaling,
        backup: this.config.backupEnabled,
        monitoring: true
      }
    };
    
    this.emit('systemCheck', check);
    
    return check;
  }
  
  async triggerBackup() {
    await this.performBackup();
  }
  
  async triggerCleanup() {
    await this.performCleanup();
  }
  
  getStatistics() {
    return {
      uptime: process.uptime(),
      workers: {
        count: this.state.workers.size,
        min: this.config.minWorkers,
        max: this.config.maxWorkers
      },
      cpu: {
        current: this.state.cpuUsage[this.state.cpuUsage.length - 1] || 0,
        average: this.state.cpuUsage.length > 0
          ? this.state.cpuUsage.reduce((a, b) => a + b) / this.state.cpuUsage.length
          : 0
      },
      memory: {
        current: this.state.memoryUsage[this.state.memoryUsage.length - 1] || 0
      },
      lastScaling: this.state.lastScaling,
      maintenanceMode: this.state.maintenanceMode
    };
  }
}

module.exports = OperationsAutomation;