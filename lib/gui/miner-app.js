/**
 * Otedama Miner - Intuitive Mining Application
 * Simple, user-friendly interface for cryptocurrency mining
 */

const { app, BrowserWindow, Menu, Tray, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { MinerClient } = require('../mining/miner-client');
// const { autoUpdater } = require('electron-updater'); // Removed - not practical for all users

class OtedamaMinerApp {
  constructor() {
    this.mainWindow = null;
    this.tray = null;
    this.minerClient = null;
    this.isQuitting = false;
    this.settings = this.loadSettings();
    
    // Mining stats
    this.miningStats = {
      hashrate: 0,
      shares: {
        accepted: 0,
        rejected: 0,
        total: 0
      },
      earnings: {
        today: 0,
        total: 0,
        pending: 0
      },
      uptime: 0,
      temperature: { cpu: 0, gpu: 0 }
    };
  }

  /**
   * Initialize the application
   */
  async init() {
    // Single instance lock
    const gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
      app.quit();
      return;
    }

    // App event handlers
    app.on('second-instance', () => {
      if (this.mainWindow) {
        if (this.mainWindow.isMinimized()) this.mainWindow.restore();
        this.mainWindow.focus();
      }
    });

    app.whenReady().then(() => {
      this.createMainWindow();
      this.createTrayIcon();
      this.setupIpcHandlers();
      this.initializeMiner();
      
      // Auto-start mining if configured
      if (this.settings.autoStart) {
        this.startMining();
      }

      // Auto-update removed (not practical for all users)
    });

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        app.quit();
      }
    });

    app.on('before-quit', () => {
      this.isQuitting = true;
    });
  }

  /**
   * Create the main application window
   */
  createMainWindow() {
    this.mainWindow = new BrowserWindow({
      width: 900,
      height: 700,
      minWidth: 800,
      minHeight: 600,
      title: 'Otedama Miner',
      icon: path.join(__dirname, '../../assets/icon.png'),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
      },
      frame: false, // Custom title bar
      backgroundColor: '#1e1e1e',
      show: false
    });

    // Load the UI
    this.mainWindow.loadFile(path.join(__dirname, 'index.html'));

    // Window events
    this.mainWindow.once('ready-to-show', () => {
      if (!this.settings.startMinimized) {
        this.mainWindow.show();
      }
    });

    this.mainWindow.on('close', (event) => {
      if (!this.isQuitting && this.settings.minimizeToTray) {
        event.preventDefault();
        this.mainWindow.hide();
      }
    });

    // Development tools
    if (process.env.NODE_ENV === 'development') {
      this.mainWindow.webContents.openDevTools();
    }
  }

  /**
   * Create system tray icon
   */
  createTrayIcon() {
    const iconPath = path.join(__dirname, '../../assets/tray-icon.png');
    this.tray = new Tray(iconPath);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Open Otedama Miner',
        click: () => {
          this.mainWindow.show();
        }
      },
      {
        label: 'Start Mining',
        id: 'start-mining',
        click: () => this.startMining(),
        visible: true
      },
      {
        label: 'Stop Mining',
        id: 'stop-mining',
        click: () => this.stopMining(),
        visible: false
      },
      { type: 'separator' },
      {
        label: 'Settings',
        click: () => {
          this.mainWindow.show();
          this.mainWindow.webContents.send('navigate', 'settings');
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          this.isQuitting = true;
          app.quit();
        }
      }
    ]);

    this.tray.setToolTip('Otedama Miner - Not Mining');
    this.tray.setContextMenu(contextMenu);

    // Double-click to show window
    this.tray.on('double-click', () => {
      this.mainWindow.show();
    });
  }

  /**
   * Setup IPC communication handlers
   */
  setupIpcHandlers() {
    // Mining controls
    ipcMain.handle('start-mining', async () => {
      return await this.startMining();
    });

    ipcMain.handle('stop-mining', async () => {
      return await this.stopMining();
    });

    // Settings
    ipcMain.handle('get-settings', () => {
      return this.settings;
    });

    ipcMain.handle('save-settings', (event, newSettings) => {
      this.settings = { ...this.settings, ...newSettings };
      this.saveSettings();
      this.applySettings();
      return { success: true };
    });

    // Stats
    ipcMain.handle('get-stats', () => {
      return this.miningStats;
    });

    // Wallet
    ipcMain.handle('get-wallet-info', async () => {
      return {
        address: this.settings.btcAddress,
        balance: this.miningStats.earnings.total,
        pending: this.miningStats.earnings.pending
      };
    });

    // Window controls
    ipcMain.handle('minimize-window', () => {
      this.mainWindow.minimize();
    });

    ipcMain.handle('maximize-window', () => {
      if (this.mainWindow.isMaximized()) {
        this.mainWindow.unmaximize();
      } else {
        this.mainWindow.maximize();
      }
    });

    ipcMain.handle('close-window', () => {
      this.mainWindow.close();
    });

    // Pool selection
    ipcMain.handle('get-pools', () => {
      return this.getAvailablePools();
    });

    ipcMain.handle('test-pool', async (event, poolUrl) => {
      return await this.testPoolConnection(poolUrl);
    });

    // Help
    ipcMain.handle('open-external', (event, url) => {
      shell.openExternal(url);
    });
  }

  /**
   * Initialize the miner client
   */
  initializeMiner() {
    this.minerClient = new MinerClient({
      btcAddress: this.settings.btcAddress,
      poolUrl: this.settings.poolUrl,
      hardware: {
        useCPU: this.settings.useCPU,
        useGPU: this.settings.useGPU,
        cpuThreads: this.settings.cpuThreads,
        gpuIntensity: this.settings.gpuIntensity
      },
      autoReconnect: true,
      reconnectInterval: 30000
    });

    // Miner event handlers
    this.minerClient.on('connected', () => {
      this.updateUI('connected');
      this.showNotification('Connected to mining pool', 'success');
    });

    this.minerClient.on('disconnected', () => {
      this.updateUI('disconnected');
      this.showNotification('Disconnected from pool', 'warning');
    });

    this.minerClient.on('error', (error) => {
      console.error('Miner error:', error);
      this.showNotification(`Mining error: ${error.message}`, 'error');
    });

    this.minerClient.on('hashrate', (hashrate) => {
      this.miningStats.hashrate = hashrate;
      this.updateStats();
    });

    this.minerClient.on('share', (share) => {
      if (share.accepted) {
        this.miningStats.shares.accepted++;
      } else {
        this.miningStats.shares.rejected++;
      }
      this.miningStats.shares.total++;
      this.updateStats();
    });

    this.minerClient.on('earnings', (earnings) => {
      this.miningStats.earnings = earnings;
      this.updateStats();
    });

    this.minerClient.on('temperature', (temps) => {
      this.miningStats.temperature = temps;
      this.updateStats();
    });
  }

  /**
   * Start mining
   */
  async startMining() {
    try {
      // Validate settings
      if (!this.settings.btcAddress) {
        this.showNotification('Please configure your Bitcoin address', 'error');
        this.mainWindow.webContents.send('navigate', 'settings');
        return { success: false, error: 'No Bitcoin address configured' };
      }

      // Start the miner
      await this.minerClient.start();
      
      // Update UI
      this.updateMiningStatus(true);
      this.updateTrayMenu(true);
      
      // Start stats update interval
      this.startStatsUpdater();
      
      this.showNotification('Mining started successfully', 'success');
      return { success: true };
    } catch (error) {
      console.error('Failed to start mining:', error);
      this.showNotification(`Failed to start mining: ${error.message}`, 'error');
      return { success: false, error: error.message };
    }
  }

  /**
   * Stop mining
   */
  async stopMining() {
    try {
      await this.minerClient.stop();
      
      // Update UI
      this.updateMiningStatus(false);
      this.updateTrayMenu(false);
      
      // Stop stats updater
      this.stopStatsUpdater();
      
      this.showNotification('Mining stopped', 'info');
      return { success: true };
    } catch (error) {
      console.error('Failed to stop mining:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Update mining status in UI
   */
  updateMiningStatus(isMining) {
    this.mainWindow.webContents.send('mining-status', isMining);
    this.tray.setToolTip(isMining ? 'Otedama Miner - Mining' : 'Otedama Miner - Not Mining');
  }

  /**
   * Update tray menu based on mining status
   */
  updateTrayMenu(isMining) {
    const menu = this.tray.contextMenu;
    menu.getMenuItemById('start-mining').visible = !isMining;
    menu.getMenuItemById('stop-mining').visible = isMining;
    this.tray.setContextMenu(menu);
  }

  /**
   * Update UI with latest stats
   */
  updateStats() {
    this.mainWindow.webContents.send('stats-update', this.miningStats);
  }

  /**
   * Start periodic stats updater
   */
  startStatsUpdater() {
    this.statsInterval = setInterval(() => {
      this.miningStats.uptime++;
      this.updateStats();
    }, 1000);
  }

  /**
   * Stop stats updater
   */
  stopStatsUpdater() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  /**
   * Load settings from file
   */
  loadSettings() {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    const defaultSettings = {
      btcAddress: '',
      poolUrl: 'stratum+tcp://pool.otedama.io:3333',
      useCPU: true,
      useGPU: true,
      cpuThreads: 0, // 0 = auto
      gpuIntensity: 75,
      autoStart: false,
      startMinimized: false,
      minimizeToTray: true,
      autoUpdate: true,
      idleMining: false,
      idleThreshold: 5, // minutes
      theme: 'dark',
      language: 'en',
      notifications: true
    };

    try {
      if (fs.existsSync(settingsPath)) {
        const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        return { ...defaultSettings, ...saved };
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    }

    return defaultSettings;
  }

  /**
   * Save settings to file
   */
  saveSettings() {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    try {
      fs.writeFileSync(settingsPath, JSON.stringify(this.settings, null, 2));
    } catch (error) {
      console.error('Failed to save settings:', error);
    }
  }

  /**
   * Apply settings changes
   */
  applySettings() {
    // Update miner configuration
    if (this.minerClient) {
      this.minerClient.updateConfig({
        btcAddress: this.settings.btcAddress,
        poolUrl: this.settings.poolUrl,
        hardware: {
          useCPU: this.settings.useCPU,
          useGPU: this.settings.useGPU,
          cpuThreads: this.settings.cpuThreads,
          gpuIntensity: this.settings.gpuIntensity
        }
      });
    }

    // Apply theme
    this.mainWindow.webContents.send('theme-change', this.settings.theme);
  }

  /**
   * Show notification
   */
  showNotification(message, type = 'info') {
    if (!this.settings.notifications) return;

    this.mainWindow.webContents.send('notification', { message, type });
  }

  /**
   * Get available mining pools
   */
  getAvailablePools() {
    return [
      {
        name: 'Otedama Official Pool',
        url: 'stratum+tcp://pool.otedama.io:3333',
        fee: '1%',
        region: 'Global',
        recommended: true
      },
      {
        name: 'Otedama Asia Pool',
        url: 'stratum+tcp://asia.otedama.io:3333',
        fee: '1%',
        region: 'Asia'
      },
      {
        name: 'Otedama Europe Pool',
        url: 'stratum+tcp://eu.otedama.io:3333',
        fee: '1%',
        region: 'Europe'
      },
      {
        name: 'Otedama US Pool',
        url: 'stratum+tcp://us.otedama.io:3333',
        fee: '1%',
        region: 'North America'
      }
    ];
  }

  /**
   * Test pool connection
   */
  async testPoolConnection(poolUrl) {
    try {
      const testClient = new MinerClient({
        btcAddress: this.settings.btcAddress || '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa',
        poolUrl: poolUrl
      });

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          testClient.stop();
          resolve({ success: false, error: 'Connection timeout' });
        }, 5000);

        testClient.once('connected', () => {
          clearTimeout(timeout);
          testClient.stop();
          resolve({ success: true, latency: Date.now() - startTime });
        });

        testClient.once('error', (error) => {
          clearTimeout(timeout);
          testClient.stop();
          resolve({ success: false, error: error.message });
        });

        const startTime = Date.now();
        testClient.connect();
      });
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Update UI state
   */
  updateUI(state) {
    this.mainWindow.webContents.send('connection-state', state);
  }
}

// Create and initialize the app
const minerApp = new OtedamaMinerApp();
minerApp.init();

module.exports = { OtedamaMinerApp };