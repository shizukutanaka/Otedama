/**
 * Preload Script - セキュアなレンダラープロセス通信
 * 
 * 設計思想: Rob Pike (セキュリティ・シンプルさ)
 * 
 * 機能:
 * - セキュアなIPC通信
 * - API関数の公開
 * - イベント監視
 * - ファイルシステムアクセス制御
 */

import { contextBridge, ipcRenderer } from 'electron';

// ===== 型定義 =====
interface MiningConfig {
  currency: string;
  address: string;
  workerName: string;
  algorithm: string;
  difficulty: number;
  poolUrl?: string;
}

interface HardwareDevice {
  id: string;
  type: 'CPU' | 'GPU' | 'ASIC';
  vendor: string;
  model: string;
  memory?: number;
  cores?: number;
  maxPower: number;
  estimatedHashrate: number;
  temperature: number;
  fanSpeed: number;
  status: 'idle' | 'mining' | 'error' | 'cooling';
}

interface AppStats {
  mining: {
    active: boolean;
    currency: string;
    hashrate: number;
    sharesAccepted: number;
    sharesRejected: number;
    balance: number;
    uptime: number;
  };
  system: {
    cpu: number;
    memory: number;
    temperature: number;
  };
  pool: {
    miners: number;
    hashrate: number;
    blocks: number;
    p2pPeers: number;
  };
}

interface NotificationData {
  title: string;
  body: string;
  icon?: string;
  urgent?: boolean;
}

// ===== API定義 =====
const api = {
  // Mining Control
  mining: {
    start: (config: MiningConfig) => ipcRenderer.invoke('start-mining', config),
    stop: () => ipcRenderer.invoke('stop-mining'),
    getStatus: () => ipcRenderer.invoke('get-mining-status'),
    pause: () => ipcRenderer.invoke('pause-mining'),
    resume: () => ipcRenderer.invoke('resume-mining')
  },

  // Hardware Management
  hardware: {
    detect: () => ipcRenderer.invoke('detect-hardware'),
    getDevices: () => ipcRenderer.invoke('get-hardware-devices'),
    updateDevice: (deviceId: string, config: any) => ipcRenderer.invoke('update-device-config', deviceId, config),
    benchmark: (deviceId: string, algorithm: string) => ipcRenderer.invoke('benchmark-device', deviceId, algorithm)
  },

  // Configuration
  config: {
    get: () => ipcRenderer.invoke('get-config'),
    save: (config: any) => ipcRenderer.invoke('save-config', config),
    export: (filePath: string) => ipcRenderer.invoke('export-config', filePath),
    import: (filePath: string) => ipcRenderer.invoke('import-config', filePath),
    reset: () => ipcRenderer.invoke('reset-config')
  },

  // Statistics
  stats: {
    get: () => ipcRenderer.invoke('get-stats'),
    getHistory: (period: string) => ipcRenderer.invoke('get-stats-history', period),
    export: (filePath: string) => ipcRenderer.invoke('export-stats', filePath)
  },

  // Pool Management
  pool: {
    getStats: () => ipcRenderer.invoke('get-pool-stats'),
    registerAddress: (currency: string, address: string) => ipcRenderer.invoke('register-address', currency, address),
    getPayoutHistory: (address: string) => ipcRenderer.invoke('get-payout-history', address),
    getPeers: () => ipcRenderer.invoke('get-p2p-peers')
  },

  // Currency Management
  currencies: {
    getSupported: () => ipcRenderer.invoke('get-supported-currencies'),
    validateAddress: (currency: string, address: string) => ipcRenderer.invoke('validate-address', currency, address),
    generateWallet: (currency: string) => ipcRenderer.invoke('generate-wallet', currency),
    getMarketData: (currency: string) => ipcRenderer.invoke('get-market-data', currency)
  },

  // System Information
  system: {
    getInfo: () => ipcRenderer.invoke('get-system-info'),
    getPerformance: () => ipcRenderer.invoke('get-performance-metrics'),
    optimize: () => ipcRenderer.invoke('optimize-settings'),
    getRecommendations: () => ipcRenderer.invoke('get-optimization-recommendations')
  },

  // File Operations
  files: {
    openLogFile: () => ipcRenderer.invoke('open-log-file'),
    selectFile: (filters?: any) => ipcRenderer.invoke('select-file', filters),
    selectDirectory: () => ipcRenderer.invoke('select-directory'),
    openExternal: (url: string) => ipcRenderer.invoke('open-external', url)
  },

  // Notifications
  notifications: {
    show: (data: NotificationData) => ipcRenderer.invoke('show-notification', data),
    permission: () => ipcRenderer.invoke('get-notification-permission'),
    requestPermission: () => ipcRenderer.invoke('request-notification-permission')
  },

  // Security
  security: {
    encrypt: (data: string, password: string) => ipcRenderer.invoke('encrypt-data', data, password),
    decrypt: (encryptedData: string, password: string) => ipcRenderer.invoke('decrypt-data', encryptedData, password),
    validatePassword: (password: string) => ipcRenderer.invoke('validate-password', password),
    changePassword: (oldPassword: string, newPassword: string) => ipcRenderer.invoke('change-password', oldPassword, newPassword)
  },

  // App Management
  app: {
    getVersion: () => ipcRenderer.invoke('get-app-version'),
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    restart: () => ipcRenderer.invoke('restart-app'),
    quit: () => ipcRenderer.invoke('quit-app'),
    minimize: () => ipcRenderer.invoke('minimize-window'),
    maximize: () => ipcRenderer.invoke('maximize-window'),
    close: () => ipcRenderer.invoke('close-window')
  },

  // Backup & Recovery
  backup: {
    create: (type: 'config' | 'full') => ipcRenderer.invoke('create-backup', type),
    restore: (backupPath: string) => ipcRenderer.invoke('restore-backup', backupPath),
    list: () => ipcRenderer.invoke('list-backups'),
    delete: (backupId: string) => ipcRenderer.invoke('delete-backup', backupId)
  }
};

// ===== イベントリスナー =====
const events = {
  // Mining Events
  onMiningStarted: (callback: (data: any) => void) => {
    ipcRenderer.on('mining-started', (_, data) => callback(data));
  },
  onMiningStopped: (callback: () => void) => {
    ipcRenderer.on('mining-stopped', () => callback());
  },
  onMiningPaused: (callback: () => void) => {
    ipcRenderer.on('mining-paused', () => callback());
  },
  onMiningResumed: (callback: () => void) => {
    ipcRenderer.on('mining-resumed', () => callback());
  },
  onShareAccepted: (callback: (share: any) => void) => {
    ipcRenderer.on('share-accepted', (_, share) => callback(share));
  },
  onShareRejected: (callback: (share: any) => void) => {
    ipcRenderer.on('share-rejected', (_, share) => callback(share));
  },
  onHashrateUpdate: (callback: (hashrate: number) => void) => {
    ipcRenderer.on('hashrate-update', (_, hashrate) => callback(hashrate));
  },
  onBlockFound: (callback: (block: any) => void) => {
    ipcRenderer.on('block-found', (_, block) => callback(block));
  },
  onPaymentReceived: (callback: (payment: any) => void) => {
    ipcRenderer.on('payment-received', (_, payment) => callback(payment));
  },

  // System Events
  onStatsUpdate: (callback: (stats: AppStats) => void) => {
    ipcRenderer.on('stats-update', (_, stats) => callback(stats));
  },
  onSystemStats: (callback: (stats: any) => void) => {
    ipcRenderer.on('system-stats', (_, stats) => callback(stats));
  },
  onPerformanceAlert: (callback: (alert: any) => void) => {
    ipcRenderer.on('performance-alert', (_, alert) => callback(alert));
  },
  onHardwareDetected: (callback: (devices: HardwareDevice[]) => void) => {
    ipcRenderer.on('hardware-detected', (_, devices) => callback(devices));
  },

  // Pool Events
  onPeersUpdate: (callback: (count: number) => void) => {
    ipcRenderer.on('peers-update', (_, count) => callback(count));
  },
  onPoolStatsUpdate: (callback: (stats: any) => void) => {
    ipcRenderer.on('pool-stats-update', (_, stats) => callback(stats));
  },

  // UI Events
  onNotification: (callback: (notification: NotificationData) => void) => {
    ipcRenderer.on('show-notification', (_, notification) => callback(notification));
  },
  onThemeChange: (callback: (theme: string) => void) => {
    ipcRenderer.on('theme-changed', (_, theme) => callback(theme));
  },
  onLanguageChange: (callback: (language: string) => void) => {
    ipcRenderer.on('language-changed', (_, language) => callback(language));
  },

  // Menu Events
  onMenuAction: (callback: (action: string) => void) => {
    ipcRenderer.on('menu-start-mining', () => callback('start-mining'));
    ipcRenderer.on('menu-stop-mining', () => callback('stop-mining'));
    ipcRenderer.on('menu-settings', () => callback('settings'));
    ipcRenderer.on('menu-register-address', () => callback('register-address'));
    ipcRenderer.on('menu-pool-stats', () => callback('pool-stats'));
    ipcRenderer.on('menu-p2p-network', () => callback('p2p-network'));
    ipcRenderer.on('menu-hardware-detection', () => callback('hardware-detection'));
    ipcRenderer.on('menu-benchmark', () => callback('benchmark'));
    ipcRenderer.on('menu-auto-optimize', () => callback('auto-optimize'));
    ipcRenderer.on('menu-export-stats', () => callback('export-stats'));
    ipcRenderer.on('menu-about', () => callback('about'));
  },

  // Remove listeners
  removeAllListeners: (event: string) => {
    ipcRenderer.removeAllListeners(event);
  },
  removeListener: (event: string, callback: any) => {
    ipcRenderer.removeListener(event, callback);
  }
};

// ===== ユーティリティ関数 =====
const utils = {
  // 数値フォーマット
  formatHashrate: (hashrate: number): string => {
    if (hashrate >= 1e12) return (hashrate / 1e12).toFixed(2) + ' TH/s';
    if (hashrate >= 1e9) return (hashrate / 1e9).toFixed(2) + ' GH/s';
    if (hashrate >= 1e6) return (hashrate / 1e6).toFixed(2) + ' MH/s';
    if (hashrate >= 1e3) return (hashrate / 1e3).toFixed(2) + ' KH/s';
    return hashrate.toFixed(2) + ' H/s';
  },

  formatCurrency: (amount: number, currency: string): string => {
    const decimals = currency === 'BTC' ? 8 : currency === 'XMR' ? 12 : 6;
    return amount.toFixed(decimals) + ' ' + currency;
  },

  formatBytes: (bytes: number): string => {
    if (bytes >= 1e12) return (bytes / 1e12).toFixed(2) + ' TB';
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(2) + ' MB';
    if (bytes >= 1e3) return (bytes / 1e3).toFixed(2) + ' KB';
    return bytes + ' B';
  },

  formatPercent: (value: number): string => {
    return value.toFixed(1) + '%';
  },

  formatDuration: (milliseconds: number): string => {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  },

  formatTemperature: (temp: number): string => {
    return Math.round(temp) + '°C';
  },

  // 色計算
  getTemperatureColor: (temp: number): string => {
    if (temp >= 85) return '#ef4444'; // red
    if (temp >= 75) return '#f59e0b'; // yellow
    if (temp >= 65) return '#10b981'; // green
    return '#3b82f6'; // blue
  },

  getPerformanceColor: (percentage: number): string => {
    if (percentage >= 90) return '#ef4444'; // red
    if (percentage >= 70) return '#f59e0b'; // yellow
    return '#10b981'; // green
  },

  // データ検証
  validateEmail: (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  },

  validateAddress: (address: string, currency: string): boolean => {
    const patterns: Record<string, RegExp> = {
      BTC: /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^bc1[a-z0-9]{39,59}$/,
      XMR: /^4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/,
      RVN: /^R[1-9A-HJ-NP-Za-km-z]{33}$/,
      ETC: /^0x[a-fA-F0-9]{40}$/,
      ERG: /^9[a-zA-Z0-9]{33}$/,
      FLUX: /^t1[a-zA-Z0-9]{33}$/,
      KAS: /^kaspa:[a-z0-9]{61}$/
    };
    const pattern = patterns[currency];
    return pattern ? pattern.test(address) : false;
  },

  // ローカルストレージヘルパー
  storage: {
    get: (key: string, defaultValue?: any) => {
      try {
        const item = localStorage.getItem(key);
        return item ? JSON.parse(item) : defaultValue;
      } catch {
        return defaultValue;
      }
    },
    set: (key: string, value: any) => {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (error) {
        console.error('Failed to save to localStorage:', error);
      }
    },
    remove: (key: string) => {
      localStorage.removeItem(key);
    },
    clear: () => {
      localStorage.clear();
    }
  },

  // デバウンス関数
  debounce: (func: Function, wait: number) => {
    let timeout: NodeJS.Timeout;
    return function executedFunction(...args: any[]) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  // スロットル関数
  throttle: (func: Function, limit: number) => {
    let inThrottle: boolean;
    return function executedFunction(...args: any[]) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  }
};

// ===== セキュアなAPIを公開 =====
contextBridge.exposeInMainWorld('otedamaAPI', {
  ...api,
  on: events,
  utils,
  
  // セキュリティコンテキスト情報
  security: {
    isSecureContext: window.isSecureContext,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    onLine: navigator.onLine
  },

  // バージョン情報
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8
  }
});

// ===== セキュリティ設定 =====
// CSP設定の確認
document.addEventListener('DOMContentLoaded', () => {
  // セキュリティヘッダーの確認
  const cspMeta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  if (!cspMeta) {
    console.warn('CSP meta tag not found. Security may be compromised.');
  }

  // セキュアコンテキストの確認
  if (!window.isSecureContext) {
    console.warn('Not running in secure context.');
  }

  // console.logオーバーライド（本番環境でのデバッグ情報漏洩防止）
  if (process.env.NODE_ENV === 'production') {
    const originalLog = console.log;
    console.log = (...args: any[]) => {
      // 本番環境では重要な情報をログに出力しない
      const safeArgs = args.map(arg => {
        if (typeof arg === 'string' && (arg.includes('key') || arg.includes('password') || arg.includes('secret'))) {
          return '[REDACTED]';
        }
        return arg;
      });
      originalLog(...safeArgs);
    };
  }
});

// ===== 型定義をグローバルに追加 =====
declare global {
  interface Window {
    otedamaAPI: typeof api & {
      on: typeof events;
      utils: typeof utils;
      security: {
        isSecureContext: boolean;
        userAgent: string;
        platform: string;
        language: string;
        onLine: boolean;
      };
      versions: {
        electron: string;
        chrome: string;
        node: string;
        v8: string;
      };
    };
  }
}

// エラーハンドリング
window.addEventListener('error', (event) => {
  console.error('Unhandled error in renderer:', event.error);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection in renderer:', event.reason);
});

console.log('🚀 Otedama preload script loaded successfully');
