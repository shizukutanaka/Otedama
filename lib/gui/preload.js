/**
 * Preload Script - Secure Bridge between Renderer and Main Process
 */

const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('api', {
  // Mining controls
  startMining: () => ipcRenderer.invoke('start-mining'),
  stopMining: () => ipcRenderer.invoke('stop-mining'),
  
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  
  // Stats
  getStats: () => ipcRenderer.invoke('get-stats'),
  
  // Wallet
  getWalletInfo: () => ipcRenderer.invoke('get-wallet-info'),
  requestPayout: () => ipcRenderer.invoke('request-payout'),
  
  // Window controls
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  maximizeWindow: () => ipcRenderer.invoke('maximize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  
  // Pool management
  getPools: () => ipcRenderer.invoke('get-pools'),
  testPool: (poolUrl) => ipcRenderer.invoke('test-pool', poolUrl),
  
  // External links
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  
  // Event listeners
  on: (channel, callback) => {
    const validChannels = [
      'mining-status',
      'stats-update',
      'notification',
      'navigate',
      'theme-change',
      'connection-state',
      'log'
    ];
    
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
  },
  
  // Remove event listeners
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  }
});