package database

import (
	"time"
)

// Config holds the database configuration settings
type Config struct {
	Type           string        `yaml:"type"`
	DSN            string        `yaml:"dsn"`
	MaxConnections int           `yaml:"max_connections"`
	MaxIdleConns   int           `yaml:"max_idle_conns"`
	ConnMaxLifetime time.Duration `yaml:"conn_max_lifetime"`
}

// DefaultConfig returns a configuration with sensible default values
func DefaultConfig() *Config {
	return &Config{
		Type:            "sqlite",
		DSN:             "./data/otedama.db",
		MaxConnections:  20,
		MaxIdleConns:    5,
		ConnMaxLifetime: 1 * time.Hour,
	}
}
