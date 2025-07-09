/**
 * Otedama Electron Preload Script
 * レンダラープロセスとメインプロセス間の安全な通信橋渡し
 */

import { contextBridge, ipcRenderer } from 'electron';

// === API定義 ===
const otedamaAPI = {
  // セットアップ
  setup: {
    start: (config: any) => ipcRenderer.invoke('setup:start', config),
  },
  
  // マイニング制御
  mining: {
    start: () => ipcRenderer.invoke('mining:start'),
    stop: () => ipcRenderer.invoke('mining:stop'),
    onStarted: (callback: () => void) => {
      ipcRenderer.on('mining:started', callback);
    },
    onStopped: (callback: () => void) => {
      ipcRenderer.on('mining:stopped', callback);
    }
  },
  
  // 統計情報
  stats: {
    get: () => ipcRenderer.invoke('stats:get'),
  },
  
  // ハードウェア
  hardware: {
    detect: () => ipcRenderer.invoke('hardware:detect'),
  },
  
  // ウィンドウ制御
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
  },
  
  // メニューイベント
  menu: {
    onNewWallet: (callback: () => void) => {
      ipcRenderer.on('menu:new-wallet', callback);
    },
    onImportConfig: (callback: (path: string) => void) => {
      ipcRenderer.on('menu:import-config', (event, path) => callback(path));
    },
    onStartMining: (callback: () => void) => {
      ipcRenderer.on('menu:start-mining', callback);
    },
    onStopMining: (callback: () => void) => {
      ipcRenderer.on('menu:stop-mining', callback);
    },
    onRunBenchmark: (callback: () => void) => {
      ipcRenderer.on('menu:run-benchmark', callback);
    },
    onConfigureHardware: (callback: () => void) => {
      ipcRenderer.on('menu:configure-hardware', callback);
    }
  },
  
  // 外部リンク
  openExternal: (url: string) => ipcRenderer.send('open:external', url),
  
  // システム情報
  system: {
    platform: process.platform,
    version: process.versions.electron,
  }
};

// === コンテキストブリッジ ===
contextBridge.exposeInMainWorld('otedama', otedamaAPI);

// === TypeScript型定義 ===
export interface IOtedamaAPI {
  setup: {
    start: (config: any) => Promise<any>;
  };
  mining: {
    start: () => Promise<{ success: boolean }>;
    stop: () => Promise<{ success: boolean }>;
    onStarted: (callback: () => void) => void;
    onStopped: (callback: () => void) => void;
  };
  stats: {
    get: () => Promise<any>;
  };
  hardware: {
    detect: () => Promise<any>;
  };
  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
  };
  menu: {
    onNewWallet: (callback: () => void) => void;
    onImportConfig: (callback: (path: string) => void) => void;
    onStartMining: (callback: () => void) => void;
    onStopMining: (callback: () => void) => void;
    onRunBenchmark: (callback: () => void) => void;
    onConfigureHardware: (callback: () => void) => void;
  };
  openExternal: (url: string) => void;
  system: {
    platform: string;
    version: string;
  };
}

declare global {
  interface Window {
    otedama: IOtedamaAPI;
  }
}