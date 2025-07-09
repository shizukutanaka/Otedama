/**
 * Otedama - シンプルハッシュレート監視
 * 設計思想: Rob Pike (シンプル), John Carmack (高性能), Robert C. Martin (クリーン)
 * 
 * 基本機能のみ:
 * - ハッシュレート監視
 * - 基本統計
 * - アラート機能
 * - 簡潔なレポート
 */

import { EventEmitter } from 'events';

// === 型定義 ===
export interface HashrateData {
  timestamp: number;
  hashrate: number;
  miners: number;
  shares: { accepted: number; rejected: number };
  difficulty?: number;
}

export interface SimpleStats {
  current: number;
  average: number;
  min: number;
  max: number;
  trend: 'up' | 'down' | 'stable';
}

export interface HashrateAlert {
  type: 'low' | 'high' | 'drop';
  threshold: number;
  current: number;
  message: string;
  timestamp: number;
}

// === シンプルハッシュレート監視 ===
export class SimpleHashrateMonitor extends EventEmitter {
  private data: HashrateData[] = [];
  private readonly maxDataPoints = 1000;
  private thresholds = {
    lowHashrate: 0, // 自動設定
    highDrop: 20, // 20%の急激な低下
  };

  constructor() {
    super();
  }

  // データ追加
  addData(hashrate: number, miners: number = 0, shares: { accepted: number; rejected: number } = { accepted: 0, rejected: 0 }): void {
    const dataPoint: HashrateData = {
      timestamp: Date.now(),
      hashrate,
      miners,
      shares
    };

    this.data.push(dataPoint);

    // データサイズ制限
    if (this.data.length > this.maxDataPoints) {
      this.data.shift();
    }

    // アラートチェック
    this.checkAlerts(dataPoint);

    this.emit('dataAdded', dataPoint);
  }

  // 基本統計取得
  getStats(timeframeMinutes?: number): SimpleStats {
    const data = this.getTimeframeData(timeframeMinutes);
    
    if (data.length === 0) {
      return {
        current: 0,
        average: 0,
        min: 0,
        max: 0,
        trend: 'stable'
      };
    }

    const hashrates = data.map(d => d.hashrate);
    const current = hashrates[hashrates.length - 1];
    const average = hashrates.reduce((sum, h) => sum + h, 0) / hashrates.length;
    const min = Math.min(...hashrates);
    const max = Math.max(...hashrates);

    // 簡単なトレンド計算
    let trend: 'up' | 'down' | 'stable' = 'stable';
    if (data.length >= 10) {
      const recent = hashrates.slice(-5).reduce((sum, h) => sum + h, 0) / 5;
      const older = hashrates.slice(-10, -5).reduce((sum, h) => sum + h, 0) / 5;
      const change = (recent - older) / older;
      
      if (change > 0.05) trend = 'up';
      else if (change < -0.05) trend = 'down';
    }

    return { current, average, min, max, trend };
  }

  // 現在のハッシュレート
  getCurrentHashrate(): number {
    return this.data.length > 0 ? this.data[this.data.length - 1].hashrate : 0;
  }

  // マイナー数
  getMinerCount(): number {
    return this.data.length > 0 ? this.data[this.data.length - 1].miners : 0;
  }

  // シェア統計
  getShareStats(): { accepted: number; rejected: number; ratio: number } {
    if (this.data.length === 0) {
      return { accepted: 0, rejected: 0, ratio: 0 };
    }

    const latest = this.data[this.data.length - 1];
    const ratio = latest.shares.accepted + latest.shares.rejected > 0 
      ? latest.shares.accepted / (latest.shares.accepted + latest.shares.rejected) 
      : 0;

    return {
      accepted: latest.shares.accepted,
      rejected: latest.shares.rejected,
      ratio: ratio * 100
    };
  }

  // アラート設定
  setThresholds(lowHashrate?: number, highDrop?: number): void {
    if (lowHashrate !== undefined) this.thresholds.lowHashrate = lowHashrate;
    if (highDrop !== undefined) this.thresholds.highDrop = highDrop;
  }

  // 簡潔なレポート生成
  getReport(): string {
    const stats = this.getStats();
    const shares = this.getShareStats();
    const miners = this.getMinerCount();

    const lines = [
      '=== Hashrate Monitor Report ===',
      `Current: ${this.formatHashrate(stats.current)}`,
      `Average: ${this.formatHashrate(stats.average)}`,
      `Range: ${this.formatHashrate(stats.min)} - ${this.formatHashrate(stats.max)}`,
      `Trend: ${stats.trend}`,
      `Miners: ${miners}`,
      `Share Ratio: ${shares.ratio.toFixed(1)}% (${shares.accepted}/${shares.rejected})`,
      `Data Points: ${this.data.length}`,
      `Last Update: ${new Date().toISOString()}`
    ];

    return lines.join('\n');
  }

  // データエクスポート
  exportData(timeframeMinutes?: number): HashrateData[] {
    return this.getTimeframeData(timeframeMinutes);
  }

  // データクリア
  clearData(): void {
    this.data = [];
    this.emit('dataCleared');
  }

  // データ数取得
  getDataCount(): number {
    return this.data.length;
  }

  // === プライベートメソッド ===
  private getTimeframeData(timeframeMinutes?: number): HashrateData[] {
    if (!timeframeMinutes) return [...this.data];
    
    const cutoffTime = Date.now() - (timeframeMinutes * 60 * 1000);
    return this.data.filter(d => d.timestamp >= cutoffTime);
  }

  private checkAlerts(dataPoint: HashrateData): void {
    // 低ハッシュレートアラート
    if (this.thresholds.lowHashrate > 0 && dataPoint.hashrate < this.thresholds.lowHashrate) {
      const alert: HashrateAlert = {
        type: 'low',
        threshold: this.thresholds.lowHashrate,
        current: dataPoint.hashrate,
        message: `Low hashrate detected: ${this.formatHashrate(dataPoint.hashrate)}`,
        timestamp: dataPoint.timestamp
      };
      this.emit('alert', alert);
    }

    // 急激な低下アラート
    if (this.data.length >= 2) {
      const previous = this.data[this.data.length - 2];
      const dropPercent = ((previous.hashrate - dataPoint.hashrate) / previous.hashrate) * 100;
      
      if (dropPercent > this.thresholds.highDrop) {
        const alert: HashrateAlert = {
          type: 'drop',
          threshold: this.thresholds.highDrop,
          current: dropPercent,
          message: `Hashrate dropped ${dropPercent.toFixed(1)}% in ${Math.round((dataPoint.timestamp - previous.timestamp) / 60000)} minutes`,
          timestamp: dataPoint.timestamp
        };
        this.emit('alert', alert);
      }
    }

    // 自動閾値設定
    if (this.thresholds.lowHashrate === 0 && this.data.length >= 10) {
      const stats = this.getStats();
      this.thresholds.lowHashrate = stats.average * 0.5; // 平均の50%
    }
  }

  private formatHashrate(hashrate: number): string {
    const units = [
      { value: 1e18, label: 'EH/s' },
      { value: 1e15, label: 'PH/s' },
      { value: 1e12, label: 'TH/s' },
      { value: 1e9, label: 'GH/s' },
      { value: 1e6, label: 'MH/s' },
      { value: 1e3, label: 'KH/s' }
    ];

    for (const unit of units) {
      if (hashrate >= unit.value) {
        return `${(hashrate / unit.value).toFixed(2)} ${unit.label}`;
      }
    }

    return `${hashrate.toFixed(2)} H/s`;
  }
}

// === 使用例 ===
export function createHashrateMonitor(): SimpleHashrateMonitor {
  const monitor = new SimpleHashrateMonitor();
  
  // イベントハンドラー設定
  monitor.on('alert', (alert) => {
    console.log(`🚨 ${alert.type.toUpperCase()}: ${alert.message}`);
  });

  monitor.on('dataAdded', (data) => {
    // 必要に応じてログ出力
  });

  return monitor;
}

export default SimpleHashrateMonitor;