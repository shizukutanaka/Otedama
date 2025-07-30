package config

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/spf13/viper"
)

// Config represents the complete Otedama configuration - Rob Pike's clear data structures
type Config struct {
	Mode string `mapstructure:"mode" validate:"required,oneof=auto solo pool miner"`

	Mining      MiningConfig      `mapstructure:"mining"`
	ZKP         ZKPConfig         `mapstructure:"zkp"`
	P2P         P2PConfig         `mapstructure:"p2p"`
	Stratum     StratumConfig     `mapstructure:"stratum"`
	API         APIConfig         `mapstructure:"api"`
	Security    SecurityConfig    `mapstructure:"security"`
	Monitoring  MonitoringConfig  `mapstructure:"monitoring"`
	Performance PerformanceConfig `mapstructure:"performance"`
	Logging     LoggingConfig     `mapstructure:"logging"`
}

// MiningConfig contains mining-specific settings
type MiningConfig struct {
	Algorithm    string   `mapstructure:"algorithm" validate:"required"`
	CPUEnabled   bool     `mapstructure:"cpu_enabled"`
	GPUEnabled   bool     `mapstructure:"gpu_enabled"`
	ASICEnabled  bool     `mapstructure:"asic_enabled"`
	CPUThreads   int      `mapstructure:"cpu_threads"`
	GPUDevices   []int    `mapstructure:"gpu_devices"`
	ASICDevices  []string `mapstructure:"asic_devices"`
	AutoTune     bool     `mapstructure:"auto_tune"`
	Intensity    int      `mapstructure:"intensity" validate:"min=1,max=100"`
	MaxTemp      int      `mapstructure:"max_temperature" validate:"min=60,max=95"`
	PowerLimit   int      `mapstructure:"power_limit" validate:"min=50,max=400"`
}

// ZKPConfig contains Zero-Knowledge Proof settings
type ZKPConfig struct {
	Enabled            bool     `mapstructure:"enabled"`
	Protocol           string   `mapstructure:"protocol" validate:"oneof=groth16 bulletproof plonk stark"`
	SecurityLevel      int      `mapstructure:"security_level" validate:"min=128,max=256"`
	MinAge             int      `mapstructure:"min_age" validate:"min=18,max=100"`
	RequiredHashRate   uint64   `mapstructure:"required_hashrate"`
	AllowedCountries   []string `mapstructure:"allowed_countries"`
	ProofTimeout       int      `mapstructure:"proof_timeout" validate:"min=10,max=300"`
	AnonymousMining    bool     `mapstructure:"anonymous_mining"`
	InstitutionalGrade bool     `mapstructure:"institutional_grade"`
}

// P2PConfig contains peer-to-peer network settings
type P2PConfig struct {
	Port           int      `mapstructure:"port" validate:"min=1024,max=65535"`
	NodeID         string   `mapstructure:"node_id"`
	MaxPeers       int      `mapstructure:"max_peers" validate:"min=10,max=10000"`
	BootstrapNodes []string `mapstructure:"bootstrap_nodes"`
	EnableTor      bool     `mapstructure:"enable_tor"`
	EnableI2P      bool     `mapstructure:"enable_i2p"`
	DHTEnabled     bool     `mapstructure:"dht_enabled"`
}

// StratumConfig contains Stratum server settings
type StratumConfig struct {
	Port           int     `mapstructure:"port" validate:"min=1024,max=65535"`
	Difficulty     float64 `mapstructure:"difficulty" validate:"min=0.001"`
	VarDiff        bool    `mapstructure:"vardiff"`
	BlockTime      int     `mapstructure:"block_time" validate:"min=30,max=3600"`
	PayoutThreshold float64 `mapstructure:"payout_threshold" validate:"min=0.001"`
	FeePercentage  float64 `mapstructure:"fee_percentage" validate:"min=0,max=10"`
}

// APIConfig contains API server settings
type APIConfig struct {
	Port     int    `mapstructure:"port" validate:"min=1024,max=65535"`
	Host     string `mapstructure:"host"`
	TLS      bool   `mapstructure:"tls"`
	CertFile string `mapstructure:"cert_file"`
	KeyFile  string `mapstructure:"key_file"`
}

// SecurityConfig contains security settings
type SecurityConfig struct {
	DDoSProtection   bool `mapstructure:"ddos_protection"`
	RateLimit        int  `mapstructure:"rate_limit" validate:"min=10,max=10000"`
	MaxConnections   int  `mapstructure:"max_connections" validate:"min=100,max=100000"`
	IPWhitelist      []string `mapstructure:"ip_whitelist"`
	IPBlacklist      []string `mapstructure:"ip_blacklist"`
	AuditLogging     bool `mapstructure:"audit_logging"`
	ComplianceMode   bool `mapstructure:"compliance_mode"`
}

// MonitoringConfig contains monitoring settings
type MonitoringConfig struct {
	Enabled           bool   `mapstructure:"enabled"`
	PrometheusEnabled bool   `mapstructure:"prometheus_enabled"`
	PrometheusPort    int    `mapstructure:"prometheus_port" validate:"min=1024,max=65535"`
	GrafanaEnabled    bool   `mapstructure:"grafana_enabled"`
	InfluxDBURL       string `mapstructure:"influxdb_url"`
	MetricsInterval   int    `mapstructure:"metrics_interval" validate:"min=1,max=300"`
}

// PerformanceConfig contains performance optimization settings
type PerformanceConfig struct {
	HugePagesEnabled bool   `mapstructure:"huge_pages_enabled"`
	NUMAEnabled      bool   `mapstructure:"numa_enabled"`
	CPUAffinity      string `mapstructure:"cpu_affinity"`
	MemoryLimit      int    `mapstructure:"memory_limit" validate:"min=512,max=32768"`
	GCTarget         int    `mapstructure:"gc_target" validate:"min=50,max=500"`
	MaxGoroutines    int    `mapstructure:"max_goroutines" validate:"min=100,max=100000"`
}

// LoggingConfig contains logging settings
type LoggingConfig struct {
	Level      string `mapstructure:"level" validate:"oneof=debug info warn error"`
	File       string `mapstructure:"file"`
	MaxSize    int    `mapstructure:"max_size" validate:"min=1,max=1000"`
	MaxBackups int    `mapstructure:"max_backups" validate:"min=1,max=100"`
	MaxAge     int    `mapstructure:"max_age" validate:"min=1,max=365"`
	Compress   bool   `mapstructure:"compress"`
}

// Load loads configuration from file - John Carmack's error handling
func Load(configFile string) (*Config, error) {
	viper.SetConfigFile(configFile)
	viper.SetConfigType("yaml")

	// Set defaults
	setDefaults()

	// Read config file
	if err := viper.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return nil, fmt.Errorf("failed to read config file: %w", err)
		}
	}

	// Unmarshal into struct
	var config Config
	if err := viper.Unmarshal(&config); err != nil {
		return nil, fmt.Errorf("failed to unmarshal config: %w", err)
	}

	return &config, nil
}

// Save saves configuration to file
func Save(config *Config, configFile string) error {
	// Ensure directory exists
	if err := os.MkdirAll(filepath.Dir(configFile), 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	viper.SetConfigFile(configFile)
	viper.SetConfigType("yaml")

	// Marshal config to viper
	data := map[string]interface{}{
		"mode":        config.Mode,
		"mining":      config.Mining,
		"zkp":         config.ZKP,
		"p2p":         config.P2P,
		"stratum":     config.Stratum,
		"api":         config.API,
		"security":    config.Security,
		"monitoring":  config.Monitoring,
		"performance": config.Performance,
		"logging":     config.Logging,
	}

	for key, value := range data {
		viper.Set(key, value)
	}

	return viper.WriteConfig()
}

// Default creates default configuration - Rob Pike's sensible defaults
func Default() *Config {
	return &Config{
		Mode: "auto",
		Mining: MiningConfig{
			Algorithm:   "auto",
			CPUEnabled:  true,
			GPUEnabled:  true,
			ASICEnabled: true,
			CPUThreads:  0, // Auto-detect
			AutoTune:    true,
			Intensity:   80,
			MaxTemp:     85,
			PowerLimit:  250,
		},
		ZKP: ZKPConfig{
			Enabled:            true,
			Protocol:           "groth16",
			SecurityLevel:      256,
			MinAge:             18,
			RequiredHashRate:   1000000, // 1 MH/s
			ProofTimeout:       60,
			AnonymousMining:    true,
			InstitutionalGrade: false,
		},
		P2P: P2PConfig{
			Port:           30303,
			MaxPeers:       100,
			BootstrapNodes: getDefaultBootstrapNodes(),
			DHTEnabled:     true,
		},
		Stratum: StratumConfig{
			Port:            3333,
			Difficulty:      1.0,
			VarDiff:         true,
			BlockTime:       600, // 10 minutes
			PayoutThreshold: 0.01,
			FeePercentage:   1.0,
		},
		API: APIConfig{
			Port: 8080,
			Host: "localhost",
			TLS:  false,
		},
		Security: SecurityConfig{
			DDoSProtection: true,
			RateLimit:      1000,
			MaxConnections: 10000,
			AuditLogging:   false,
			ComplianceMode: false,
		},
		Monitoring: MonitoringConfig{
			Enabled:           true,
			PrometheusEnabled: false,
			PrometheusPort:    9090,
			MetricsInterval:   30,
		},
		Performance: PerformanceConfig{
			HugePagesEnabled: false,
			NUMAEnabled:      false,
			MemoryLimit:      4096, // 4GB
			GCTarget:         100,
			MaxGoroutines:    10000,
		},
		Logging: LoggingConfig{
			Level:      "info",
			File:       "logs/otedama.log",
			MaxSize:    100, // MB
			MaxBackups: 10,
			MaxAge:     30, // days
			Compress:   true,
		},
	}
}

// Validate validates the configuration - Robert C. Martin's fail-fast principle
func (c *Config) Validate() error {
	// Mode validation
	validModes := map[string]bool{
		"auto": true, "solo": true, "pool": true, "miner": true,
	}
	if !validModes[c.Mode] {
		return fmt.Errorf("invalid mode: %s", c.Mode)
	}

	// Mining validation
	if !c.Mining.CPUEnabled && !c.Mining.GPUEnabled && !c.Mining.ASICEnabled {
		return fmt.Errorf("at least one hardware type must be enabled")
	}

	// ZKP validation
	if c.ZKP.Enabled {
		validProtocols := map[string]bool{
			"groth16": true, "bulletproof": true, "plonk": true, "stark": true,
		}
		if !validProtocols[c.ZKP.Protocol] {
			return fmt.Errorf("invalid ZKP protocol: %s", c.ZKP.Protocol)
		}
	}

	// Port validation
	ports := []int{c.P2P.Port, c.Stratum.Port, c.API.Port}
	if c.Monitoring.PrometheusEnabled {
		ports = append(ports, c.Monitoring.PrometheusPort)
	}
	
	for i, port1 := range ports {
		if port1 < 1024 || port1 > 65535 {
			return fmt.Errorf("invalid port: %d", port1)
		}
		for j, port2 := range ports {
			if i != j && port1 == port2 {
				return fmt.Errorf("duplicate port: %d", port1)
			}
		}
	}

	return nil
}

// setDefaults sets default values for viper
func setDefaults() {
	// Basic defaults
	viper.SetDefault("mode", "auto")
	
	// Mining defaults
	viper.SetDefault("mining.algorithm", "auto")
	viper.SetDefault("mining.cpu_enabled", true)
	viper.SetDefault("mining.gpu_enabled", true)
	viper.SetDefault("mining.asic_enabled", true)
	viper.SetDefault("mining.cpu_threads", runtime.NumCPU())
	viper.SetDefault("mining.auto_tune", true)
	viper.SetDefault("mining.intensity", 80)
	viper.SetDefault("mining.max_temperature", 85)
	viper.SetDefault("mining.power_limit", 250)
	
	// ZKP defaults
	viper.SetDefault("zkp.enabled", true)
	viper.SetDefault("zkp.protocol", "groth16")
	viper.SetDefault("zkp.security_level", 256)
	viper.SetDefault("zkp.min_age", 18)
	viper.SetDefault("zkp.required_hashrate", 1000000)
	viper.SetDefault("zkp.proof_timeout", 60)
	viper.SetDefault("zkp.anonymous_mining", true)
	
	// Network defaults
	viper.SetDefault("p2p.port", 30303)
	viper.SetDefault("p2p.max_peers", 100)
	viper.SetDefault("p2p.dht_enabled", true)
	viper.SetDefault("stratum.port", 3333)
	viper.SetDefault("stratum.difficulty", 1.0)
	viper.SetDefault("stratum.vardiff", true)
	viper.SetDefault("api.port", 8080)
	viper.SetDefault("api.host", "localhost")
	
	// Security defaults
	viper.SetDefault("security.ddos_protection", true)
	viper.SetDefault("security.rate_limit", 1000)
	viper.SetDefault("security.max_connections", 10000)
	
	// Performance defaults
	viper.SetDefault("performance.memory_limit", 4096)
	viper.SetDefault("performance.gc_target", 100)
	viper.SetDefault("performance.max_goroutines", 10000)
	
	// Logging defaults
	viper.SetDefault("logging.level", "info")
	viper.SetDefault("logging.file", "logs/otedama.log")
	viper.SetDefault("logging.max_size", 100)
	viper.SetDefault("logging.max_backups", 10)
	viper.SetDefault("logging.max_age", 30)
	viper.SetDefault("logging.compress", true)
}

// getDefaultBootstrapNodes returns default bootstrap nodes for P2P network
func getDefaultBootstrapNodes() []string {
	return []string{
		"bootstrap1.otedama.network:30303",
		"bootstrap2.otedama.network:30303",
		"bootstrap3.otedama.network:30303",
	}
}

// OptimizeForHardware optimizes configuration based on detected hardware
func (c *Config) OptimizeForHardware() {
	// CPU optimization
	if c.Mining.CPUThreads == 0 {
		c.Mining.CPUThreads = runtime.NumCPU()
	}
	
	// Memory optimization based on available RAM
	// This would require hardware detection - simplified for now
	if c.Performance.MemoryLimit == 0 {
		c.Performance.MemoryLimit = 4096 // Default 4GB
	}
	
	// Enable performance features on capable systems
	if runtime.GOOS == "linux" {
		c.Performance.HugePagesEnabled = true
		c.Performance.NUMAEnabled = runtime.NumCPU() > 8
	}
}

// SecureDefaults applies security-focused defaults for enterprise deployment
func (c *Config) SecureDefaults() {
	c.Security.DDoSProtection = true
	c.Security.AuditLogging = true
	c.Security.ComplianceMode = true
	c.ZKP.InstitutionalGrade = true
	c.ZKP.SecurityLevel = 256
	c.API.TLS = true
	c.Logging.Level = "info" // Don't log sensitive debug info
}
