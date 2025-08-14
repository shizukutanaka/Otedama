package database

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/shizukutanaka/Otedama/internal/common"
)

// workerRepository implements the WorkerRepository interface
type workerRepository struct {
	manager *Manager
}

// NewWorkerRepository creates a new worker repository
func NewWorkerRepository(manager *Manager) WorkerRepository {
	return &workerRepository{
		manager: manager,
	}
}

// CreateWorker creates a new worker in the database
func (r *workerRepository) CreateWorker(ctx context.Context, worker *Worker) error {
	query := `INSERT INTO workers (name, wallet_address, hashrate, last_seen, created_at) 
			  VALUES (?, ?, ?, ?, ?)`
	
	_, err := r.manager.conn.ExecContext(ctx, query, 
		worker.Name, 
		worker.WalletAddress, 
		worker.Hashrate, 
		worker.LastSeen, 
		worker.CreatedAt)
	
	if err != nil {
		return fmt.Errorf("failed to create worker: %w", err)
	}
	
	return nil
}

// GetWorkerByName retrieves a worker by their name
func (r *workerRepository) GetWorkerByName(ctx context.Context, name string) (*Worker, error) {
	query := `SELECT id, name, wallet_address, hashrate, last_seen, created_at 
			  FROM workers WHERE name = ?`
	
	worker := &Worker{}
	err := r.manager.conn.QueryRowContext(ctx, query, name).Scan(
		&worker.ID,
		&worker.Name,
		&worker.WalletAddress,
		&worker.Hashrate,
		&worker.LastSeen,
		&worker.CreatedAt,
	)
	
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, common.ErrWorkerNotFound
		}
		return nil, fmt.Errorf("failed to get worker by name: %w", err)
	}
	
	return worker, nil
}

// GetWorkerByID retrieves a worker by their ID
func (r *workerRepository) GetWorkerByID(ctx context.Context, id int64) (*Worker, error) {
	query := `SELECT id, name, wallet_address, hashrate, last_seen, created_at 
			  FROM workers WHERE id = ?`
	
	worker := &Worker{}
	err := r.manager.conn.QueryRowContext(ctx, query, id).Scan(
		&worker.ID,
		&worker.Name,
		&worker.WalletAddress,
		&worker.Hashrate,
		&worker.LastSeen,
		&worker.CreatedAt,
	)
	
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, common.ErrWorkerNotFound
		}
		return nil, fmt.Errorf("failed to get worker by ID: %w", err)
	}
	
	return worker, nil
}

// UpdateWorkerHashrate updates a worker's hashrate
func (r *workerRepository) UpdateWorkerHashrate(ctx context.Context, id int64, hashrate float64) error {
	query := `UPDATE workers SET hashrate = ?, last_seen = ? WHERE id = ?`
	
	_, err := r.manager.conn.ExecContext(ctx, query, hashrate, time.Now().UTC(), id)
	if err != nil {
		return fmt.Errorf("failed to update worker hashrate: %w", err)
	}
	
	return nil
}

// UpdateWorkerLastSeen updates a worker's last seen timestamp
func (r *workerRepository) UpdateWorkerLastSeen(ctx context.Context, id int64, lastSeen time.Time) error {
	query := `UPDATE workers SET last_seen = ? WHERE id = ?`
	
	_, err := r.manager.conn.ExecContext(ctx, query, lastSeen, id)
	if err != nil {
		return fmt.Errorf("failed to update worker last seen: %w", err)
	}
	
	return nil
}

// UpdateWorkerWallet updates a worker's wallet address
func (r *workerRepository) UpdateWorkerWallet(ctx context.Context, id int64, walletAddress string) error {
	query := `UPDATE workers SET wallet_address = ? WHERE id = ?`
	
	_, err := r.manager.conn.ExecContext(ctx, query, walletAddress, id)
	if err != nil {
		return fmt.Errorf("failed to update worker wallet: %w", err)
	}
	
	return nil
}

// GetAllWorkers retrieves all workers
func (r *workerRepository) GetAllWorkers(ctx context.Context) ([]*Worker, error) {
	query := `SELECT id, name, wallet_address, hashrate, last_seen, created_at FROM workers`
	
	rows, err := r.manager.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to get all workers: %w", err)
	}
	defer rows.Close()
	
	var workers []*Worker
	for rows.Next() {
		worker := &Worker{}
		err := rows.Scan(
			&worker.ID,
			&worker.Name,
			&worker.WalletAddress,
			&worker.Hashrate,
			&worker.LastSeen,
			&worker.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan worker: %w", err)
		}
		workers = append(workers, worker)
	}
	
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating workers: %w", err)
	}
	
	return workers, nil
}

// DeleteWorker removes a worker from the database
func (r *workerRepository) DeleteWorker(ctx context.Context, id int64) error {
	query := `DELETE FROM workers WHERE id = ?`
	
	_, err := r.manager.conn.ExecContext(ctx, query, id)
	if err != nil {
		return fmt.Errorf("failed to delete worker: %w", err)
	}
	
	return nil
}
