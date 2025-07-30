package config

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"
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
	ZKP        ZKPConfig        `mapstructure:"zkp"`
	Privacy    PrivacyConfig    `mapstructure:"privacy"`
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
	Algorithm        string       `mapstructure:"algorithm"`
	HardwareType     string       `mapstructure:"hardware_type"` // auto, cpu, gpu, asic
	AutoDetect       bool         `mapstructure:"auto_detect"`
	Threads          int          `mapstructure:"threads"`
	Intensity        int          `mapstructure:"intensity"`
	WorkSize         int          `mapstructure:"work_size"`
	MaxTemperature   int          `mapstructure:"max_temperature"`
	PowerLimit       int          `mapstructure:"power_limit"`
	AutoTuning       bool         `mapstructure:"auto_tuning"`
	TargetHashRate   uint64       `mapstructure:"target_hash_rate"`
	
	// Legacy support - will be converted to HardwareType
	EnableCPU        bool         `mapstructure:"enable_cpu"`
	EnableGPU        bool         `mapstructure:"enable_gpu"`
	EnableASIC       bool         `mapstructure:"enable_asic"`
	
	// Hardware specific
	GPUDevices       []int        `mapstructure:"gpu_devices"`
	EnableCUDA       bool         `mapstructure:"enable_cuda"`
	EnableOpenCL     bool         `mapstructure:"enable_opencl"`
	
	InitialDiff      uint32       `mapstructure:"initial_difficulty"`
	Pools            []PoolConfig `mapstructure:"pools"`
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

// ZKPConfig はゼロ知識証明設定
type ZKPConfig struct {
	Enabled                 bool          `mapstructure:"enabled"`
	ProofExpiry            time.Duration `mapstructure:"proof_expiry"`
	RequireAgeProof        bool          `mapstructure:"require_age_proof"`
	MinAgeRequirement      int           `mapstructure:"min_age_requirement"`
	RequireHashpowerProof  bool          `mapstructure:"require_hashpower_proof"`
	MinHashpowerRequirement float64       `mapstructure:"min_hashpower_requirement"`
	RequireReputationProof bool          `mapstructure:"require_reputation_proof"`
	MinReputationScore     float64       `mapstructure:"min_reputation_score"`
	AuditLogEnabled        bool          `mapstructure:"audit_log_enabled"`
	TrustedVerifiers       []string      `mapstructure:"trusted_verifiers"`
}

// PrivacyConfig はプライバシー設定
type PrivacyConfig struct {
	EnableTor        bool `mapstructure:"enable_tor"`
	EnableI2P        bool `mapstructure:"enable_i2p"`
	AnonymousMining  bool `mapstructure:"anonymous_mining"`
	HideIPAddresses  bool `mapstructure:"hide_ip_addresses"`
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
	viper.SetDefault("mining.algorithm", "sha256d")
	viper.SetDefault("mining.hardware_type", "auto")
	viper.SetDefault("mining.auto_detect", true)
	viper.SetDefault("mining.threads", 0) // 0 = auto (CPU count)
	viper.SetDefault("mining.intensity", 100)
	viper.SetDefault("mining.work_size", 262144) // 256KB
	viper.SetDefault("mining.max_temperature", 85) // Celsius
	viper.SetDefault("mining.power_limit", 250) // Watts
	viper.SetDefault("mining.auto_tuning", false)
	viper.SetDefault("mining.target_hash_rate", 0)
	viper.SetDefault("mining.enable_cpu", true) // Legacy support
	viper.SetDefault("mining.enable_gpu", true)
	viper.SetDefault("mining.enable_asic", false)
	viper.SetDefault("mining.enable_cuda", true)
	viper.SetDefault("mining.enable_opencl", true)
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
	
	// ZKP設定
	viper.SetDefault("zkp.enabled", true)
	viper.SetDefault("zkp.proof_expiry", "24h")
	viper.SetDefault("zkp.require_age_proof", true)
	viper.SetDefault("zkp.min_age_requirement", 18)
	viper.SetDefault("zkp.require_hashpower_proof", true)
	viper.SetDefault("zkp.min_hashpower_requirement", 1000.0)
	viper.SetDefault("zkp.require_reputation_proof", false)
	viper.SetDefault("zkp.min_reputation_score", 0.5)
	viper.SetDefault("zkp.audit_log_enabled", true)
	
	// プライバシー設定
	viper.SetDefault("privacy.enable_tor", false)
	viper.SetDefault("privacy.enable_i2p", false)
	viper.SetDefault("privacy.anonymous_mining", true)
	viper.SetDefault("privacy.hide_ip_addresses", true)
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
	
	// Convert legacy config to new format
	if cfg.Mining.HardwareType == "" {
		if cfg.Mining.EnableASIC {
			cfg.Mining.HardwareType = "asic"
		} else if cfg.Mining.EnableGPU {
			cfg.Mining.HardwareType = "gpu"
		} else if cfg.Mining.EnableCPU {
			cfg.Mining.HardwareType = "cpu"
		} else {
			cfg.Mining.HardwareType = "auto"
		}
	}
	
	// Validate hardware type
	validHardwareTypes := map[string]bool{
		"auto": true,
		"cpu": true,
		"gpu": true,
		"asic": true,
	}
	if !validHardwareTypes[cfg.Mining.HardwareType] {
		return fmt.Errorf("invalid hardware_type: %s", cfg.Mining.HardwareType)
	}
	
	// Validate algorithm
	validAlgorithms := map[string]bool{
		"sha256d": true,
		"ethash": true,
		"kawpow": true,
		"randomx": true,
		"scrypt": true,
		"progpow": true,
		"cuckoo": true,
	}
	if !validAlgorithms[cfg.Mining.Algorithm] {
		return fmt.Errorf("invalid algorithm: %s", cfg.Mining.Algorithm)
	}
	
	// Validate intensity
	if cfg.Mining.Intensity < 1 || cfg.Mining.Intensity > 100 {
		return fmt.Errorf("intensity must be between 1 and 100")
	}
	
	// Validate temperature
	if cfg.Mining.MaxTemperature < 0 || cfg.Mining.MaxTemperature > 110 {
		return fmt.Errorf("max_temperature must be between 0 and 110")
	}
	
	// Validate power limit
	if cfg.Mining.PowerLimit < 0 || cfg.Mining.PowerLimit > 5000 {
		return fmt.Errorf("power_limit must be between 0 and 5000")
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
	
	
	// ZKP設定検証
	if cfg.ZKP.Enabled {
		if cfg.ZKP.MinAgeRequirement < 0 {
			return fmt.Errorf("min_age_requirement cannot be negative")
		}
		if cfg.ZKP.MinHashpowerRequirement < 0 {
			return fmt.Errorf("min_hashpower_requirement cannot be negative")
		}
		if cfg.ZKP.MinReputationScore < 0 || cfg.ZKP.MinReputationScore > 1 {
			return fmt.Errorf("min_reputation_score must be between 0 and 1")
		}
	}
	
	// ストレージ設定検証
	if cfg.Storage.DataDir == "" {
		return fmt.Errorf("storage.data_dir cannot be empty")
	}
	
	// セキュリティ設定検証
	if cfg.Security.EnableEncryption && cfg.Security.EncryptionKey == "" {
		return fmt.Errorf("encryption_key is required when encryption is enabled")
	}
	
	return nil
}

// GenerateSampleConfig generates a sample configuration file
func GenerateSampleConfig(path string) error {
	// Create default config
	cfg := &Config{
		Mode:     "auto",
		LogLevel: "info",
		
		Network: NetworkConfig{
			ListenAddr:  ":30303",
			MaxPeers:    50,
			DialTimeout: 30 * time.Second,
			EnableP2P:   true,
			BootstrapPeers: []string{
				"peer1.example.com:30303",
				"peer2.example.com:30303",
			},
		},
		
		Mining: MiningConfig{
			Algorithm:      "sha256d",
			HardwareType:   "auto",
			AutoDetect:     true,
			Threads:        0,
			Intensity:      100,
			WorkSize:       262144,
			MaxTemperature: 85,
			PowerLimit:     250,
			AutoTuning:     false,
			Pools: []PoolConfig{
				{
					URL:      "stratum+tcp://pool.example.com:3333",
					User:     "your_wallet_address",
					Pass:     "x",
					Priority: 1,
				},
			},
		},
		
		API: APIConfig{
			Enabled:      true,
			ListenAddr:   ":8080",
			EnableTLS:    false,
			AllowOrigins: []string{"*"},
			RateLimit:    100,
		},
		
		P2PPool: P2PPoolConfig{
			ShareDifficulty: 1000.0,
			BlockTime:       10 * time.Minute,
			PayoutThreshold: 0.01,
			FeePercentage:   1.0,
		},
		
		ZKP: ZKPConfig{
			Enabled:                 true,
			ProofExpiry:            24 * time.Hour,
			RequireAgeProof:        true,
			MinAgeRequirement:      18,
			RequireHashpowerProof:  true,
			MinHashpowerRequirement: 1000000.0, // 1 MH/s
			AuditLogEnabled:        true,
		},
		
		Storage: StorageConfig{
			DataDir:        "./data",
			CacheSize:      1000,
			CompressData:   true,
			BackupInterval: 24 * time.Hour,
		},
		
		Privacy: PrivacyConfig{
			AnonymousMining: true,
			HideIPAddresses: true,
		},
	}
	
	// Create directory if needed
	dir := filepath.Dir(path)
	if dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return fmt.Errorf("failed to create directory: %w", err)
		}
	}
	
	// Marshal to YAML
	data, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}
	
	// Write to file
	if err := os.WriteFile(path, data, 0644); err != nil {
		return fmt.Errorf("failed to write config file: %w", err)
	}
	
	return nil
}

// LoadOrGenerate loads config or generates a new one if it doesn't exist
func LoadOrGenerate(configPath string) (*Config, error) {
	// Check if config exists
	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		// Generate sample config
		if err := GenerateSampleConfig(configPath); err != nil {
			return nil, fmt.Errorf("failed to generate config: %w", err)
		}
		fmt.Printf("Generated sample configuration at %s\n", configPath)
		fmt.Println("Please review and modify the configuration before starting.")
		return nil, fmt.Errorf("configuration file created, please review and restart")
	}
	
	// Load existing config
	return Load(configPath)
}

// ValidateDataDir validates and creates data directory if needed
func ValidateDataDir(dataDir string) error {
	// Create data directory if it doesn't exist
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return fmt.Errorf("failed to create data directory: %w", err)
	}
	
	// Check write permissions
	testFile := filepath.Join(dataDir, ".test")
	if err := os.WriteFile(testFile, []byte("test"), 0644); err != nil {
		return fmt.Errorf("data directory is not writable: %w", err)
	}
	os.Remove(testFile)
	
	return nil
}

// GetMiningAlgorithm returns the configured mining algorithm
func (c *Config) GetMiningAlgorithm() string {
	return c.Mining.Algorithm
}

// GetHardwareType returns the configured hardware type
func (c *Config) GetHardwareType() string {
	if c.Mining.HardwareType == "" {
		return "auto"
	}
	return c.Mining.HardwareType
}

// IsZKPEnabled returns whether ZKP is enabled
func (c *Config) IsZKPEnabled() bool {
	return c.ZKP.Enabled
}

// GetDataDir returns the data directory with expanded path
func (c *Config) GetDataDir() string {
	// Expand home directory if needed
	if c.Storage.DataDir == "~" || len(c.Storage.DataDir) > 1 && c.Storage.DataDir[:2] == "~/" {
		home, err := os.UserHomeDir()
		if err == nil {
			if c.Storage.DataDir == "~" {
				return home
			}
			return filepath.Join(home, c.Storage.DataDir[2:])
		}
	}
	
	// Convert to absolute path
	abs, err := filepath.Abs(c.Storage.DataDir)
	if err != nil {
		return c.Storage.DataDir
	}
	return abs
}

// GetLogLevel returns the configured log level
func (c *Config) GetLogLevel() string {
	if c.LogLevel == "" {
		return "info"
	}
	return c.LogLevel
}

// ShouldEnableTor returns whether Tor should be enabled
func (c *Config) ShouldEnableTor() bool {
	return c.Privacy.EnableTor
}

// GetAPIAddress returns the API listen address
func (c *Config) GetAPIAddress() string {
	if c.API.ListenAddr == "" {
		return ":8080"
	}
	return c.API.ListenAddr
}

// GetP2PAddress returns the P2P listen address
func (c *Config) GetP2PAddress() string {
	if c.Network.ListenAddr == "" {
		return ":30303"
	}
	return c.Network.ListenAddr
}

// GetStratumAddress returns the Stratum listen address
func (c *Config) GetStratumAddress() string {
	if !c.Stratum.Enabled {
		return ""
	}
	if c.Stratum.ListenAddr == "" {
		return ":3333"
	}
	return c.Stratum.ListenAddr
}