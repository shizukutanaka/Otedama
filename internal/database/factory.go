package database

import (
	"fmt"
)

// RepositoryFactory manages the creation of repository instances
type RepositoryFactory struct {
	manager *Manager
}

// NewRepositoryFactory creates a new repository factory
func NewRepositoryFactory(config *Config) (*RepositoryFactory, error) {
	manager, err := NewManager(config)
	if err != nil {
		return nil, fmt.Errorf("failed to create database manager: %w", err)
	}

	// Initialize database schema
	if err := manager.InitializeSchema(); err != nil {
		return nil, fmt.Errorf("failed to initialize database schema: %w", err)
	}

	return &RepositoryFactory{
		manager: manager,
	}, nil
}

// GetWorkerRepository returns a worker repository instance
func (f *RepositoryFactory) GetWorkerRepository() WorkerRepository {
	return NewWorkerRepository(f.manager)
}

// GetShareRepository returns a share repository instance
func (f *RepositoryFactory) GetShareRepository() ShareRepository {
	return NewShareRepository(f.manager)
}

// GetBlockRepository returns a block repository instance
func (f *RepositoryFactory) GetBlockRepository() BlockRepository {
	return NewBlockRepository(f.manager)
}

// GetPayoutRepository returns a payout repository instance
func (f *RepositoryFactory) GetPayoutRepository() PayoutRepository {
	return NewPayoutRepository(f.manager)
}

// GetManager returns the database manager
func (f *RepositoryFactory) GetManager() *Manager {
	return f.manager
}

// Close closes the database connection
func (f *RepositoryFactory) Close() error {
	return f.manager.Close()
}

// HealthCheck verifies the database connection is working properly
func (f *RepositoryFactory) HealthCheck() error {
	return f.manager.HealthCheck()
}
