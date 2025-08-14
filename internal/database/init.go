package database

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
)

// InitDatabase initializes the database and ensures all required tables exist
func InitDatabase(config *Config) (*RepositoryFactory, error) {
	// Ensure data directory exists
	dataDir := filepath.Dir(config.DSN)
	if dataDir != "" {
		if err := os.MkdirAll(dataDir, 0755); err != nil {
			return nil, fmt.Errorf("failed to create data directory: %w", err)
		}
	}

	// Create repository factory which will initialize the database
	factory, err := NewRepositoryFactory(config)
	if err != nil {
		return nil, fmt.Errorf("failed to create repository factory: %w", err)
	}

	// Perform health check
	if err := factory.HealthCheck(); err != nil {
		return nil, fmt.Errorf("database health check failed: %w", err)
	}

	log.Println("Database initialized successfully")
	return factory, nil
}

// MustInitDatabase initializes the database and panics if it fails
func MustInitDatabase(config *Config) *RepositoryFactory {
	factory, err := InitDatabase(config)
	if err != nil {
		panic(fmt.Sprintf("failed to initialize database: %v", err))
	}
	return factory
}

// InitDatabaseWithContext initializes the database with context support
func InitDatabaseWithContext(ctx context.Context, config *Config) (*RepositoryFactory, error) {
	// Ensure data directory exists
	dataDir := filepath.Dir(config.DSN)
	if dataDir != "" {
		if err := os.MkdirAll(dataDir, 0755); err != nil {
			return nil, fmt.Errorf("failed to create data directory: %w", err)
		}
	}

	// Create repository factory which will initialize the database
	factory, err := NewRepositoryFactory(config)
	if err != nil {
		return nil, fmt.Errorf("failed to create repository factory: %w", err)
	}

	// Perform health check
	if err := factory.HealthCheck(); err != nil {
		return nil, fmt.Errorf("database health check failed: %w", err)
	}

	return factory, nil
}
