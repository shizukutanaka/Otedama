/**
 * Otedama Electron Main Process
 * デスクトップアプリケーションのメインプロセス
 */

import { app, BrowserWindow, Menu, Tray, ipcMain, shell, dialog } from 'electron';
import * as path from 'path';
import * as os from 'os';
import OtedamaCoreSystem from '../core/otedama-core-system';
import OtedamaWebServer from '../web/otedama-web-server';
import OneClickSetup from '../setup/one-click-setup';

// グローバル変数
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let pool: OtedamaCoreSystem | null = null;
let webServer: OtedamaWebServer | null = null;
let isQuitting = false;

// 開発モードかどうか
const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

// === メインウィンドウ作成 ===
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    frame: false, // カスタムタイトルバー
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, '../../assets/icon.png'),
    show: false // 準備ができてから表示
  });

  // カスタムメニューバー
  const template: any[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Wallet',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('menu:new-wallet')
        },
        {
          label: 'Import Configuration',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow!, {
              filters: [{ name: 'JSON', extensions: ['json'] }]
            });
            if (!result.canceled) {
              mainWindow?.webContents.send('menu:import-config', result.filePaths[0]);
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
          click: () => {
            isQuitting = true;
            app.quit();
          }
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Mining',
      submenu: [
        {
          label: 'Start Mining',
          accelerator: 'F5',
          click: () => mainWindow?.webContents.send('menu:start-mining')
        },
        {
          label: 'Stop Mining',
          accelerator: 'F6',
          click: () => mainWindow?.webContents.send('menu:stop-mining')
        },
        { type: 'separator' },
        {
          label: 'Run Benchmark',
          click: () => mainWindow?.webContents.send('menu:run-benchmark')
        },
        {
          label: 'Configure Hardware',
          click: () => mainWindow?.webContents.send('menu:configure-hardware')
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Documentation',
          click: () => shell.openExternal('https://docs.otedama.com')
        },
        {
          label: 'Discord',
          click: () => shell.openExternal('https://discord.gg/otedama')
        },
        { type: 'separator' },
        {
          label: 'About',
          click: () => {
            dialog.showMessageBox(mainWindow!, {
              type: 'info',
              title: 'About Otedama',
              message: 'Otedama Mining Pool',
              detail: 'Version 1.0.0\nZero Fee P2P Mining Pool\n\n© 2025 Otedama Team',
              buttons: ['OK']
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // ウィンドウロード
  if (isDev) {
    mainWindow.loadURL('http://localhost:3000'); // React開発サーバー
  } else {
    mainWindow.loadURL(`http://localhost:8080`); // 本番サーバー
  }

  // ウィンドウ準備完了
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    
    // スプラッシュスクリーン表示
    showSplashScreen();
  });

  // ウィンドウクローズ処理
  mainWindow.on('close', (event) => {
    if (!isQuitting && process.platform !== 'darwin') {
      event.preventDefault();
      mainWindow?.hide();
      
      // トレイに最小化
      if (!tray) {
        createTray();
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// === システムトレイ ===
function createTray(): void {
  tray = new Tray(path.join(__dirname, '../../assets/tray-icon.png'));
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Otedama',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      }
    },
    {
      label: 'Start Mining',
      click: () => startMining()
    },
    {
      label: 'Stop Mining',
      click: () => stopMining()
    },
    { type: 'separator' },
    {
      label: 'Status',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  
  tray.setToolTip('Otedama Mining Pool');
  tray.setContextMenu(contextMenu);
  
  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

// === スプラッシュスクリーン ===
function showSplashScreen(): void {
  const splash = new BrowserWindow({
    width: 600,
    height: 400,
    frame: false,
    alwaysOnTop: true,
    transparent: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  
  splash.loadFile(path.join(__dirname, '../../assets/splash.html'));
  
  setTimeout(() => {
    splash.close();
  }, 3000);
}

// === マイニング制御 ===
async function startMining(): Promise<void> {
  try {
    if (!pool) {
      pool = new OtedamaCoreSystem();
      await pool.start();
    }
    
    if (!webServer) {
      webServer = new OtedamaWebServer(pool);
      await webServer.start();
    }
    
    mainWindow?.webContents.send('mining:started');
    updateTrayStatus('Mining Active');
    
  } catch (error) {
    console.error('Failed to start mining:', error);
    dialog.showErrorBox('Mining Error', 'Failed to start mining. Check logs for details.');
  }
}

async function stopMining(): Promise<void> {
  try {
    if (pool) {
      await pool.stop();
      pool = null;
    }
    
    if (webServer) {
      await webServer.stop();
      webServer = null;
    }
    
    mainWindow?.webContents.send('mining:stopped');
    updateTrayStatus('Mining Stopped');
    
  } catch (error) {
    console.error('Failed to stop mining:', error);
  }
}

function updateTrayStatus(status: string): void {
  if (tray) {
    tray.setToolTip(`Otedama Mining Pool - ${status}`);
  }
}

// === IPC通信 ===
function setupIPC(): void {
  // ワンクリックセットアップ
  ipcMain.handle('setup:start', async (event, config) => {
    const setup = new OneClickSetup();
    return await setup.setup(config);
  });
  
  // マイニング制御
  ipcMain.handle('mining:start', async () => {
    await startMining();
    return { success: true };
  });
  
  ipcMain.handle('mining:stop', async () => {
    await stopMining();
    return { success: true };
  });
  
  // 統計取得
  ipcMain.handle('stats:get', async () => {
    if (!pool) return null;
    return pool.getStats();
  });
  
  // ハードウェア情報
  ipcMain.handle('hardware:detect', async () => {
    return {
      cpu: os.cpus(),
      memory: {
        total: os.totalmem(),
        free: os.freemem()
      },
      platform: os.platform(),
      arch: os.arch()
    };
  });
  
  // ウィンドウ制御
  ipcMain.on('window:minimize', () => {
    mainWindow?.minimize();
  });
  
  ipcMain.on('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.restore();
    } else {
      mainWindow?.maximize();
    }
  });
  
  ipcMain.on('window:close', () => {
    mainWindow?.close();
  });
  
  // 外部リンク
  ipcMain.on('open:external', (event, url) => {
    shell.openExternal(url);
  });
}

// === アプリケーションイベント ===
app.on('ready', () => {
  createWindow();
  setupIPC();
  
  // 自動起動設定
  if (process.env.AUTO_START === 'true') {
    setTimeout(() => {
      startMining().catch(console.error);
    }, 5000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('before-quit', async () => {
  isQuitting = true;
  
  // クリーンアップ
  if (pool) {
    await pool.stop();
  }
  if (webServer) {
    await webServer.stop();
  }
});

// === エラーハンドリング ===
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  dialog.showErrorBox('Unexpected Error', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

// === エクスポート ===
export { createWindow, startMining, stopMining };