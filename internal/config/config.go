package config

import (
	"errors"
	"fmt"
	"io/ioutil"
	"os"
	"time"

	"gopkg.in/yaml.v3"
)

// Config represents the main configuration structure
type Config struct {
	Mining     MiningConfig     `yaml:"mining"`
	Stratum    StratumConfig    `yaml:"stratum"`
	P2P        P2PConfig        `yaml:"p2p"`
	API        APIConfig        `yaml:"api"`
	Security   SecurityConfig   `yaml:"security"`
	Monitoring MonitoringConfig `yaml:"monitoring"`
	Logging    LoggingConfig    `yaml:"logging"`
	Database   DatabaseConfig   `yaml:"database"`
	Backup     BackupConfig     `yaml:"backup"`
	Update     UpdateConfig     `yaml:"update"`
}

// MiningConfig contains mining configuration
type MiningConfig struct {
	Algorithm    string           `yaml:"algorithm"`
	AutoStart    bool             `yaml:"auto_start"`
	AutoSelect   bool             `yaml:"auto_select"`
	CPU          CPUConfig        `yaml:"cpu"`
	GPU          GPUConfig        `yaml:"gpu"`
	ASIC         ASICConfig       `yaml:"asic"`
	Optimization OptimizationConfig `yaml:"optimization"`
}

// CPUConfig contains CPU mining configuration
type CPUConfig struct {
	Enabled   bool   `yaml:"enabled"`
	Threads   int    `yaml:"threads"`
	Affinity  []int  `yaml:"affinity"`
	Priority  string `yaml:"priority"`
	HugePages bool   `yaml:"huge_pages"`
}

// GPUConfig contains GPU mining configuration
type GPUConfig struct {
	Enabled          bool    `yaml:"enabled"`
	Devices          []int   `yaml:"devices"`
	Intensity        int     `yaml:"intensity"`
	TemperatureLimit float64 `yaml:"temperature_limit"`
	PowerLimit       float64 `yaml:"power_limit"`
	MemoryClock      int     `yaml:"memory_clock"`
	CoreClock        int     `yaml:"core_clock"`
}

// ASICConfig contains ASIC mining configuration
type ASICConfig struct {
	Enabled   bool     `yaml:"enabled"`
	Devices   []string `yaml:"devices"`
	Frequency int      `yaml:"frequency"`
}

// OptimizationConfig contains optimization settings
type OptimizationConfig struct {
	PowerMode        string  `yaml:"power_mode"`
	AutoTuning       bool    `yaml:"auto_tuning"`
	TuningInterval   int     `yaml:"tuning_interval"`
	TargetEfficiency float64 `yaml:"target_efficiency"`
	PowerLimit       float64 `yaml:"power_limit"`
	TempLimit        float64 `yaml:"temp_limit"`
}

// StratumConfig contains Stratum configuration
type StratumConfig struct {
	Enabled        bool         `yaml:"enabled"`
	Version        int          `yaml:"version"`
	Pools          []PoolConfig `yaml:"pools"`
	MaxRetries     int          `yaml:"max_retries"`
	RetryDelay     int          `yaml:"retry_delay"`
	Keepalive      int          `yaml:"keepalive"`
	Timeout        int          `yaml:"timeout"`
	ExtrannonceSize int         `yaml:"extranonce_size"`
}

// PoolConfig contains mining pool configuration
type PoolConfig struct {
	URL      string `yaml:"url"`
	User     string `yaml:"user"`
	Password string `yaml:"password"`
	Priority int    `yaml:"priority"`
	Enabled  bool   `yaml:"enabled"`
}

// P2PConfig contains P2P network configuration
type P2PConfig struct {
	Enable              bool     `yaml:"enable"`
	Port                int      `yaml:"port"`
	ExternalPort        int      `yaml:"external_port"`
	MaxPeers            int      `yaml:"max_peers"`
	MinPeers            int      `yaml:"min_peers"`
	PeerExchange        bool     `yaml:"peer_exchange"`
	EnableDiscovery     bool     `yaml:"enable_discovery"`
	BootstrapNodes      []string `yaml:"bootstrap_nodes"`
	EnableUPNP          bool     `yaml:"enable_upnp"`
	EnableNATPMP        bool     `yaml:"enable_nat_pmp"`
	EnableRelay         bool     `yaml:"enable_relay"`
	MaxUploadBandwidth  int      `yaml:"max_upload_bandwidth"`
	MaxDownloadBandwidth int     `yaml:"max_download_bandwidth"`
}

// APIConfig contains API configuration
type APIConfig struct {
	Enable    bool               `yaml:"enable"`
	Address   string             `yaml:"address"`
	CORS      CORSConfig         `yaml:"cors"`
	Auth      AuthConfig         `yaml:"auth"`
	RateLimit RateLimitConfig    `yaml:"rate_limit"`
	WebSocket WebSocketConfig    `yaml:"websocket"`
}

// CORSConfig contains CORS configuration
type CORSConfig struct {
	Enabled     bool     `yaml:"enabled"`
	Origins     []string `yaml:"origins"`
	Credentials bool     `yaml:"credentials"`
	MaxAge      int      `yaml:"max_age"`
}

// AuthConfig contains authentication configuration
type AuthConfig struct {
	Enabled            bool          `yaml:"enabled"`
	JWTSecret          string        `yaml:"jwt_secret"`
	TokenExpiry        time.Duration `yaml:"token_expiry"`
	RefreshTokenExpiry time.Duration `yaml:"refresh_token_expiry"`
	RequireMFA         bool          `yaml:"require_mfa"`
}

// RateLimitConfig contains rate limiting configuration
type RateLimitConfig struct {
	Enabled           bool             `yaml:"enabled"`
	RequestsPerMinute int              `yaml:"requests_per_minute"`
	Burst             int              `yaml:"burst"`
	Endpoints         []EndpointLimit  `yaml:"endpoints"`
}

// EndpointLimit contains per-endpoint rate limits
type EndpointLimit struct {
	Path              string `yaml:"path"`
	RequestsPerMinute int    `yaml:"requests_per_minute"`
}

// WebSocketConfig contains WebSocket configuration
type WebSocketConfig struct {
	Enabled        bool `yaml:"enabled"`
	PingInterval   int  `yaml:"ping_interval"`
	PongTimeout    int  `yaml:"pong_timeout"`
	MaxMessageSize int  `yaml:"max_message_size"`
}

// SecurityConfig contains security configuration
type SecurityConfig struct {
	RSAKeySize           int      `yaml:"rsa_key_size"`
	AESKeySize           int      `yaml:"aes_key_size"`
	RotateKeysEvery      int      `yaml:"rotate_keys_every"`
	MinPasswordLength    int      `yaml:"min_password_length"`
	RequireStrongPassword bool    `yaml:"require_strong_password"`
	PasswordHistory      int      `yaml:"password_history"`
	MaxLoginAttempts     int      `yaml:"max_login_attempts"`
	LockoutDuration      int      `yaml:"lockout_duration"`
	SessionTimeout       int      `yaml:"session_timeout"`
	MaxSessions          int      `yaml:"max_sessions"`
	MaxConnectionsPerIP  int      `yaml:"max_connections_per_ip"`
	BanThreshold         int      `yaml:"ban_threshold"`
	BanDuration          int      `yaml:"ban_duration"`
	AllowedIPs           []string `yaml:"allowed_ips"`
	BlockedIPs           []string `yaml:"blocked_ips"`
	AllowedCountries     []string `yaml:"allowed_countries"`
	BlockedCountries     []string `yaml:"blocked_countries"`
	TLS                  TLSConfig `yaml:"tls"`
}

// TLSConfig contains TLS configuration
type TLSConfig struct {
	Enabled      bool     `yaml:"enabled"`
	CertFile     string   `yaml:"cert_file"`
	KeyFile      string   `yaml:"key_file"`
	MinVersion   string   `yaml:"min_version"`
	CipherSuites []string `yaml:"cipher_suites"`
}

// MonitoringConfig contains monitoring configuration
type MonitoringConfig struct {
	Enable      bool              `yaml:"enable"`
	MetricsPort int               `yaml:"metrics_port"`
	HealthPort  int               `yaml:"health_port"`
	Prometheus  PrometheusConfig  `yaml:"prometheus"`
	Health      HealthConfig      `yaml:"health"`
	Alerting    AlertingConfig    `yaml:"alerting"`
}

// PrometheusConfig contains Prometheus configuration
type PrometheusConfig struct {
	Enabled   bool   `yaml:"enabled"`
	Namespace string `yaml:"namespace"`
	Subsystem string `yaml:"subsystem"`
}

// HealthConfig contains health check configuration
type HealthConfig struct {
	LivenessPath  string `yaml:"liveness_path"`
	ReadinessPath string `yaml:"readiness_path"`
	StartupPath   string `yaml:"startup_path"`
}

// AlertingConfig contains alerting configuration
type AlertingConfig struct {
	Enabled  bool            `yaml:"enabled"`
	Channels []AlertChannel  `yaml:"channels"`
	Rules    []AlertRule     `yaml:"rules"`
}

// AlertChannel contains alert channel configuration
type AlertChannel struct {
	Type     string `yaml:"type"`
	URL      string `yaml:"url"`
	Enabled  bool   `yaml:"enabled"`
	SMTPHost string `yaml:"smtp_host"`
	SMTPPort int    `yaml:"smtp_port"`
	From     string `yaml:"from"`
	To       []string `yaml:"to"`
}

// AlertRule contains alert rule configuration
type AlertRule struct {
	Name      string `yaml:"name"`
	Condition string `yaml:"condition"`
	Severity  string `yaml:"severity"`
	Message   string `yaml:"message"`
}

// LoggingConfig contains logging configuration
type LoggingConfig struct {
	Level    string        `yaml:"level"`
	Output   string        `yaml:"output"`
	File     FileLogConfig `yaml:"file"`
	Format   string        `yaml:"format"`
	Sampling SamplingConfig `yaml:"sampling"`
}

// FileLogConfig contains file logging configuration
type FileLogConfig struct {
	Enabled    bool   `yaml:"enabled"`
	Path       string `yaml:"path"`
	MaxSize    int    `yaml:"max_size"`
	MaxBackups int    `yaml:"max_backups"`
	MaxAge     int    `yaml:"max_age"`
	Compress   bool   `yaml:"compress"`
}

// SamplingConfig contains log sampling configuration
type SamplingConfig struct {
	Enabled    bool `yaml:"enabled"`
	Initial    int  `yaml:"initial"`
	Thereafter int  `yaml:"thereafter"`
}

// DatabaseConfig contains database configuration
type DatabaseConfig struct {
	Type     string         `yaml:"type"`
	SQLite   SQLiteConfig   `yaml:"sqlite"`
	Postgres PostgresConfig `yaml:"postgres"`
}

// SQLiteConfig contains SQLite configuration
type SQLiteConfig struct {
	Path        string `yaml:"path"`
	WALMode     bool   `yaml:"wal_mode"`
	ForeignKeys bool   `yaml:"foreign_keys"`
}

// PostgresConfig contains PostgreSQL configuration
type PostgresConfig struct {
	Host                   string `yaml:"host"`
	Port                   int    `yaml:"port"`
	Database               string `yaml:"database"`
	Username               string `yaml:"username"`
	Password               string `yaml:"password"`
	SSLMode                string `yaml:"ssl_mode"`
	MaxConnections         int    `yaml:"max_connections"`
	MaxIdleConnections     int    `yaml:"max_idle_connections"`
	ConnectionMaxLifetime  int    `yaml:"connection_max_lifetime"`
}

// BackupConfig contains backup configuration
type BackupConfig struct {
	Enabled      bool                `yaml:"enabled"`
	Interval     int                 `yaml:"interval"`
	Destinations []BackupDestination `yaml:"destinations"`
}

// BackupDestination contains backup destination configuration
type BackupDestination struct {
	Type          string `yaml:"type"`
	Path          string `yaml:"path"`
	RetentionDays int    `yaml:"retention_days"`
	Enabled       bool   `yaml:"enabled"`
	Bucket        string `yaml:"bucket"`
	Region        string `yaml:"region"`
	AccessKey     string `yaml:"access_key"`
	SecretKey     string `yaml:"secret_key"`
}

// UpdateConfig contains update configuration
type UpdateConfig struct {
	AutoUpdate     bool         `yaml:"auto_update"`
	CheckInterval  int          `yaml:"check_interval"`
	UpdateChannel  string       `yaml:"update_channel"`
	Server         UpdateServer `yaml:"server"`
}

// UpdateServer contains update server configuration
type UpdateServer struct {
	URL       string `yaml:"url"`
	PublicKey string `yaml:"public_key"`
}

// Load loads configuration from file
func Load(filename string) (*Config, error) {
	// Check if file exists
	if _, err := os.Stat(filename); os.IsNotExist(err) {
		// Try to use example config
		if _, err := os.Stat("config.yaml.example"); err == nil {
			filename = "config.yaml.example"
		} else {
			return nil, fmt.Errorf("configuration file not found: %s", filename)
		}
	}

	// Read file
	data, err := ioutil.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("failed to read configuration file: %w", err)
	}

	// Parse YAML
	var config Config
	if err := yaml.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse configuration: %w", err)
	}

	// Set defaults
	setDefaults(&config)

	// Validate
	if err := Validate(&config); err != nil {
		return nil, fmt.Errorf("invalid configuration: %w", err)
	}

	// Expand environment variables
	expandEnvVars(&config)

	return &config, nil
}

// LoadFromFile loads configuration from a specific file
func LoadFromFile(filename string) (*Config, error) {
	return Load(filename)
}

// setDefaults sets default values for configuration
func setDefaults(cfg *Config) {
	// Mining defaults
	if cfg.Mining.Algorithm == "" {
		cfg.Mining.Algorithm = "sha256d"
	}
	if cfg.Mining.CPU.Threads == 0 {
		cfg.Mining.CPU.Threads = -1 // Auto-detect
	}
	if cfg.Mining.GPU.Intensity == 0 {
		cfg.Mining.GPU.Intensity = 20
	}
	if cfg.Mining.Optimization.PowerMode == "" {
		cfg.Mining.Optimization.PowerMode = "balanced"
	}

	// API defaults
	if cfg.API.Address == "" {
		cfg.API.Address = ":8080"
	}
	if cfg.API.RateLimit.RequestsPerMinute == 0 {
		cfg.API.RateLimit.RequestsPerMinute = 60
	}
	if cfg.API.RateLimit.Burst == 0 {
		cfg.API.RateLimit.Burst = 10
	}

	// P2P defaults
	if cfg.P2P.Port == 0 {
		cfg.P2P.Port = 18555
	}
	if cfg.P2P.MaxPeers == 0 {
		cfg.P2P.MaxPeers = 100
	}
	if cfg.P2P.MinPeers == 0 {
		cfg.P2P.MinPeers = 10
	}

	// Monitoring defaults
	if cfg.Monitoring.MetricsPort == 0 {
		cfg.Monitoring.MetricsPort = 9090
	}
	if cfg.Monitoring.HealthPort == 0 {
		cfg.Monitoring.HealthPort = 8081
	}

	// Security defaults
	if cfg.Security.RSAKeySize == 0 {
		cfg.Security.RSAKeySize = 4096
	}
	if cfg.Security.AESKeySize == 0 {
		cfg.Security.AESKeySize = 256
	}
	if cfg.Security.MinPasswordLength == 0 {
		cfg.Security.MinPasswordLength = 12
	}
	if cfg.Security.MaxLoginAttempts == 0 {
		cfg.Security.MaxLoginAttempts = 5
	}
	if cfg.Security.MaxConnectionsPerIP == 0 {
		cfg.Security.MaxConnectionsPerIP = 10
	}

	// Logging defaults
	if cfg.Logging.Level == "" {
		cfg.Logging.Level = "info"
	}
	if cfg.Logging.Output == "" {
		cfg.Logging.Output = "both"
	}
	if cfg.Logging.Format == "" {
		cfg.Logging.Format = "json"
	}
}

// Validate validates the configuration
func Validate(cfg *Config) error {
	// Validate mining algorithm
	validAlgorithms := []string{"sha256d", "scrypt", "ethash", "randomx", "cryptonight", "x11", "blake2b"}
	validAlgo := false
	for _, algo := range validAlgorithms {
		if cfg.Mining.Algorithm == algo {
			validAlgo = true
			break
		}
	}
	if !validAlgo {
		return fmt.Errorf("invalid mining algorithm: %s", cfg.Mining.Algorithm)
	}

	// Validate power mode
	validPowerModes := []string{"efficiency", "balanced", "performance", "turbo"}
	validMode := false
	for _, mode := range validPowerModes {
		if cfg.Mining.Optimization.PowerMode == mode {
			validMode = true
			break
		}
	}
	if !validMode {
		return fmt.Errorf("invalid power mode: %s", cfg.Mining.Optimization.PowerMode)
	}

	// Validate pool configuration
	if cfg.Stratum.Enabled && len(cfg.Stratum.Pools) == 0 {
		return errors.New("stratum enabled but no pools configured")
	}

	// Validate API configuration
	if cfg.API.Enable && cfg.API.Address == "" {
		return errors.New("API enabled but no address configured")
	}

	// Validate security
	if cfg.Security.MinPasswordLength < 8 {
		return errors.New("minimum password length must be at least 8")
	}

	return nil
}

// expandEnvVars expands environment variables in configuration
func expandEnvVars(cfg *Config) {
	// Expand JWT secret
	if cfg.API.Auth.JWTSecret == "${JWT_SECRET}" {
		if secret := os.Getenv("JWT_SECRET"); secret != "" {
			cfg.API.Auth.JWTSecret = secret
		}
	}

	// Expand database password
	if cfg.Database.Postgres.Password == "${DB_PASSWORD}" {
		if password := os.Getenv("DB_PASSWORD"); password != "" {
			cfg.Database.Postgres.Password = password
		}
	}

	// Expand other environment variables as needed
}

// Save saves configuration to file
func Save(cfg *Config, filename string) error {
	data, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("failed to marshal configuration: %w", err)
	}

	if err := ioutil.WriteFile(filename, data, 0644); err != nil {
		return fmt.Errorf("failed to write configuration file: %w", err)
	}

	return nil
}
