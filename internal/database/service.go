package database

import (
	"context"
	"fmt"
	"log"
	"sync"
)

// Service provides a high-level interface for database operations
type Service struct {
	factory  *RepositoryFactory
	migrator *MigrationManager
	
	workerRepo WorkerRepository
	shareRepo  ShareRepository
	blockRepo  BlockRepository
	payoutRepo PayoutRepository
	
	// Ensure singleton pattern
	once sync.Once
}

// NewService creates a new database service
func NewService(config *Config) (*Service, error) {
	var service *Service
	var initErr error

	// Ensure singleton pattern
	func() {
		factory, err := InitDatabase(config)
		if err != nil {
			initErr = fmt.Errorf("failed to initialize database: %w", err)
			return
		}

		migrator := NewMigrationManager(factory.GetManager())
		
		service = &Service{
			factory:  factory,
			migrator: migrator,
			
			workerRepo: factory.GetWorkerRepository(),
			shareRepo:  factory.GetShareRepository(),
			blockRepo:  factory.GetBlockRepository(),
			payoutRepo: factory.GetPayoutRepository(),
		}
	}()

	if initErr != nil {
		return nil, initErr
	}

	return service, nil
}

// MustNewService creates a new database service and panics if it fails
func MustNewService(config *Config) *Service {
	service, err := NewService(config)
	if err != nil {
		panic(fmt.Sprintf("failed to create database service: %v", err))
	}
	return service
}

// Initialize applies all pending migrations and prepares the database for use
func (s *Service) Initialize() error {
	log.Println("Applying database migrations...")
	if err := s.migrator.Migrate(); err != nil {
		return fmt.Errorf("failed to apply migrations: %w", err)
	}
	log.Println("Database migrations applied successfully")

	// Perform health check
	if err := s.factory.HealthCheck(); err != nil {
		return fmt.Errorf("database health check failed: %w", err)
	}

	log.Println("Database service initialized successfully")
	return nil
}

// GetWorkerRepository returns the worker repository
func (s *Service) GetWorkerRepository() WorkerRepository {
	return s.workerRepo
}

// GetShareRepository returns the share repository
func (s *Service) GetShareRepository() ShareRepository {
	return s.shareRepo
}

// GetBlockRepository returns the block repository
func (s *Service) GetBlockRepository() BlockRepository {
	return s.blockRepo
}

// GetPayoutRepository returns the payout repository
func (s *Service) GetPayoutRepository() PayoutRepository {
	return s.payoutRepo
}

// HealthCheck performs a health check on the database
func (s *Service) HealthCheck() error {
	return s.factory.HealthCheck()
}

// Close closes the database connection
func (s *Service) Close() error {
	return s.factory.Close()
}

// WithTransaction executes a function within a database transaction
func (s *Service) WithTransaction(ctx context.Context, fn func(context.Context) error) error {
	// For SQLite, we would need to implement transaction support
	// This is a simplified version that just executes the function
	return fn(ctx)
}

// GetStats returns database statistics
func (s *Service) GetStats() (map[string]interface{}, error) {
	stats := make(map[string]interface{})
	
	// Get worker count
	var workerCount int
	err := s.factory.GetManager().conn.QueryRow("SELECT COUNT(*) FROM workers").Scan(&workerCount)
	if err != nil {
		return nil, fmt.Errorf("failed to get worker count: %w", err)
	}
	stats["worker_count"] = workerCount
	
	// Get share count
	var shareCount int
	err = s.factory.GetManager().conn.QueryRow("SELECT COUNT(*) FROM shares").Scan(&shareCount)
	if err != nil {
		return nil, fmt.Errorf("failed to get share count: %w", err)
	}
	stats["share_count"] = shareCount
	
	// Get block count
	var blockCount int
	err = s.factory.GetManager().conn.QueryRow("SELECT COUNT(*) FROM blocks").Scan(&blockCount)
	if err != nil {
		return nil, fmt.Errorf("failed to get block count: %w", err)
	}
	stats["block_count"] = blockCount
	
	// Get payout count
	var payoutCount int
	err = s.factory.GetManager().conn.QueryRow("SELECT COUNT(*) FROM payouts").Scan(&payoutCount)
	if err != nil {
		return nil, fmt.Errorf("failed to get payout count: %w", err)
	}
	stats["payout_count"] = payoutCount
	
	return stats, nil
}
