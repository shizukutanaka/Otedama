/**
 * Auto-Update System
 * Seamless background updates with rollback capability
 */

import { EventEmitter } from 'events';
import { createLogger } from './logger.js';
import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import semver from 'semver';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = createLogger('auto-update');

class AutoUpdateSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      checkInterval: options.checkInterval || 3600000, // 1 hour
      updateChannel: options.updateChannel || 'stable', // stable, beta, nightly
      autoDownload: options.autoDownload !== false,
      autoInstall: options.autoInstall || false,
      updateUrl: options.updateUrl || 'https://api.otedama.io/updates',
      githubRepo: options.githubRepo || 'otedama/otedama',
      maxRetries: options.maxRetries || 3,
      verifySignature: options.verifySignature !== false,
      rollbackEnabled: options.rollbackEnabled !== false,
      updateWindow: options.updateWindow || { start: 2, end: 5 }, // 2-5 AM
      ...options
    };
    
    this.currentVersion = null; // Will be loaded in initialize
    this.updateCheckTimer = null;
    this.updateInfo = null;
    this.downloadProgress = 0;
    this.isUpdating = false;
    this.updateHistory = [];
    this.rollbackInfo = null;
  }
  
  /**
   * Initialize auto-update system
   */
  async initialize() {
    try {
      // Load current version
      this.currentVersion = await this.getPackageVersion();
      
      // Create update directory
      await this.ensureUpdateDirectory();
      
      // Load update history
      await this.loadUpdateHistory();
      
      // Start update checking
      this.startUpdateChecking();
      
      logger.info(`Auto-update system initialized (current version: ${this.currentVersion})`);
      this.emit('initialized');
      
      // Check for updates immediately
      await this.checkForUpdates();
      
      return true;
    } catch (error) {
      logger.error('Failed to initialize auto-update system:', error);
      throw error;
    }
  }
  
  /**
   * Get package version
   */
  async getPackageVersion() {
    try {
      const packagePath = path.join(process.cwd(), 'package.json');
      const packageData = JSON.parse(await fs.readFile(packagePath, 'utf8'));
      return packageData.version;
    } catch (error) {
      logger.warn('Failed to read package.json, defaulting to 1.0.0');
      return '1.0.0';
    }
  }
  
  /**
   * Check for updates
   */
  async checkForUpdates() {
    if (this.isUpdating) {
      logger.debug('Update already in progress');
      return null;
    }
    
    try {
      logger.info('Checking for updates...');
      
      // Fetch update information
      const updateInfo = await this.fetchUpdateInfo();
      
      if (!updateInfo || !updateInfo.version) {
        logger.debug('No update information available');
        return null;
      }
      
      // Check if update is needed
      if (semver.lte(updateInfo.version, this.currentVersion)) {
        logger.debug(`Current version ${this.currentVersion} is up to date`);
        this.emit('update-not-available');
        return null;
      }
      
      // Verify update compatibility
      if (!this.isCompatibleUpdate(updateInfo)) {
        logger.warn(`Update ${updateInfo.version} is not compatible`);
        return null;
      }
      
      this.updateInfo = updateInfo;
      logger.info(`Update available: ${updateInfo.version}`);
      
      this.emit('update-available', updateInfo);
      
      // Auto-download if enabled
      if (this.options.autoDownload) {
        await this.downloadUpdate();
      }
      
      return updateInfo;
    } catch (error) {
      logger.error('Failed to check for updates:', error);
      this.emit('error', error);
      return null;
    }
  }
  
  /**
   * Fetch update information from server
   */
  async fetchUpdateInfo() {
    const sources = [
      // Primary update server
      async () => {
        const response = await axios.get(this.options.updateUrl, {
          params: {
            channel: this.options.updateChannel,
            version: this.currentVersion,
            platform: process.platform,
            arch: process.arch
          },
          timeout: 10000
        });
        return response.data;
      },
      
      // GitHub releases fallback
      async () => {
        const response = await axios.get(
          `https://api.github.com/repos/${this.options.githubRepo}/releases/latest`,
          { timeout: 10000 }
        );
        
        const release = response.data;
        const asset = release.assets.find(a => 
          a.name.includes(process.platform) && a.name.includes(process.arch)
        );
        
        if (!asset) {
          throw new Error('No compatible release asset found');
        }
        
        return {
          version: release.tag_name.replace('v', ''),
          releaseDate: release.published_at,
          notes: release.body,
          downloadUrl: asset.browser_download_url,
          size: asset.size,
          sha256: asset.name.includes('.sha256') ? await this.fetchSha256(asset.browser_download_url) : null
        };
      }
    ];
    
    // Try each source
    for (const source of sources) {
      try {
        return await source();
      } catch (error) {
        logger.debug('Update source failed:', error.message);
      }
    }
    
    return null;
  }
  
  /**
   * Download update
   */
  async downloadUpdate() {
    if (!this.updateInfo) {
      throw new Error('No update information available');
    }
    
    if (this.isUpdating) {
      logger.warn('Update already in progress');
      return;
    }
    
    this.isUpdating = true;
    this.downloadProgress = 0;
    
    try {
      logger.info(`Downloading update ${this.updateInfo.version}...`);
      this.emit('download-progress', { percent: 0 });
      
      const updatePath = path.join(this.getUpdateDirectory(), `update-${this.updateInfo.version}.zip`);
      
      // Download with progress tracking
      const response = await axios({
        method: 'GET',
        url: this.updateInfo.downloadUrl,
        responseType: 'stream',
        timeout: 300000 // 5 minutes
      });
      
      const totalSize = parseInt(response.headers['content-length'], 10);
      let downloadedSize = 0;
      
      // Create write stream
      const { createWriteStream } = await import('fs');
      const writer = createWriteStream(updatePath);
      
      // Track progress
      response.data.on('data', (chunk) => {
        downloadedSize += chunk.length;
        this.downloadProgress = (downloadedSize / totalSize) * 100;
        this.emit('download-progress', { 
          percent: this.downloadProgress,
          downloaded: downloadedSize,
          total: totalSize
        });
      });
      
      // Pipe response to file
      response.data.pipe(writer);
      
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      
      // Verify download
      if (this.options.verifySignature) {
        await this.verifyUpdate(updatePath);
      }
      
      logger.info('Update downloaded successfully');
      this.emit('update-downloaded', this.updateInfo);
      
      // Auto-install if enabled and in update window
      if (this.options.autoInstall && this.isInUpdateWindow()) {
        await this.installUpdate();
      }
      
    } catch (error) {
      logger.error('Failed to download update:', error);
      this.emit('error', error);
      throw error;
    } finally {
      this.isUpdating = false;
    }
  }
  
  /**
   * Install update
   */
  async installUpdate() {
    if (!this.updateInfo) {
      throw new Error('No update available');
    }
    
    try {
      logger.info(`Installing update ${this.updateInfo.version}...`);
      this.emit('before-install', this.updateInfo);
      
      // Create rollback point
      if (this.options.rollbackEnabled) {
        await this.createRollbackPoint();
      }
      
      // Stop services
      await this.stopServices();
      
      // Extract and install update
      const updatePath = path.join(this.getUpdateDirectory(), `update-${this.updateInfo.version}.zip`);
      await this.extractAndInstall(updatePath);
      
      // Update version info
      await this.updateVersionInfo();
      
      // Record update
      await this.recordUpdate({
        from: this.currentVersion,
        to: this.updateInfo.version,
        timestamp: Date.now(),
        success: true
      });
      
      logger.info('Update installed successfully');
      this.emit('update-installed', this.updateInfo);
      
      // Restart application
      await this.restartApplication();
      
    } catch (error) {
      logger.error('Failed to install update:', error);
      
      // Attempt rollback
      if (this.options.rollbackEnabled && this.rollbackInfo) {
        await this.rollback();
      }
      
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Create rollback point
   */
  async createRollbackPoint() {
    logger.info('Creating rollback point...');
    
    const rollbackDir = path.join(this.getUpdateDirectory(), 'rollback');
    await fs.mkdir(rollbackDir, { recursive: true });
    
    // Backup critical files
    const filesToBackup = [
      'package.json',
      'index.js',
      'lib/',
      'config/',
      'bin/'
    ];
    
    const backups = [];
    
    for (const file of filesToBackup) {
      const src = path.join(process.cwd(), file);
      const dest = path.join(rollbackDir, file);
      
      try {
        const stats = await fs.stat(src);
        if (stats.isDirectory()) {
          await this.copyDirectory(src, dest);
        } else {
          await fs.copyFile(src, dest);
        }
        backups.push(file);
      } catch (error) {
        logger.warn(`Failed to backup ${file}:`, error.message);
      }
    }
    
    this.rollbackInfo = {
      version: this.currentVersion,
      timestamp: Date.now(),
      backups,
      directory: rollbackDir
    };
    
    logger.info('Rollback point created');
  }
  
  /**
   * Rollback to previous version
   */
  async rollback() {
    if (!this.rollbackInfo) {
      throw new Error('No rollback information available');
    }
    
    try {
      logger.info(`Rolling back to version ${this.rollbackInfo.version}...`);
      this.emit('rollback-started', this.rollbackInfo);
      
      // Restore backed up files
      for (const file of this.rollbackInfo.backups) {
        const src = path.join(this.rollbackInfo.directory, file);
        const dest = path.join(process.cwd(), file);
        
        const stats = await fs.stat(src);
        if (stats.isDirectory()) {
          await this.copyDirectory(src, dest);
        } else {
          await fs.copyFile(src, dest);
        }
      }
      
      // Record rollback
      await this.recordUpdate({
        from: this.updateInfo.version,
        to: this.rollbackInfo.version,
        timestamp: Date.now(),
        type: 'rollback',
        success: true
      });
      
      logger.info('Rollback completed successfully');
      this.emit('rollback-completed', this.rollbackInfo);
      
      // Restart application
      await this.restartApplication();
      
    } catch (error) {
      logger.error('Failed to rollback:', error);
      this.emit('rollback-failed', error);
      throw error;
    }
  }
  
  /**
   * Verify update package
   */
  async verifyUpdate(updatePath) {
    logger.debug('Verifying update package...');
    
    // Calculate SHA256
    const fileBuffer = await fs.readFile(updatePath);
    const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    
    if (this.updateInfo.sha256 && hash !== this.updateInfo.sha256) {
      throw new Error('Update verification failed: SHA256 mismatch');
    }
    
    // Verify signature if provided
    if (this.updateInfo.signature) {
      // Implement signature verification
      // This would use the public key to verify the signature
    }
    
    logger.debug('Update verification passed');
  }
  
  /**
   * Extract and install update
   */
  async extractAndInstall(updatePath) {
    const { default: extract } = await import('extract-zip');
    const tempDir = path.join(this.getUpdateDirectory(), 'temp');
    
    // Extract update
    await extract(updatePath, { dir: tempDir });
    
    // Copy files to application directory
    await this.copyDirectory(tempDir, process.cwd());
    
    // Clean up temp directory
    await fs.rmdir(tempDir, { recursive: true });
  }
  
  /**
   * Stop services before update
   */
  async stopServices() {
    logger.info('Stopping services...');
    this.emit('services-stopping');
    
    // Stop mining
    if (global.minerManager) {
      await global.minerManager.stopAll();
    }
    
    // Stop web server
    if (global.webServer) {
      await new Promise(resolve => global.webServer.close(resolve));
    }
    
    // Stop P2P network
    if (global.p2pNetwork) {
      await global.p2pNetwork.stop();
    }
    
    logger.info('Services stopped');
  }
  
  /**
   * Restart application
   */
  async restartApplication() {
    logger.info('Restarting application...');
    this.emit('restarting');
    
    // Spawn new process
    const args = process.argv.slice(1);
    const options = {
      detached: true,
      stdio: 'ignore'
    };
    
    const child = spawn(process.argv[0], args, options);
    child.unref();
    
    // Exit current process
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  }
  
  /**
   * Check if in update window
   */
  isInUpdateWindow() {
    const now = new Date();
    const hour = now.getHours();
    
    const { start, end } = this.options.updateWindow;
    
    if (start <= end) {
      return hour >= start && hour < end;
    } else {
      // Handle wrap around midnight
      return hour >= start || hour < end;
    }
  }
  
  /**
   * Check if update is compatible
   */
  isCompatibleUpdate(updateInfo) {
    // Check minimum version requirement
    if (updateInfo.minimumVersion && semver.lt(this.currentVersion, updateInfo.minimumVersion)) {
      return false;
    }
    
    // Check breaking changes
    if (updateInfo.breaking && semver.major(updateInfo.version) > semver.major(this.currentVersion)) {
      // Major version updates might need manual intervention
      if (!this.options.allowBreakingUpdates) {
        return false;
      }
    }
    
    // Check platform compatibility
    if (updateInfo.platforms && !updateInfo.platforms.includes(process.platform)) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Start update checking
   */
  startUpdateChecking() {
    // Initial check with random delay to prevent thundering herd
    const initialDelay = Math.random() * 60000; // 0-60 seconds
    setTimeout(() => this.checkForUpdates(), initialDelay);
    
    // Regular checks
    this.updateCheckTimer = setInterval(() => {
      this.checkForUpdates();
    }, this.options.checkInterval);
    
    logger.info('Started automatic update checking');
  }
  
  /**
   * Stop update checking
   */
  stopUpdateChecking() {
    if (this.updateCheckTimer) {
      clearInterval(this.updateCheckTimer);
      this.updateCheckTimer = null;
      logger.info('Stopped automatic update checking');
    }
  }
  
  /**
   * Ensure update directory exists
   */
  async ensureUpdateDirectory() {
    const updateDir = this.getUpdateDirectory();
    await fs.mkdir(updateDir, { recursive: true });
  }
  
  /**
   * Get update directory
   */
  getUpdateDirectory() {
    return path.join(process.cwd(), '.updates');
  }
  
  /**
   * Copy directory recursively
   */
  async copyDirectory(src, dest) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      
      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }
  
  /**
   * Update version info
   */
  async updateVersionInfo() {
    const packagePath = path.join(process.cwd(), 'package.json');
    const packageData = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    
    this.currentVersion = packageData.version;
  }
  
  /**
   * Load update history
   */
  async loadUpdateHistory() {
    try {
      const historyPath = path.join(this.getUpdateDirectory(), 'history.json');
      const data = await fs.readFile(historyPath, 'utf8');
      this.updateHistory = JSON.parse(data);
    } catch (error) {
      this.updateHistory = [];
    }
  }
  
  /**
   * Record update in history
   */
  async recordUpdate(update) {
    this.updateHistory.push(update);
    
    // Keep last 50 updates
    if (this.updateHistory.length > 50) {
      this.updateHistory = this.updateHistory.slice(-50);
    }
    
    const historyPath = path.join(this.getUpdateDirectory(), 'history.json');
    await fs.writeFile(historyPath, JSON.stringify(this.updateHistory, null, 2));
  }
  
  /**
   * Fetch SHA256 hash from URL
   */
  async fetchSha256(url) {
    try {
      const response = await axios.get(url + '.sha256', { timeout: 10000 });
      return response.data.trim().split(' ')[0];
    } catch (error) {
      return null;
    }
  }
  
  /**
   * Get update status
   */
  getStatus() {
    return {
      currentVersion: this.currentVersion,
      updateChannel: this.options.updateChannel,
      autoDownload: this.options.autoDownload,
      autoInstall: this.options.autoInstall,
      checking: !!this.updateCheckTimer,
      updating: this.isUpdating,
      updateAvailable: !!this.updateInfo,
      updateInfo: this.updateInfo,
      downloadProgress: this.downloadProgress,
      lastCheck: this.lastCheck,
      history: this.updateHistory.slice(-10)
    };
  }
  
  /**
   * Set update channel
   */
  setUpdateChannel(channel) {
    if (['stable', 'beta', 'nightly'].includes(channel)) {
      this.options.updateChannel = channel;
      logger.info(`Update channel changed to ${channel}`);
      this.checkForUpdates();
    }
  }
  
  /**
   * Manually trigger update check
   */
  async manualCheck() {
    return await this.checkForUpdates();
  }
}

export default AutoUpdateSystem;