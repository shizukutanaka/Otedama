/**
 * Otedama共通型定義
 * 全モジュール間で共有される型を定義
 */

// === 基本型定義 ===
export type LogLevel = 'debug' | 'info' | 'warning' | 'error';
export type RiskTolerance = 'conservative' | 'balanced' | 'aggressive';
export type MiningStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
export type ComponentStatus = boolean;

// === ハードウェア関連 ===
export interface HardwareConfig {
  monitoring: boolean;
  autoOptimization: boolean;
  thermalProtection: boolean;
  powerManagement: boolean;
}

export interface PerformanceMetrics {
  totalHashrate: number;
  totalPower: number;
  efficiency: number;
  temperature: {
    cpu: number;
    gpu: number[];
  };
  profitability: number;
}

// === マイニング関連 ===
export interface MiningConfig {
  algorithms: string[];
  autoSwitch: boolean;
  profitabilityCheck: number;
  maxPowerConsumption?: number;
  targetEfficiency?: number;
}

// === プール関連 ===
export interface PoolsConfig {
  primary: string[];
  backup: string[];
  autoFailover: boolean;
  latencyThreshold: number;
}

// === セキュリティ関連 ===
export interface SecurityConfig {
  encryption: boolean;
  auditLogging: boolean;
  threatDetection: boolean;
  accessControl: boolean;
}

// === AI関連 ===
export interface AIConfig {
  enabled: boolean;
  learningRate: number;
  optimizationInterval: number;
  riskTolerance: RiskTolerance;
}

// === UI関連 ===
export interface UIConfig {
  dashboard: boolean;
  mobileApp: boolean;
  webPort: number;
  apiPort: number;
}

// === アプリケーション設定 ===
export interface AppConfig {
  name: string;
  version: string;
  autoStart: boolean;
  logLevel: LogLevel;
}

// === システム状態 ===
export interface ComponentsStatus {
  mining: ComponentStatus;
  monitoring: ComponentStatus;
  ai: ComponentStatus;
  security: ComponentStatus;
  pools: ComponentStatus;
  dashboard: ComponentStatus;
}

// === アルゴリズム関連 ===
export interface AlgorithmResult {
  hash: string;
  nonce: number;
  valid: boolean;
  difficulty?: number;
  hashrate?: number;
  mixHash?: string;
}

export interface AlgorithmHeader {
  version: number;
  prevHash: string;
  merkleRoot: string;
  timestamp: number;
  bits: number;
  nonce: number;
  height?: number;
  mixHash?: string;
  extraNonce?: string;
  headerHash?: string;
}

// === エラー型 ===
export class OtedamaError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'OtedamaError';
  }
}

export class ConfigurationError extends OtedamaError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigurationError';
  }
}

export class HardwareError extends OtedamaError {
  constructor(message: string) {
    super(message, 'HARDWARE_ERROR');
    this.name = 'HardwareError';
  }
}

export class NetworkError extends OtedamaError {
  constructor(message: string) {
    super(message, 'NETWORK_ERROR');
    this.name = 'NetworkError';
  }
}

// === ユーティリティ型 ===
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type RequiredFields<T, K extends keyof T> = T & Required<Pick<T, K>>;

export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

// === イベント型 ===
export interface BaseEvent {
  timestamp: number;
  id: string;
}

export interface StatusChangeEvent extends BaseEvent {
  type: 'statusChange';
  oldStatus: MiningStatus;
  newStatus: MiningStatus;
}

export interface AlertEvent extends BaseEvent {
  type: 'alert';
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  component: string;
}

export interface MetricsEvent extends BaseEvent {
  type: 'metrics';
  metrics: PerformanceMetrics;
}

export type OtedamaEvent = StatusChangeEvent | AlertEvent | MetricsEvent;

// === レスポンス型 ===
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}

export interface HealthCheckResponse {
  status: 'healthy' | 'warning' | 'critical';
  components: ComponentsStatus;
  uptime: number;
  version: string;
}

// === ログ関連 ===
export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
  component: string;
  data?: any;
}

// === 設定検証 ===
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// === デフォルト設定 ===
export const DEFAULT_CONFIG = {
  app: {
    name: 'Otedama',
    version: '2.1.0',
    autoStart: false,
    logLevel: 'info' as LogLevel
  },
  mining: {
    algorithms: ['randomx', 'kawpow', 'ethash'],
    autoSwitch: true,
    profitabilityCheck: 300,
    maxPowerConsumption: 2000,
    targetEfficiency: 0.15
  },
  pools: {
    primary: ['monero_ocean', 'flypool_rvn'],
    backup: ['nicehash', 'mining_pool_hub'],
    autoFailover: true,
    latencyThreshold: 150
  },
  hardware: {
    monitoring: true,
    autoOptimization: true,
    thermalProtection: true,
    powerManagement: true
  },
  security: {
    encryption: true,
    auditLogging: true,
    threatDetection: true,
    accessControl: true
  },
  ai: {
    enabled: true,
    learningRate: 0.01,
    optimizationInterval: 60000,
    riskTolerance: 'balanced' as RiskTolerance
  },
  ui: {
    dashboard: true,
    mobileApp: true,
    webPort: 3000,
    apiPort: 8080
  }
} as const;