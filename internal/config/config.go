package config

import (
	"runtime"
	"time"
)

// Top-level configuration struct that encapsulates all settings.
// This design follows Rob Pike's principle of clear and simple data structures.
type Config struct {
	System      SystemConfig      `yaml:"system"`
	Logging     LoggingConfig     `yaml:"logging"`
	Network     NetworkConfig     `yaml:"network"`
	API         APIConfig         `yaml:"api"`
	Security    SecurityConfig    `yaml:"security"`
	Mining      MiningConfig      `yaml:"mining"`
	Pool        PoolConfig        `yaml:"pool"`
	Monitoring  MonitoringConfig  `yaml:"monitoring"`
	Database    DatabaseConfig    `yaml:"database"`
	Performance PerformanceConfig `yaml:"performance"`
}

// SystemConfig contains general system-level settings.
type SystemConfig struct {
	NodeID          string        `yaml:"node_id"`
	DataDir         string        `yaml:"data_dir"`
	MaxCPU          int           `yaml:"max_cpu"`
	MaxMemoryMB     int           `yaml:"max_memory_mb"`
	GracefulTimeout time.Duration `yaml:"graceful_timeout"`
}

// LoggingConfig mirrors the structure in the logging package for consistency.
type LoggingConfig struct {
	Level           string                 `yaml:"level"`
	Format          string                 `yaml:"format"`
	OutputPath      string                 `yaml:"output_path"`
	ErrorOutputPath string                 `yaml:"error_output_path"`
	Rotation        RotationConfig         `yaml:"rotation"`
	ModuleLevels    map[string]string      `yaml:"module_levels"`
	EnableCaller    bool                   `yaml:"enable_caller"`
	EnableStacktrace bool                  `yaml:"enable_stacktrace"`
	Development     bool                   `yaml:"development"`
	Sampling        *SamplingConfig        `yaml:"sampling"`
	InitialFields   map[string]interface{} `yaml:"initial_fields"`
}

// RotationConfig for logging, matches the one in the logging package.
type RotationConfig struct {
	MaxSize    int  `yaml:"max_size_mb"`
	MaxAge     int  `yaml:"max_age_days"`
	MaxBackups int  `yaml:"max_backups"`
	Compress   bool `yaml:"compress"`
	LocalTime  bool `yaml:"local_time"`
}

// SamplingConfig for logging, matches the one in the logging package.
type SamplingConfig struct {
	Enabled    bool `yaml:"enabled"`
	Initial    int  `yaml:"initial"`
	Thereafter int  `yaml:"thereafter"`
}

// NetworkConfig contains settings for P2P and Stratum networking.
type NetworkConfig struct {
	P2P     P2PConfig     `yaml:"p2p"`
	Stratum StratumConfig `yaml:"stratum"`
}

// P2PConfig defines the peer-to-peer network settings.
type P2PConfig struct {
	Enable         bool     `yaml:"enable"`
	Enabled        bool     `yaml:"enabled"`
	ListenAddr     string   `yaml:"listen_addr"`
	BootstrapPeers []string `yaml:"bootstrap_peers"`
	BootstrapNodes []string `yaml:"bootstrap_nodes"`
	MaxPeers       int      `yaml:"max_peers"`
	EnableDiscovery bool    `yaml:"enable_discovery"`
}

// StratumConfig defines the Stratum server settings for miners.
type StratumConfig struct {
	Enable         bool          `yaml:"enable"`
	Enabled        bool          `yaml:"enabled"`
	ListenAddr     string        `yaml:"listen_addr"`
	MaxConnections int           `yaml:"max_connections"`
	MaxClients     int           `yaml:"max_clients"`
	Difficulty     float64       `yaml:"difficulty"`
	MinDifficulty  float64       `yaml:"min_difficulty"`
	MaxDifficulty  float64       `yaml:"max_difficulty"`
	ExtraNonceSize int           `yaml:"extra_nonce_size"`
	TargetTime     time.Duration `yaml:"target_time"`
	RetargetTime   time.Duration `yaml:"retarget_time"`
	VariancePercent float64      `yaml:"variance_percent"`
	VarDiffWindow  int           `yaml:"vardiff_window"`
}

// APIConfig contains settings for the HTTP API.
type APIConfig struct {
	Enabled      bool     `yaml:"enabled"`
	ListenAddr   string   `yaml:"listen_addr"`
	TLSEnabled   bool     `yaml:"tls_enabled"`
	TLSCert      string   `yaml:"tls_cert"`
	TLSKey       string   `yaml:"tls_key"`
	AllowOrigins []string `yaml:"allow_origins"`
	EnableAuth   bool     `yaml:"enable_auth"`
	EnableCORS   bool     `yaml:"enable_cors"`
	EnableDocs   bool     `yaml:"enable_docs"`
	RateLimit    int      `yaml:"rate_limit"`
}

// SecurityConfig holds all security-related settings.
type SecurityConfig struct {
	AuthEnabled bool   `yaml:"auth_enabled"`
	JWTSecret   string `yaml:"jwt_secret"`
	RateLimit   int    `yaml:"rate_limit"`
}

// MiningConfig contains settings for the mining workers.
type MiningConfig struct {
	Algorithm    string                 `yaml:"algorithm"`
	CPUThreads   int                    `yaml:"cpu_threads"`
	GPUEnabled   bool                   `yaml:"gpu_enabled"`
	GPUDevices   []int                  `yaml:"gpu_devices"`
	ASICDevices  []string               `yaml:"asic_devices"`
	Intensity    int                    `yaml:"intensity"`
	AutoOptimize bool                   `yaml:"auto_optimize"`
	Pools        []MiningPoolConfig     `yaml:"pools"`
}

// MiningPoolConfig defines connection details for a single mining pool.
type MiningPoolConfig struct {
	URL      string `yaml:"url"`
	User     string `yaml:"user"`
	Password string `yaml:"password"`
	Priority int    `yaml:"priority"`
}

// PoolConfig contains settings for running as a mining pool.
type PoolConfig struct {
	Enable           bool    `yaml:"enable"`
	Enabled          bool    `yaml:"enabled"`
	Address          string  `yaml:"address"`
	URL              string  `yaml:"url"`
	WalletAddress    string  `yaml:"wallet_address"`
	WorkerName       string  `yaml:"worker_name"`
	Password         string  `yaml:"password"`
	MaxConnections   int     `yaml:"max_connections"`
	FeePercentage    float64 `yaml:"fee_percentage"`
	PayoutScheme     string  `yaml:"payout_scheme"`
	MinimumPayout    float64 `yaml:"minimum_payout"`
	PayoutInterval   time.Duration `yaml:"payout_interval"`
	PoolFeePercent   float64 `yaml:"pool_fee_percent"`
	DonationAddress  string  `yaml:"donation_address"`
	OperatorAddress  string  `yaml:"operator_address"`
}

// MonitoringConfig contains settings for metrics and monitoring.
type MonitoringConfig struct {
	PrometheusEnabled bool          `yaml:"prometheus_enabled"`
	PrometheusAddr    string        `yaml:"prometheus_addr"`
	Prometheus        bool          `yaml:"prometheus"`
	EnableDashboard   bool          `yaml:"enable_dashboard"`
	ListenAddr        string        `yaml:"listen_addr"`
	MetricsInterval   time.Duration `yaml:"metrics_interval"`
}

// DatabaseConfig contains settings for the database connection.
type DatabaseConfig struct {
	Type             string        `yaml:"type"`
	DSN              string        `yaml:"dsn"`
	MaxConnections   int           `yaml:"max_connections"`
	MaxIdleConns     int           `yaml:"max_idle_conns"`
	ConnMaxLifetime  time.Duration `yaml:"conn_max_lifetime"`
}

// PerformanceConfig contains performance optimization settings.
type PerformanceConfig struct {
	MaxMemoryMB     int  `yaml:"max_memory_mb"`
	MaxJobQueueSize int  `yaml:"max_job_queue_size"`
	HugePages       bool `yaml:"huge_pages"`
	NUMA            bool `yaml:"numa"`
	CacheSize       int  `yaml:"cache_size_mb"`
}

// DefaultConfig returns a configuration with sensible default values.
// This follows John Carmack's principle of having a working state out-of-the-box.
func DefaultConfig() *Config {
	return &Config{
		System: SystemConfig{
			NodeID:          "otedama-node",
			DataDir:         "./data",
			MaxCPU:          runtime.NumCPU(),
			MaxMemoryMB:     2048,
			GracefulTimeout: 30 * time.Second,
		},
		Performance: PerformanceConfig{
			MaxMemoryMB:     4096,
			MaxJobQueueSize: 1000,
			HugePages:       false,
			NUMA:            false,
			CacheSize:       256,
		},
		Logging: LoggingConfig{
			Level:           "info",
			Format:          "json",
			OutputPath:      "logs/otedama.log",
			ErrorOutputPath: "logs/otedama_error.log",
			Rotation: RotationConfig{
				MaxSize:    100,
				MaxAge:     30,
				MaxBackups: 10,
				Compress:   true,
			},
			EnableCaller: true,
		},
		Network: NetworkConfig{
			P2P: P2PConfig{
				Enabled:    true,
				ListenAddr: ":18555",
				MaxPeers:   50,
			},
			Stratum: StratumConfig{
				Enabled:    true,
				ListenAddr: ":3333",
				MaxClients: 100,
				Difficulty: 1000,
			},
		},
		API: APIConfig{
			Enabled:    true,
			ListenAddr: ":8080",
		},
		Security: SecurityConfig{
			AuthEnabled: false,
			RateLimit:   100,
		},
		Mining: MiningConfig{
			Algorithm:  "randomx",
			CPUThreads: runtime.NumCPU(),
			Intensity:  5,
		},
		Pool: PoolConfig{
			Enabled:         false,
			PayoutScheme:    "PPLNS",
			MinimumPayout:   0.1,
			PoolFeePercent:  1.0,
			DonationAddress: "1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa", // Default donation address
			OperatorAddress: "1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa", // Default operator address
		},
		Monitoring: MonitoringConfig{
			PrometheusEnabled: true,
			PrometheusAddr:    ":9090",
		},
		Database: DatabaseConfig{
			Type:           "sqlite",
			DSN:            "data/otedama.db",
			MaxConnections: 20,
		},
	}
}