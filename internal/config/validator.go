package config

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
)

// Validator is responsible for validating the application's configuration.
// It enforces rules to ensure the configuration is logical and consistent.
type Validator struct{}

// NewValidator creates a new configuration validator.
func NewValidator() *Validator {
	return &Validator{}
}

// Validate performs a full validation of the provided Config struct.
// It breaks down validation into smaller, manageable, private methods.
func (v *Validator) Validate(cfg *Config) error {
	if err := v.validateSystem(&cfg.System); err != nil {
		return fmt.Errorf("system config: %w", err)
	}
	if err := v.validateLogging(&cfg.Logging); err != nil {
		return fmt.Errorf("logging config: %w", err)
	}
	if err := v.validateNetwork(&cfg.Network); err != nil {
		return fmt.Errorf("network config: %w", err)
	}
	if err := v.validateAPI(&cfg.API); err != nil {
		return fmt.Errorf("api config: %w", err)
	}
	if err := v.validateSecurity(&cfg.Security); err != nil {
		return fmt.Errorf("security config: %w", err)
	}
	if err := v.validateMining(&cfg.Mining); err != nil {
		return fmt.Errorf("mining config: %w", err)
	}
	if err := v.validatePool(&cfg.Pool); err != nil {
		return fmt.Errorf("pool config: %w", err)
	}
	if err := v.validateMonitoring(&cfg.Monitoring); err != nil {
		return fmt.Errorf("monitoring config: %w", err)
	}
	if err := v.validateDatabase(&cfg.Database); err != nil {
		return fmt.Errorf("database config: %w", err)
	}
	return nil
}

func (v *Validator) validateSystem(cfg *SystemConfig) error {
	if cfg.NodeID == "" {
		return errors.New("node_id is required")
	}
	if cfg.DataDir == "" {
		return errors.New("data_dir is required")
	}
	if !filepath.IsAbs(cfg.DataDir) {
		return errors.New("data_dir must be an absolute path")
	}
	if cfg.GracefulTimeout <= 0 {
		return errors.New("graceful_timeout must be positive")
	}
	return nil
}

func (v *Validator) validateLogging(cfg *LoggingConfig) error {
	validLevels := []string{"debug", "info", "warn", "error"}
	if !contains(validLevels, cfg.Level) {
		return fmt.Errorf("invalid log level: %s", cfg.Level)
	}
	return nil
}

func (v *Validator) validateNetwork(cfg *NetworkConfig) error {
	if err := v.validateP2P(&cfg.P2P); err != nil {
		return fmt.Errorf("p2p: %w", err)
	}
	if err := v.validateStratum(&cfg.Stratum); err != nil {
		return fmt.Errorf("stratum: %w", err)
	}
	return nil
}

func (v *Validator) validateP2P(cfg *P2PConfig) error {
	if !cfg.Enabled {
		return nil
	}
	if err := v.validateListenAddress(cfg.ListenAddr); err != nil {
		return fmt.Errorf("p2p listen_addr: %w", err)
	}
	if cfg.MaxPeers <= 0 {
		return errors.New("p2p max_peers must be positive")
	}
	return nil
}

func (v *Validator) validateStratum(cfg *StratumConfig) error {
	if !cfg.Enabled {
		return nil
	}
	if err := v.validateListenAddress(cfg.ListenAddr); err != nil {
		return fmt.Errorf("stratum listen_addr: %w", err)
	}
	if cfg.MaxClients <= 0 {
		return errors.New("stratum max_clients must be positive")
	}
	if cfg.Difficulty <= 0 {
		return errors.New("stratum difficulty must be positive")
	}
	return nil
}

func (v *Validator) validateAPI(cfg *APIConfig) error {
	if !cfg.Enabled {
		return nil
	}
	if err := v.validateListenAddress(cfg.ListenAddr); err != nil {
		return fmt.Errorf("api listen_addr: %w", err)
	}
	if cfg.TLSEnabled {
		if _, err := os.Stat(cfg.TLSCert); os.IsNotExist(err) {
			return fmt.Errorf("tls_cert file not found: %s", cfg.TLSCert)
		}
		if _, err := os.Stat(cfg.TLSKey); os.IsNotExist(err) {
			return fmt.Errorf("tls_key file not found: %s", cfg.TLSKey)
		}
	}
	return nil
}

func (v *Validator) validateSecurity(cfg *SecurityConfig) error {
	if cfg.AuthEnabled && len(cfg.JWTSecret) < 32 {
		return errors.New("jwt_secret must be at least 32 characters long when auth is enabled")
	}
	if cfg.RateLimit <= 0 {
		return errors.New("rate_limit must be positive")
	}
	return nil
}

func (v *Validator) validateMining(cfg *MiningConfig) error {
	if cfg.Algorithm == "" {
		return errors.New("mining algorithm is required")
	}
	if cfg.CPUThreads < 0 {
		return errors.New("cpu_threads cannot be negative")
	}
	if cfg.Intensity <= 0 {
		return errors.New("intensity must be positive")
	}
	return nil
}

func (v *Validator) validatePool(cfg *PoolConfig) error {
	if !cfg.Enabled {
		return nil
	}
	validSchemes := []string{"PPLNS", "PPS", "PROP"}
	if !contains(validSchemes, cfg.PayoutScheme) {
		return fmt.Errorf("invalid payout_scheme: %s", cfg.PayoutScheme)
	}
	if cfg.MinimumPayout <= 0 {
		return errors.New("minimum_payout must be positive")
	}
	if cfg.PoolFeePercent < 0 || cfg.PoolFeePercent > 100 {
		return errors.New("pool_fee_percent must be between 0 and 100")
	}
	return nil
}

func (v *Validator) validateMonitoring(cfg *MonitoringConfig) error {
	if !cfg.PrometheusEnabled {
		return nil
	}
	if err := v.validateListenAddress(cfg.PrometheusAddr); err != nil {
		return fmt.Errorf("prometheus_addr: %w", err)
	}
	return nil
}

func (v *Validator) validateDatabase(cfg *DatabaseConfig) error {
	validTypes := []string{"sqlite", "postgres", "mysql"}
	if !contains(validTypes, cfg.Type) {
		return fmt.Errorf("unsupported database type: %s", cfg.Type)
	}
	if cfg.DSN == "" {
		return errors.New("database dsn is required")
	}
	if cfg.MaxConnections <= 0 {
		return errors.New("database max_connections must be positive")
	}
	return nil
}

// validateListenAddress checks if a string is a valid network listen address.
func (v *Validator) validateListenAddress(addr string) error {
	if addr == "" {
		return errors.New("address cannot be empty")
	}
	_, _, err := net.SplitHostPort(addr)
	if err != nil {
		// If SplitHostPort fails, it might be a port-only address like ":8080"
		if strings.HasPrefix(addr, ":") {
			_, err := net.LookupPort("tcp", strings.TrimPrefix(addr, ":"))
			if err != nil {
				return fmt.Errorf("invalid port: %s", addr)
			}
			return nil
		}
		return fmt.Errorf("invalid listen address format: %s", addr)
	}
	return nil
}

// contains is a helper function to check for string presence in a slice.
func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}
