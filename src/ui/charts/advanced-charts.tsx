/**
 * Advanced Chart Components
 * Chart.js統合とエクスポート機能
 * 
 * 設計思想：
 * - Carmack: 高速レンダリングと効率的なデータ更新
 * - Martin: 再利用可能なチャートコンポーネント
 * - Pike: シンプルで使いやすいAPI
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  Chart as ChartJS,
  ChartConfiguration,
  ChartType,
  registerables,
  ChartOptions,
  TooltipItem
} from 'chart.js';
import { saveAs } from 'file-saver';

// Chart.js プラグイン登録
ChartJS.register(...registerables);

// === 型定義 ===
export interface ChartProps {
  type: ChartType;
  data: any;
  options?: ChartOptions;
  height?: number | string;
  width?: number | string;
  theme?: 'light' | 'dark';
  exportEnabled?: boolean;
  exportFilename?: string;
  onDataPointClick?: (dataPoint: any) => void;
  realtime?: boolean;
  maxDataPoints?: number;
}

export interface ChartTheme {
  gridColor: string;
  textColor: string;
  backgroundColor: string;
  borderColor: string;
  tooltipBackground: string;
  tooltipBorder: string;
  tooltipText: string;
}

// === テーマ定義 ===
const chartThemes: Record<'light' | 'dark', ChartTheme> = {
  light: {
    gridColor: 'rgba(0, 0, 0, 0.1)',
    textColor: '#666666',
    backgroundColor: '#ffffff',
    borderColor: '#cccccc',
    tooltipBackground: '#ffffff',
    tooltipBorder: '#cccccc',
    tooltipText: '#000000'
  },
  dark: {
    gridColor: 'rgba(255, 255, 255, 0.1)',
    textColor: '#aaaaaa',
    backgroundColor: '#1a1a1a',
    borderColor: '#333333',
    tooltipBackground: '#2a2a2a',
    tooltipBorder: '#444444',
    tooltipText: '#ffffff'
  }
};

// === 高度なチャートコンポーネント ===
export const AdvancedChart: React.FC<ChartProps> = ({
  type,
  data,
  options = {},
  height = 300,
  width = '100%',
  theme = 'dark',
  exportEnabled = true,
  exportFilename = 'chart',
  onDataPointClick,
  realtime = false,
  maxDataPoints = 100
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<ChartJS | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  
  // テーマの取得
  const currentTheme = chartThemes[theme];
  
  // チャートオプションのマージ
  const mergedOptions: ChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index' as const,
      intersect: false
    },
    animation: {
      duration: realtime ? 0 : 750
    },
    ...options,
    plugins: {
      ...options.plugins,
      legend: {
        ...options.plugins?.legend,
        labels: {
          ...options.plugins?.legend?.labels,
          color: currentTheme.textColor
        }
      },
      tooltip: {
        ...options.plugins?.tooltip,
        backgroundColor: currentTheme.tooltipBackground,
        borderColor: currentTheme.tooltipBorder,
        borderWidth: 1,
        titleColor: currentTheme.tooltipText,
        bodyColor: currentTheme.tooltipText,
        callbacks: {
          ...options.plugins?.tooltip?.callbacks,
          label: options.plugins?.tooltip?.callbacks?.label || ((context: TooltipItem<any>) => {
            const label = context.dataset.label || '';
            const value = context.parsed.y;
            return `${label}: ${formatValue(value)}`;
          })
        }
      }
    },
    scales: type !== 'pie' && type !== 'doughnut' && type !== 'radar' ? {
      ...options.scales,
      x: {
        ...options.scales?.x,
        grid: {
          ...options.scales?.x?.grid,
          color: currentTheme.gridColor
        },
        ticks: {
          ...options.scales?.x?.ticks,
          color: currentTheme.textColor
        }
      },
      y: {
        ...options.scales?.y,
        grid: {
          ...options.scales?.y?.grid,
          color: currentTheme.gridColor
        },
        ticks: {
          ...options.scales?.y?.ticks,
          color: currentTheme.textColor
        }
      }
    } : undefined,
    onClick: onDataPointClick ? (event, elements) => {
      if (elements.length > 0) {
        const element = elements[0];
        const datasetIndex = element.datasetIndex;
        const index = element.index;
        const dataset = data.datasets[datasetIndex];
        const value = dataset.data[index];
        const label = data.labels?.[index];
        
        onDataPointClick({
          datasetIndex,
          index,
          dataset,
          value,
          label,
          event
        });
      }
    } : undefined
  };
  
  // チャートの初期化
  useEffect(() => {
    if (!canvasRef.current) return;
    
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;
    
    // 既存のチャートを破棄
    if (chartRef.current) {
      chartRef.current.destroy();
    }
    
    // 新しいチャートを作成
    const config: ChartConfiguration = {
      type,
      data: { ...data },
      options: mergedOptions
    };
    
    chartRef.current = new ChartJS(ctx, config);
    
    return () => {
      if (chartRef.current) {
        chartRef.current.destroy();
      }
    };
  }, [type, theme]); // typeとthemeが変更されたときのみ再作成
  
  // データの更新
  useEffect(() => {
    if (!chartRef.current) return;
    
    // リアルタイムモードでのデータポイント制限
    if (realtime && data.labels && data.labels.length > maxDataPoints) {
      const trimmedData = {
        ...data,
        labels: data.labels.slice(-maxDataPoints),
        datasets: data.datasets.map((dataset: any) => ({
          ...dataset,
          data: dataset.data.slice(-maxDataPoints)
        }))
      };
      chartRef.current.data = trimmedData;
    } else {
      chartRef.current.data = data;
    }
    
    chartRef.current.update(realtime ? 'none' : undefined);
  }, [data, realtime, maxDataPoints]);
  
  // オプションの更新
  useEffect(() => {
    if (!chartRef.current) return;
    
    chartRef.current.options = mergedOptions;
    chartRef.current.update();
  }, [options, theme]);
  
  // エクスポート機能
  const exportChart = useCallback((format: 'png' | 'jpg' | 'svg' | 'pdf') => {
    if (!chartRef.current) return;
    
    switch (format) {
      case 'png':
      case 'jpg':
        chartRef.current.canvas.toBlob((blob) => {
          if (blob) {
            saveAs(blob, `${exportFilename}.${format}`);
          }
        }, `image/${format === 'jpg' ? 'jpeg' : format}`);
        break;
        
      case 'svg':
        // SVGエクスポートは別途実装が必要
        const svgString = chartToSVG(chartRef.current);
        const blob = new Blob([svgString], { type: 'image/svg+xml' });
        saveAs(blob, `${exportFilename}.svg`);
        break;
        
      case 'pdf':
        // PDFエクスポートは別途実装が必要
        exportChartAsPDF(chartRef.current, exportFilename);
        break;
    }
  }, [exportFilename]);
  
  // データのエクスポート
  const exportData = useCallback((format: 'csv' | 'json') => {
    if (!chartRef.current) return;
    
    const chartData = chartRef.current.data;
    
    if (format === 'json') {
      const jsonData = {
        labels: chartData.labels,
        datasets: chartData.datasets.map((dataset: any) => ({
          label: dataset.label,
          data: dataset.data,
          backgroundColor: dataset.backgroundColor,
          borderColor: dataset.borderColor
        }))
      };
      
      const blob = new Blob([JSON.stringify(jsonData, null, 2)], {
        type: 'application/json'
      });
      saveAs(blob, `${exportFilename}-data.json`);
      
    } else if (format === 'csv') {
      const rows: string[] = [];
      
      // ヘッダー
      const headers = ['Label', ...chartData.datasets.map((d: any) => d.label)];
      rows.push(headers.join(','));
      
      // データ行
      chartData.labels?.forEach((label: any, index: number) => {
        const row = [
          label,
          ...chartData.datasets.map((dataset: any) => dataset.data[index])
        ];
        rows.push(row.join(','));
      });
      
      const csv = rows.join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      saveAs(blob, `${exportFilename}-data.csv`);
    }
  }, [exportFilename]);
  
  // フルスクリーン切り替え
  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    
    if (!isFullscreen) {
      if (containerRef.current.requestFullscreen) {
        containerRef.current.requestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
    
    setIsFullscreen(!isFullscreen);
  }, [isFullscreen]);
  
  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        height: typeof height === 'number' ? `${height}px` : height,
        width,
        backgroundColor: currentTheme.backgroundColor,
        borderRadius: '8px',
        padding: '16px'
      }}
    >
      {/* エクスポートボタン */}
      {exportEnabled && (
        <div style={{
          position: 'absolute',
          top: '8px',
          right: '8px',
          display: 'flex',
          gap: '4px',
          zIndex: 10
        }}>
          <button
            onClick={() => exportChart('png')}
            style={buttonStyle}
            title="Export as PNG"
          >
            📷
          </button>
          <button
            onClick={() => exportData('csv')}
            style={buttonStyle}
            title="Export data as CSV"
          >
            📊
          </button>
          <button
            onClick={() => exportData('json')}
            style={buttonStyle}
            title="Export data as JSON"
          >
            📄
          </button>
          <button
            onClick={toggleFullscreen}
            style={buttonStyle}
            title="Toggle fullscreen"
          >
            {isFullscreen ? '🗙' : '⛶'}
          </button>
        </div>
      )}
      
      {/* チャートキャンバス */}
      <canvas ref={canvasRef} />
    </div>
  );
};

// === ユーティリティ関数 ===
const formatValue = (value: any): string => {
  if (typeof value === 'number') {
    if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
    return value.toFixed(2);
  }
  return String(value);
};

const buttonStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #333',
  borderRadius: '4px',
  padding: '4px 8px',
  cursor: 'pointer',
  fontSize: '14px',
  color: '#aaa',
  transition: 'all 0.2s'
};

// SVGエクスポート（簡略版）
const chartToSVG = (chart: ChartJS): string => {
  // 実際の実装では、Chart.jsのキャンバスをSVGに変換
  return '<svg></svg>';
};

// PDFエクスポート（簡略版）
const exportChartAsPDF = (chart: ChartJS, filename: string): void => {
  // 実際の実装では、jsPDFなどを使用
  console.log('PDF export not implemented');
};

// === プリセットチャート ===
export const HashrateChart: React.FC<{
  data: Array<{ timestamp: number; poolHashrate: number; networkHashrate: number }>;
  theme?: 'light' | 'dark';
  height?: number;
}> = ({ data, theme = 'dark', height = 300 }) => {
  const chartData = {
    labels: data.map(d => new Date(d.timestamp).toLocaleTimeString()),
    datasets: [
      {
        label: 'Pool Hashrate',
        data: data.map(d => d.poolHashrate),
        borderColor: '#00ff41',
        backgroundColor: 'rgba(0, 255, 65, 0.1)',
        tension: 0.4,
        fill: true
      },
      {
        label: 'Network Hashrate',
        data: data.map(d => d.networkHashrate),
        borderColor: '#ff0080',
        backgroundColor: 'rgba(255, 0, 128, 0.1)',
        tension: 0.4,
        fill: true
      }
    ]
  };
  
  const options: ChartOptions<'line'> = {
    plugins: {
      tooltip: {
        callbacks: {
          label: (context) => {
            const value = context.parsed.y;
            return `${context.dataset.label}: ${formatHashrate(value)}`;
          }
        }
      }
    },
    scales: {
      y: {
        ticks: {
          callback: (value) => formatHashrate(value as number)
        }
      }
    }
  };
  
  return (
    <AdvancedChart
      type="line"
      data={chartData}
      options={options}
      height={height}
      theme={theme}
      realtime={true}
      maxDataPoints={60}
      exportFilename="hashrate-history"
    />
  );
};

export const MinerDistributionChart: React.FC<{
  miners: Array<{ address: string; hashrate: number }>;
  theme?: 'light' | 'dark';
  height?: number;
}> = ({ miners, theme = 'dark', height = 300 }) => {
  const topMiners = miners.sort((a, b) => b.hashrate - a.hashrate).slice(0, 5);
  const otherHashrate = miners.slice(5).reduce((sum, m) => sum + m.hashrate, 0);
  
  const chartData = {
    labels: [...topMiners.map(m => m.address.slice(0, 8) + '...'), 'Others'],
    datasets: [{
      data: [...topMiners.map(m => m.hashrate), otherHashrate],
      backgroundColor: [
        '#00ff41',
        '#ff0080',
        '#00bfff',
        '#ffcc00',
        '#ff3333',
        '#666666'
      ]
    }]
  };
  
  const options: ChartOptions<'doughnut'> = {
    plugins: {
      legend: {
        position: 'right' as const
      },
      tooltip: {
        callbacks: {
          label: (context) => {
            const label = context.label || '';
            const value = context.parsed;
            const total = context.dataset.data.reduce((a: number, b: number) => a + b, 0);
            const percentage = ((value / total) * 100).toFixed(1);
            return `${label}: ${formatHashrate(value)} (${percentage}%)`;
          }
        }
      }
    }
  };
  
  return (
    <AdvancedChart
      type="doughnut"
      data={chartData}
      options={options}
      height={height}
      theme={theme}
      exportFilename="miner-distribution"
    />
  );
};

// ハッシュレートフォーマット
const formatHashrate = (hashrate: number): string => {
  if (hashrate >= 1e15) return `${(hashrate / 1e15).toFixed(2)} PH/s`;
  if (hashrate >= 1e12) return `${(hashrate / 1e12).toFixed(2)} TH/s`;
  if (hashrate >= 1e9) return `${(hashrate / 1e9).toFixed(2)} GH/s`;
  if (hashrate >= 1e6) return `${(hashrate / 1e6).toFixed(2)} MH/s`;
  if (hashrate >= 1e3) return `${(hashrate / 1e3).toFixed(2)} KH/s`;
  return `${hashrate.toFixed(2)} H/s`;
};

export default AdvancedChart;