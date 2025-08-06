package common

import (
	"context"
	"net/http"
	"time"
)

// Component represents a lifecycle-managed component
type Component interface {
	// Name returns the component name
	Name() string
	
	// Start starts the component
	Start(ctx context.Context) error
	
	// Stop stops the component
	Stop(ctx context.Context) error
	
	// Health returns the component health status
	Health() ComponentHealth
}

// ComponentHealth represents the health status of a component
type ComponentHealth struct {
	Healthy bool
	Message string
	Details map[string]interface{}
}

// Miner defines the common interface for all miner types
type Miner interface {
	// Lifecycle management
	Start() error
	Stop() error
	IsRunning() bool
	
	// Work management
	SetWork(work interface{}) error
	GetWork() interface{}
	
	// Performance metrics
	GetHashRate() uint64
	GetStats() interface{}
	
	// Configuration
	Configure(config interface{}) error
	GetConfig() interface{}
}

// Device represents a mining device interface
type Device interface {
	// Device information
	GetID() string
	GetName() string
	GetType() string
	
	// Status
	GetStatus() string
	IsAvailable() bool
	
	// Performance
	GetHashRate() uint64
	GetTemperature() float32
	GetPowerDraw() float32
	
	// Control
	Enable() error
	Disable() error
	Reset() error
}

// Pool defines the interface for mining pool connections
type Pool interface {
	// Connection management
	Connect() error
	Disconnect() error
	IsConnected() bool
	
	// Authentication
	Authorize(username, password string) error
	
	// Work management
	GetWork() (interface{}, error)
	SubmitShare(share interface{}) error
	
	// Statistics
	GetStats() interface{}
}

// ShareValidator validates mining shares
type ShareValidator interface {
	ValidateShare(share interface{}, target []byte) error
	CheckDifficulty(hash []byte, difficulty float64) bool
	IsStale(share interface{}) bool
	IsDuplicate(share interface{}) bool
}

// DifficultyAdjuster adjusts mining difficulty
type DifficultyAdjuster interface {
	AdjustDifficulty(currentDiff float64, shareTime time.Duration) float64
	GetTargetShareTime() time.Duration
	GetMinDifficulty() float64
	GetMaxDifficulty() float64
}

// Worker represents a mining worker interface
type Worker interface {
	// Identification
	GetID() string
	GetName() string
	
	// Lifecycle
	Start(ctx context.Context) error
	Stop() error
	
	// Work processing
	ProcessWork(work interface{}) error
	
	// Statistics
	GetHashRate() uint64
	GetSharesFound() uint64
}

// Cache defines the caching interface
type Cache interface {
	Get(key string) (interface{}, bool)
	Set(key string, value interface{}, ttl time.Duration)
	Delete(key string)
	Clear()
	Size() int
}

// RateLimiter defines the rate limiting interface
type RateLimiter interface {
	Allow(key string) bool
	AllowN(key string, n int) bool
	Wait(ctx context.Context, key string) error
}

// Logger defines a simplified logging interface
type Logger interface {
	Debug(msg string, fields ...interface{})
	Info(msg string, fields ...interface{})
	Warn(msg string, fields ...interface{})
	Error(msg string, fields ...interface{})
	Fatal(msg string, fields ...interface{})
}

// EventEmitter defines event emission interface
type EventEmitter interface {
	Emit(event string, data interface{})
	On(event string, handler func(interface{}))
	Off(event string)
	Once(event string, handler func(interface{}))
}

// Storage defines the storage interface
type Storage interface {
	Get(key string) ([]byte, error)
	Set(key string, value []byte) error
	Delete(key string) error
	Exists(key string) (bool, error)
}

// Metrics defines the metrics collection interface
type Metrics interface {
	IncrementCounter(name string, tags ...string)
	SetGauge(name string, value float64, tags ...string)
	RecordHistogram(name string, value float64, tags ...string)
	RecordTimer(name string, duration time.Duration, tags ...string)
}

// RecoveryFunc is a function that recovers from panics
type RecoveryFunc func() error

// HTTPServer represents a generic HTTP server interface
type HTTPServer interface {
	Start(ctx context.Context) error
	Shutdown(ctx context.Context) error
	ListenAndServe() error
}

// MiningEngine represents a mining engine interface
type MiningEngine interface {
	Start(ctx context.Context) error
	Stop()
	GetStats() map[string]interface{}
}

// P2PPool represents a P2P pool interface
type P2PPool interface {
	Start() error
	Stop() error
	GetStats() map[string]interface{}
}

// StratumServer represents a Stratum server interface
type StratumServer interface {
	Start(ctx context.Context) error
	Shutdown(ctx context.Context) error
}

// MetricsCollector represents a metrics collector interface
type MetricsCollector interface {
	Start()
	Stop()
	GetMetrics() map[string]interface{}
}

// Dashboard represents a monitoring dashboard interface
type Dashboard interface {
	Start() error
	Stop()
}

// Middleware represents HTTP middleware
type Middleware func(http.Handler) http.Handler

// TokenClaims represents JWT token claims
type TokenClaims struct {
	UserID      string   `json:"user_id"`
	Username    string   `json:"username"`
	Permissions []string `json:"permissions"`
	ExpiresAt   int64    `json:"exp"`
}

// AuthValidator validates authentication tokens
type AuthValidator interface {
	ValidateToken(token string) (*TokenClaims, error)
}

// RecoveryManager handles system recovery operations
type RecoveryManager interface {
	RecoverComponent(componentName string) error
	RegisterRecoveryHandler(componentName string, handler func() error)
	GetRecoveryStatus() map[string]interface{}
	TriggerRecovery(ctx context.Context, err error) error
	RegisterHealthCheck(check HealthCheck)
}

// HealthCheck interface for recovery manager
type HealthCheck interface {
	Name() string
	Check(ctx context.Context) error
	Critical() bool
}