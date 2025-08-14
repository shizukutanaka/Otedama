package app

import (
	"fmt"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/database"
	"go.uber.org/zap"
)

// InitializeDatabase creates and initializes the database connection
func InitializeDatabase(cfg *config.Config, logger *zap.Logger) (*database.DB, error) {
	// Create database connection
	db, err := database.New(cfg.Database)
	if err != nil {
		return nil, fmt.Errorf("failed to create database connection: %w", err)
	}

	// Run migrations
	if err := db.Migrate(); err != nil {
		return nil, fmt.Errorf("failed to run database migrations: %w", err)
	}

	logger.Info("Database initialized successfully",
		zap.String("type", cfg.Database.Type),
		zap.String("dsn", cfg.Database.DSN),
	)

	return db, nil
}
