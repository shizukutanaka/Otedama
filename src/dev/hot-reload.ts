/**
 * ホットリロードシステム - 開発効率化
 * ファイル変更監視と自動再起動
 */

import * as chokidar from 'chokidar';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { EventEmitter } from 'events';

export interface HotReloadConfig {
  watchPaths: string[];
  ignorePaths: string[];
  serverScript: string;
  debounceDelay: number;
  enableNotifications: boolean;
  clearConsoleOnRestart: boolean;
  nodeArgs: string[];
  env: Record<string, string>;
}

export class HotReloadManager extends EventEmitter {
  private config: HotReloadConfig;
  private watcher?: chokidar.FSWatcher;
  private serverProcess?: ChildProcess;
  private restartTimer?: NodeJS.Timeout;
  private isRestarting = false;
  private stats = {
    restartCount: 0,
    lastRestart: null as Date | null,
    watchedFiles: 0,
    startTime: new Date()
  };

  constructor(config: Partial<HotReloadConfig> = {}) {
    super();
    
    this.config = {
      watchPaths: ['src/**/*.ts', 'src/**/*.js'],
      ignorePaths: ['node_modules/**', 'dist/**', 'logs/**', 'data/**'],
      serverScript: 'dist/server.js',
      debounceDelay: 1000, // 1秒
      enableNotifications: true,
      clearConsoleOnRestart: true,
      nodeArgs: ['--inspect=0.0.0.0:9229'],
      env: { NODE_ENV: 'development' },
      ...config
    };

    console.log('[Hot Reload] Initialized with config:', {
      watchPaths: this.config.watchPaths,
      serverScript: this.config.serverScript,
      debounceDelay: this.config.debounceDelay
    });
  }

  /**
   * ホットリロード開始
   */
  public start(): void {
    this.setupWatcher();
    this.startServer();
    
    console.log('[Hot Reload] 🔥 Hot reload started');
    console.log('[Hot Reload] 👀 Watching for changes...');
    
    this.emit('started');
  }

  /**
   * ファイル監視設定
   */
  private setupWatcher(): void {
    this.watcher = chokidar.watch(this.config.watchPaths, {
      ignored: this.config.ignorePaths,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50
      }
    });

    this.watcher.on('ready', () => {
      this.stats.watchedFiles = Object.keys(this.watcher!.getWatched()).length;
      console.log(`[Hot Reload] 👁️  Watching ${this.stats.watchedFiles} files`);
    });

    this.watcher.on('change', (filePath) => {
      this.onFileChange('change', filePath);
    });

    this.watcher.on('add', (filePath) => {
      this.onFileChange('add', filePath);
    });

    this.watcher.on('unlink', (filePath) => {
      this.onFileChange('unlink', filePath);
    });

    this.watcher.on('error', (error) => {
      console.error('[Hot Reload] Watcher error:', error);
      this.emit('error', error);
    });
  }

  /**
   * ファイル変更時の処理
   */
  private onFileChange(event: string, filePath: string): void {
    const relativePath = path.relative(process.cwd(), filePath);
    console.log(`[Hot Reload] 📝 ${event}: ${relativePath}`);

    // デバウンス処理
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
    }

    this.restartTimer = setTimeout(() => {
      this.restartServer();
    }, this.config.debounceDelay);

    this.emit('fileChange', { event, path: relativePath });
  }

  /**
   * サーバー起動
   */
  private startServer(): void {
    if (this.serverProcess) {
      console.warn('[Hot Reload] Server process already running');
      return;
    }

    console.log('[Hot Reload] 🚀 Starting server...');

    const nodeArgs = [
      ...this.config.nodeArgs,
      this.config.serverScript
    ];

    this.serverProcess = spawn('node', nodeArgs, {
      stdio: 'inherit',
      env: {
        ...process.env,
        ...this.config.env
      }
    });

    this.serverProcess.on('error', (error) => {
      console.error('[Hot Reload] Server error:', error);
      this.emit('serverError', error);
    });

    this.serverProcess.on('exit', (code, signal) => {
      console.log(`[Hot Reload] Server exited with code ${code}, signal ${signal}`);
      this.serverProcess = undefined;
      
      if (!this.isRestarting) {
        // 予期しない終了の場合、再起動を試行
        console.log('[Hot Reload] 🔄 Unexpected exit, restarting...');
        setTimeout(() => this.startServer(), 1000);
      }
      
      this.emit('serverExit', { code, signal });
    });

    this.emit('serverStarted');
  }

  /**
   * サーバー停止
   */
  private stopServer(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.serverProcess) {
        resolve();
        return;
      }

      console.log('[Hot Reload] ⏹️  Stopping server...');

      const timeout = setTimeout(() => {
        if (this.serverProcess) {
          console.log('[Hot Reload] Force killing server...');
          this.serverProcess.kill('SIGKILL');
        }
      }, 5000);

      this.serverProcess.once('exit', () => {
        clearTimeout(timeout);
        this.serverProcess = undefined;
        resolve();
      });

      this.serverProcess.kill('SIGTERM');
    });
  }

  /**
   * サーバー再起動
   */
  private async restartServer(): Promise<void> {
    if (this.isRestarting) {
      return;
    }

    this.isRestarting = true;
    this.stats.restartCount++;
    this.stats.lastRestart = new Date();

    try {
      if (this.config.clearConsoleOnRestart) {
        console.clear();
      }

      console.log('[Hot Reload] 🔄 Restarting server...');
      
      await this.stopServer();
      
      // 少し待ってから再起動
      await this.sleep(500);
      
      this.startServer();
      
      if (this.config.enableNotifications) {
        console.log(`[Hot Reload] ✅ Server restarted (restart #${this.stats.restartCount})`);
      }

      this.emit('serverRestarted', this.stats.restartCount);
    } catch (error) {
      console.error('[Hot Reload] Restart failed:', error);
      this.emit('restartError', error);
    } finally {
      this.isRestarting = false;
    }
  }

  /**
   * 特定ファイルの監視追加
   */
  public watchFile(filePath: string): void {
    if (this.watcher) {
      this.watcher.add(filePath);
      console.log(`[Hot Reload] Added watch: ${filePath}`);
    }
  }

  /**
   * 特定ファイルの監視停止
   */
  public unwatchFile(filePath: string): void {
    if (this.watcher) {
      this.watcher.unwatch(filePath);
      console.log(`[Hot Reload] Removed watch: ${filePath}`);
    }
  }

  /**
   * 手動再起動
   */
  public async manualRestart(): Promise<void> {
    console.log('[Hot Reload] Manual restart triggered');
    await this.restartServer();
  }

  /**
   * 統計情報取得
   */
  public getStats() {
    return {
      ...this.stats,
      isRunning: !!this.serverProcess,
      isRestarting: this.isRestarting,
      uptime: Date.now() - this.stats.startTime.getTime(),
      averageRestartTime: this.stats.restartCount > 0 
        ? (Date.now() - this.stats.startTime.getTime()) / this.stats.restartCount
        : 0
    };
  }

  /**
   * ホットリロード停止
   */
  public async stop(): Promise<void> {
    console.log('[Hot Reload] Stopping hot reload...');

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = undefined;
    }

    await this.stopServer();

    console.log('[Hot Reload] 🛑 Hot reload stopped');
    this.emit('stopped');
  }

  /**
   * スリープ
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 設定更新
   */
  public updateConfig(newConfig: Partial<HotReloadConfig>): void {
    this.config = { ...this.config, ...newConfig };
    console.log('[Hot Reload] Configuration updated');
  }

  /**
   * デバッグ情報表示
   */
  public debug(): void {
    console.log('\n=== Hot Reload Debug Info ===');
    console.log('Config:', this.config);
    console.log('Stats:', this.getStats());
    console.log('Watched files:', this.watcher?.getWatched() || 'None');
    console.log('============================\n');
  }
}

// シンプルなホットリロード開始関数
export function startHotReload(config?: Partial<HotReloadConfig>): HotReloadManager {
  const hotReload = new HotReloadManager(config);
  
  // プロセス終了時のクリーンアップ
  process.on('SIGINT', async () => {
    console.log('\n[Hot Reload] Received SIGINT, shutting down...');
    await hotReload.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[Hot Reload] Received SIGTERM, shutting down...');
    await hotReload.stop();
    process.exit(0);
  });

  hotReload.start();
  return hotReload;
}

export default HotReloadManager;