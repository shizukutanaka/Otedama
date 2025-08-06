package common

import "time"

// Mining Algorithm Constants
const (
	AlgorithmSHA256d = "sha256d"
	AlgorithmScrypt  = "scrypt"
	AlgorithmEthash  = "ethash"
)

// Network Constants
const (
	DefaultStratumPort     = 3333
	DefaultAPIPort         = 8080
	DefaultP2PPort         = 9333
	DefaultRPCPort         = 8332
	
	MaxMessageSize         = 10 * 1024 * 1024 // 10MB
	ConnectionTimeout      = 30 * time.Second
	HandshakeTimeout       = 10 * time.Second
	PingInterval           = 30 * time.Second
	PingTimeout            = 60 * time.Second
)

// Mining Constants
const (
	DefaultDifficulty      = 1.0
	ShareTargetTime        = 10 * time.Second
	BlockTargetTime        = 10 * time.Minute
	
	MaxNonceValue          = uint32(0xFFFFFFFF)
	NonceIncrement         = 1
	
	WorkQueueSize          = 100
	ResultQueueSize        = 1000
)

// Hardware Constants
const (
	// CPU Mining
	DefaultCPUThreads      = -1 // Auto-detect
	CPUCacheLineSize       = 64
	CPUBatchSize           = 1024
	
	// GPU Mining
	DefaultGPUIntensity    = 20
	DefaultGPUWorkSize     = 256
	GPUMaxTemperature      = 85
	GPUTargetTemperature   = 75
	
	// ASIC Mining
	ASICPollInterval       = 5 * time.Second
	ASICCommandTimeout     = 5 * time.Second
	ASICMaxRetries         = 3
)

// Pool Constants
const (
	DefaultPoolFee         = 1.0 // 1%
	MinPoolFee             = 0.0
	MaxPoolFee             = 5.0
	
	DefaultPayoutThreshold = 0.01
	MinPayoutThreshold     = 0.001
	
	ShareWindow            = 1 * time.Hour
	PayoutInterval         = 24 * time.Hour
)

// Security Constants
const (
	MaxLoginAttempts       = 5
	LoginAttemptWindow     = 15 * time.Minute
	SessionTimeout         = 24 * time.Hour
	
	MinPasswordLength      = 8
	MaxPasswordLength      = 128
	
	TokenLength            = 32
	NonceLength            = 16
)

// Performance Constants
const (
	StatsUpdateInterval    = 1 * time.Second
	MetricsRetention       = 24 * time.Hour
	
	MaxConcurrentWorkers   = 10000
	WorkerTimeout          = 5 * time.Minute
	
	CacheSize              = 1000
	CacheTTL               = 5 * time.Minute
)

// Database Constants
const (
	DBMaxConnections       = 100
	DBMaxIdleConnections   = 10
	DBConnectionLifetime   = 1 * time.Hour
	
	BatchInsertSize        = 1000
	QueryTimeout           = 30 * time.Second
)

// Monitoring Constants
const (
	HealthCheckInterval    = 30 * time.Second
	AlertThresholdCPU      = 90.0  // 90%
	AlertThresholdMemory   = 90.0  // 90%
	AlertThresholdDisk     = 90.0  // 90%
	
	MetricsSampleRate      = 1.0
	MetricsFlushInterval   = 10 * time.Second
)

// Error Messages
const (
	ErrInvalidConfiguration = "invalid configuration"
	ErrDeviceNotFound       = "device not found"
	ErrConnectionFailed     = "connection failed"
	ErrAuthenticationFailed = "authentication failed"
	ErrInsufficientBalance  = "insufficient balance"
	ErrInvalidShare         = "invalid share"
	ErrStaleShare           = "stale share"
	ErrDuplicateShare       = "duplicate share"
)

// Log Messages
const (
	LogStarting             = "starting"
	LogStarted              = "started"
	LogStopping             = "stopping"
	LogStopped              = "stopped"
	LogConnected            = "connected"
	LogDisconnected         = "disconnected"
	LogError                = "error"
	LogWarning              = "warning"
	LogInfo                 = "info"
	LogDebug                = "debug"
)

// Configuration Keys
const (
	ConfigKeyAlgorithm      = "algorithm"
	ConfigKeyPoolURL        = "pool_url"
	ConfigKeyUsername       = "username"
	ConfigKeyPassword       = "password"
	ConfigKeyWorkerName     = "worker_name"
	
	ConfigKeyCPUEnabled     = "cpu.enabled"
	ConfigKeyCPUThreads     = "cpu.threads"
	ConfigKeyCPUAffinity    = "cpu.affinity"
	
	ConfigKeyGPUEnabled     = "gpu.enabled"
	ConfigKeyGPUDevices     = "gpu.devices"
	ConfigKeyGPUIntensity   = "gpu.intensity"
	
	ConfigKeyASICEnabled    = "asic.enabled"
	ConfigKeyASICDevices    = "asic.devices"
)

// Environment Variables
const (
	EnvLogLevel             = "OTEDAMA_LOG_LEVEL"
	EnvConfigFile           = "OTEDAMA_CONFIG_FILE"
	EnvDataDir              = "OTEDAMA_DATA_DIR"
	EnvDebugMode            = "OTEDAMA_DEBUG"
)

// File Paths
const (
	DefaultConfigFile       = "config.yaml"
	DefaultLogFile          = "otedama.log"
	DefaultDataDir          = "./data"
	DefaultTempDir          = "./tmp"
)

// Regular Expressions
const (
	RegexIPAddress          = `^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$`
	RegexEmail              = `^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$`
	RegexWalletAddress      = `^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$` // Bitcoin address
)