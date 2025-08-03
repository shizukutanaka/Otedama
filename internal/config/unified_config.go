package config

import (
    "time"
)

// UnifiedConfig represents the complete configuration for Otedama
type UnifiedConfig struct {
    // General settings
    General GeneralConfig `mapstructure:"general"`
    
    // Core components
    Mining     MiningConfig     `mapstructure:"mining"`
    Pool       PoolConfig       `mapstructure:"pool"`
    API        APIConfig        `mapstructure:"api"`
    Stratum    StratumConfig    `mapstructure:"stratum"`
    P2P        P2PConfig        `mapstructure:"p2p"`
    
    // Support components
    Monitoring MonitoringConfig `mapstructure:"monitoring"`
    Security   SecurityConfig   `mapstructure:"security"`
    Hardware   HardwareConfig   `mapstructure:"hardware"`
    Logging    LoggingConfig    `mapstructure:"logging"`
}

// GeneralConfig contains general settings
type GeneralConfig struct {
    LogLevel string `mapstructure:"log_level"`
    DataDir  string `mapstructure:"data_dir"`
}

// MiningConfig contains mining settings
type MiningConfig struct {
    Algorithm   string `mapstructure:"algorithm"`
    Threads     int    `mapstructure:"threads"`
    GPUEnabled  bool   `mapstructure:"gpu_enabled"`
    GPUDevices  []int  `mapstructure:"gpu_devices"`
    Intensity   int    `mapstructure:"intensity"`
}

// PoolConfig contains pool settings
type PoolConfig struct {
    URL         string        `mapstructure:"url"`
    User        string        `mapstructure:"user"`
    Password    string        `mapstructure:"password"`
    Timeout     time.Duration `mapstructure:"timeout"`
    PoolFee     float64       `mapstructure:"pool_fee"`     // Pool fee percentage (0-100)
    FeeAddress  string        `mapstructure:"fee_address"`  // Fee collection address (read-only)
}

// APIConfig contains API server settings
type APIConfig struct {
    Enabled bool   `mapstructure:"enabled"`
    Listen  string `mapstructure:"listen"`
    APIKey  string `mapstructure:"api_key"`
}

// StratumConfig contains stratum server settings
type StratumConfig struct {
    Enabled    bool   `mapstructure:"enabled"`
    Listen     string `mapstructure:"listen"`
    MaxClients int    `mapstructure:"max_clients"`
}

// P2PConfig contains P2P network settings
type P2PConfig struct {
    Enabled   bool     `mapstructure:"enabled"`
    Listen    string   `mapstructure:"listen"`
    MaxPeers  int      `mapstructure:"max_peers"`
    Bootstrap []string `mapstructure:"bootstrap"`
}

// MonitoringConfig contains monitoring settings
type MonitoringConfig struct {
    Enabled    bool   `mapstructure:"enabled"`
    Prometheus bool   `mapstructure:"prometheus"`
    Listen     string `mapstructure:"listen"`
}

// SecurityConfig contains security settings
type SecurityConfig struct {
    EnableTLS bool   `mapstructure:"enable_tls"`
    CertFile  string `mapstructure:"cert_file"`
    KeyFile   string `mapstructure:"key_file"`
}

// HardwareConfig contains hardware monitoring settings
type HardwareConfig struct {
    TempWarning  int `mapstructure:"temp_warning"`
    TempCritical int `mapstructure:"temp_critical"`
    TempShutdown int `mapstructure:"temp_shutdown"`
}

// LoggingConfig contains logging settings
type LoggingConfig struct {
    Level      string `mapstructure:"level"`
    File       string `mapstructure:"file"`
    MaxSize    int    `mapstructure:"max_size"`
    MaxBackups int    `mapstructure:"max_backups"`
    MaxAge     int    `mapstructure:"max_age"`
}

// ValidateConfig ensures critical configuration values are protected
func ValidateConfig(cfg *UnifiedConfig) {
    // Always override fee address with protected value
    cfg.Pool.FeeAddress = GetOperatorFeeAddress()
    
    // Ensure pool fee meets minimum sustainable level
    if cfg.Pool.PoolFee < GetMinimumPoolFee() {
        cfg.Pool.PoolFee = GetMinimumPoolFee()
    }
}

// DefaultConfig returns default configuration
func DefaultConfig() *UnifiedConfig {
    return &UnifiedConfig{
        General: GeneralConfig{
            LogLevel: "info",
            DataDir:  "./data",
        },
        Mining: MiningConfig{
            Algorithm: "SHA256d",
            Threads:   0, // auto-detect
            Intensity: 16,
        },
        Pool: PoolConfig{
            URL:        "stratum+tcp://pool.example.com:3333",
            User:       "worker",
            Password:   "x",
            Timeout:    30 * time.Second,
            PoolFee:    0.5, // Minimum sustainable fee (0.5%)
            FeeAddress: GetOperatorFeeAddress(), // Protected operator fee address
        },
        API: APIConfig{
            Enabled: true,
            Listen:  ":8080",
        },
        Monitoring: MonitoringConfig{
            Enabled: true,
            Listen:  ":9090",
        },
        Hardware: HardwareConfig{
            TempWarning:  80,
            TempCritical: 85,
            TempShutdown: 90,
        },
        Logging: LoggingConfig{
            Level:      "info",
            MaxSize:    100,
            MaxBackups: 3,
            MaxAge:     28,
        },
    }
}