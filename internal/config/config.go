package config

import (
	"fmt"
	"time"

	"github.com/spf13/viper"
)

// Config はアプリケーション全体の設定
type Config struct {
	Mode       string           `mapstructure:"mode"`
	LogLevel   string           `mapstructure:"log_level"`
	
	Network    NetworkConfig    `mapstructure:"network"`
	Mining     MiningConfig     `mapstructure:"mining"`
	API        APIConfig        `mapstructure:"api"`
	Monitoring MonitoringConfig `mapstructure:"monitoring"`
	Storage    StorageConfig    `mapstructure:"storage"`
	Security   SecurityConfig   `mapstructure:"security"`
	P2PPool    P2PPoolConfig    `mapstructure:"p2p_pool"`
	Stratum    StratumConfig    `mapstructure:"stratum"`
	Performance PerformanceConfig `mapstructure:"performance"`
}

// NetworkConfig はネットワーク設定
type NetworkConfig struct {
	ListenAddr     string        `mapstructure:"listen_addr"`
	MaxPeers       int           `mapstructure:"max_peers"`
	DialTimeout    time.Duration `mapstructure:"dial_timeout"`
	EnableP2P      bool          `mapstructure:"enable_p2p"`
	BootstrapPeers []string      `mapstructure:"bootstrap_peers"`
}

// MiningConfig はマイニング設定
type MiningConfig struct {
	Algorithm      string       `mapstructure:"algorithm"`
	Threads        int          `mapstructure:"threads"`
	TargetHashRate uint64       `mapstructure:"target_hash_rate"`
	EnableCPU      bool         `mapstructure:"enable_cpu"`
	EnableGPU      bool         `mapstructure:"enable_gpu"`
	EnableASIC     bool         `mapstructure:"enable_asic"`
	GPUDevices     []int        `mapstructure:"gpu_devices"`
	InitialDiff    uint32       `mapstructure:"initial_difficulty"`
	Pools          []PoolConfig `mapstructure:"pools"`
}

// PoolConfig はプール設定
type PoolConfig struct {
	URL      string `mapstructure:"url"`
	User     string `mapstructure:"user"`
	Pass     string `mapstructure:"pass"`
	Priority int    `mapstructure:"priority"`
}

// APIConfig はAPI設定
type APIConfig struct {
	Enabled      bool     `mapstructure:"enabled"`
	ListenAddr   string   `mapstructure:"listen_addr"`
	EnableTLS    bool     `mapstructure:"enable_tls"`
	CertFile     string   `mapstructure:"cert_file"`
	KeyFile      string   `mapstructure:"key_file"`
	AllowOrigins []string `mapstructure:"allow_origins"`
	RateLimit    int      `mapstructure:"rate_limit"`
}

// MonitoringConfig はモニタリング設定
type MonitoringConfig struct {
	MetricsInterval time.Duration `mapstructure:"metrics_interval"`
	EnableProfiler  bool          `mapstructure:"enable_profiler"`
	EnableTracing   bool          `mapstructure:"enable_tracing"`
	PrometheusAddr  string        `mapstructure:"prometheus_addr"`
}

// StorageConfig はストレージ設定
type StorageConfig struct {
	DataDir        string `mapstructure:"data_dir"`
	CacheSize      int    `mapstructure:"cache_size"`
	CompressData   bool   `mapstructure:"compress_data"`
	BackupInterval time.Duration `mapstructure:"backup_interval"`
}

// SecurityConfig はセキュリティ設定
type SecurityConfig struct {
	EnableEncryption bool   `mapstructure:"enable_encryption"`
	EncryptionKey    string `mapstructure:"encryption_key"`
	EnableAuth       bool   `mapstructure:"enable_auth"`
	AuthToken        string `mapstructure:"auth_token"`
	TLSMinVersion    string `mapstructure:"tls_min_version"`
}

// P2PPoolConfig はP2Pプール設定
type P2PPoolConfig struct {
	ShareDifficulty float64       `mapstructure:"share_difficulty"`
	BlockTime       time.Duration `mapstructure:"block_time"`
	PayoutThreshold float64       `mapstructure:"payout_threshold"`
	FeePercentage   float64       `mapstructure:"fee_percentage"`
}

// StratumConfig はStratum設定
type StratumConfig struct {
	Enabled    bool               `mapstructure:"enabled"`
	ListenAddr string             `mapstructure:"listen_addr"`
	MaxClients int                `mapstructure:"max_clients"`
	VarDiff    bool               `mapstructure:"var_diff"`
	MinDiff    float64            `mapstructure:"min_diff"`
	MaxDiff    float64            `mapstructure:"max_diff"`
	TargetTime int                `mapstructure:"target_time"`
	
	// Authentication settings
	RequireAuth    bool              `mapstructure:"require_auth"`
	AuthMode       string            `mapstructure:"auth_mode"` // "static", "dynamic", "database"
	StaticPassword string            `mapstructure:"static_password"`
	Workers        map[string]string `mapstructure:"workers"` // worker_name -> password
}

// PerformanceConfig はパフォーマンス設定
type PerformanceConfig struct {
	EnableOptimization bool  `mapstructure:"enable_optimization"`
	CPUAffinity        []int `mapstructure:"cpu_affinity"`
	HugePagesEnabled   bool  `mapstructure:"huge_pages_enabled"`
	GCPercent          int   `mapstructure:"gc_percent"`
}

// Load は設定ファイルを読み込む
func Load(configPath string) (*Config, error) {
	viper.SetConfigFile(configPath)
	viper.SetConfigType("yaml")
	
	// デフォルト値設定
	setDefaults()
	
	// 環境変数のバインド
	viper.AutomaticEnv()
	viper.SetEnvPrefix("OTEDAMA")
	
	// 設定ファイル読み込み
	if err := viper.ReadInConfig(); err != nil {
		return nil, fmt.Errorf("failed to read config file: %w", err)
	}
	
	// 設定値をstructにマッピング
	var cfg Config
	if err := viper.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("failed to unmarshal config: %w", err)
	}
	
	// 検証
	if err := validate(&cfg); err != nil {
		return nil, fmt.Errorf("config validation failed: %w", err)
	}
	
	return &cfg, nil
}

// setDefaults はデフォルト値を設定
func setDefaults() {
	// 基本設定
	viper.SetDefault("mode", "auto")
	viper.SetDefault("log_level", "info")
	
	// ネットワーク設定
	viper.SetDefault("network.listen_addr", ":30303")
	viper.SetDefault("network.max_peers", 50)
	viper.SetDefault("network.dial_timeout", "30s")
	viper.SetDefault("network.enable_p2p", true)
	
	// マイニング設定
	viper.SetDefault("mining.algorithm", "sha256")
	viper.SetDefault("mining.threads", 0) // 0 = auto (CPU count)
	viper.SetDefault("mining.target_hash_rate", 0)
	viper.SetDefault("mining.enable_cpu", true)
	viper.SetDefault("mining.enable_gpu", true)
	viper.SetDefault("mining.enable_asic", false)
	viper.SetDefault("mining.initial_difficulty", 0x1d00ffff)
	
	// API設定
	viper.SetDefault("api.enabled", true)
	viper.SetDefault("api.listen_addr", ":8080")
	viper.SetDefault("api.enable_tls", false)
	viper.SetDefault("api.rate_limit", 100)
	
	// モニタリング設定
	viper.SetDefault("monitoring.metrics_interval", "10s")
	viper.SetDefault("monitoring.enable_profiler", false)
	viper.SetDefault("monitoring.enable_tracing", false)
	viper.SetDefault("monitoring.prometheus_addr", ":9090")
	
	// ストレージ設定
	viper.SetDefault("storage.data_dir", "./data")
	viper.SetDefault("storage.cache_size", 1000)
	viper.SetDefault("storage.compress_data", true)
	viper.SetDefault("storage.backup_interval", "24h")
	
	// セキュリティ設定
	viper.SetDefault("security.enable_encryption", true)
	viper.SetDefault("security.enable_auth", false)
	viper.SetDefault("security.tls_min_version", "1.2")
	
	// P2Pプール設定
	viper.SetDefault("p2p_pool.share_difficulty", 1000.0)
	viper.SetDefault("p2p_pool.block_time", "10m")
	viper.SetDefault("p2p_pool.payout_threshold", 0.01)
	viper.SetDefault("p2p_pool.fee_percentage", 1.0)
	
	// Stratum設定
	viper.SetDefault("stratum.enabled", true)
	viper.SetDefault("stratum.listen_addr", ":3333")
	viper.SetDefault("stratum.max_clients", 10000)
	viper.SetDefault("stratum.var_diff", true)
	viper.SetDefault("stratum.min_diff", 100.0)
	viper.SetDefault("stratum.max_diff", 1000000.0)
	viper.SetDefault("stratum.target_time", 10)
	
	// パフォーマンス設定
	viper.SetDefault("performance.enable_optimization", true)
	viper.SetDefault("performance.huge_pages_enabled", false)
	viper.SetDefault("performance.gc_percent", 100)
}

// validate は設定値を検証
func validate(cfg *Config) error {
	// モード検証
	validModes := map[string]bool{
		"auto": true,
		"solo": true,
		"pool": true,
		"miner": true,
	}
	if !validModes[cfg.Mode] {
		return fmt.Errorf("invalid mode: %s", cfg.Mode)
	}
	
	// ネットワーク設定検証
	if cfg.Network.MaxPeers < 1 {
		return fmt.Errorf("max_peers must be at least 1")
	}
	
	// マイニング設定検証
	if cfg.Mining.Threads < 0 {
		return fmt.Errorf("mining threads cannot be negative")
	}
	
	// API設定検証
	if cfg.API.Enabled && cfg.API.ListenAddr == "" {
		return fmt.Errorf("api.listen_addr is required when API is enabled")
	}
	
	if cfg.API.EnableTLS && (cfg.API.CertFile == "" || cfg.API.KeyFile == "") {
		return fmt.Errorf("cert_file and key_file are required when TLS is enabled")
	}
	
	// P2Pプール設定検証
	if cfg.P2PPool.ShareDifficulty <= 0 {
		return fmt.Errorf("share_difficulty must be positive")
	}
	
	if cfg.P2PPool.FeePercentage < 0 || cfg.P2PPool.FeePercentage > 100 {
		return fmt.Errorf("fee_percentage must be between 0 and 100")
	}
	
	// Stratum設定検証
	if cfg.Stratum.Enabled {
		if cfg.Stratum.MinDiff <= 0 {
			return fmt.Errorf("min_diff must be positive")
		}
		if cfg.Stratum.MaxDiff <= cfg.Stratum.MinDiff {
			return fmt.Errorf("max_diff must be greater than min_diff")
		}
		if cfg.Stratum.TargetTime <= 0 {
			return fmt.Errorf("target_time must be positive")
		}
	}
	
	return nil
}