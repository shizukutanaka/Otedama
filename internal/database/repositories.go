package database

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/shizukutanaka/Otedama/internal/common"
	"go.uber.org/zap"
)

// WorkerRepository handles worker-related database operations
type WorkerRepository struct {
	db     *DB
	logger *zap.Logger
}

// Worker represents a mining worker
type Worker struct {
	ID            int64                  `db:"id"`
	WorkerID      string                 `db:"worker_id"`
	Username      string                 `db:"username"`
	PasswordHash  string                 `db:"password_hash"`
	CreatedAt     time.Time              `db:"created_at"`
	UpdatedAt     time.Time              `db:"updated_at"`
	LastSeenAt    *time.Time             `db:"last_seen_at"`
	TotalShares   int64                  `db:"total_shares"`
	ValidShares   int64                  `db:"valid_shares"`
	InvalidShares int64                  `db:"invalid_shares"`
	TotalHashrate float64                `db:"total_hashrate"`
	Status        string                 `db:"status"`
	Metadata      map[string]interface{} `db:"metadata"`
}

// NewWorkerRepository creates a new worker repository
func NewWorkerRepository(db *DB, logger *zap.Logger) *WorkerRepository {
	return &WorkerRepository{
		db:     db,
		logger: logger,
	}
}

// Create creates a new worker
func (r *WorkerRepository) Create(ctx context.Context, worker *Worker) error {
	metadata, _ := json.Marshal(worker.Metadata)
	
	query := `
		INSERT INTO workers (worker_id, username, password_hash, status, metadata)
		VALUES (?, ?, ?, ?, ?)
	`
	
	if r.db.driver == "postgres" {
		query = `
			INSERT INTO workers (worker_id, username, password_hash, status, metadata)
			VALUES ($1, $2, $3, $4, $5)
		`
	}
	
	_, err := r.db.Execute(ctx, query,
		worker.WorkerID,
		worker.Username,
		worker.PasswordHash,
		worker.Status,
		metadata,
	)
	
	return err
}

// Get retrieves a worker by ID
func (r *WorkerRepository) Get(ctx context.Context, workerID string) (*Worker, error) {
	worker := &Worker{}
	var metadataJSON []byte
	
	query := `
		SELECT id, worker_id, username, password_hash, created_at, updated_at,
		       last_seen_at, total_shares, valid_shares, invalid_shares,
		       total_hashrate, status, metadata
		FROM workers
		WHERE worker_id = ?
	`
	
	if r.db.driver == "postgres" {
		query = `
			SELECT id, worker_id, username, password_hash, created_at, updated_at,
			       last_seen_at, total_shares, valid_shares, invalid_shares,
			       total_hashrate, status, metadata
			FROM workers
			WHERE worker_id = $1
		`
	}
	
	row := r.db.QueryRow(ctx, query, workerID)
	if err := row.Scan(
		&worker.ID,
		&worker.WorkerID,
		&worker.Username,
		&worker.PasswordHash,
		&worker.CreatedAt,
		&worker.UpdatedAt,
		&worker.LastSeenAt,
		&worker.TotalShares,
		&worker.ValidShares,
		&worker.InvalidShares,
		&worker.TotalHashrate,
		&worker.Status,
		&metadataJSON,
	); err != nil {
		if err == sql.ErrNoRows {
			return nil, common.ErrNotFound
		}
		return nil, err
	}
	
	if len(metadataJSON) > 0 {
		if err := json.Unmarshal(metadataJSON, &worker.Metadata); err != nil {
			return nil, fmt.Errorf("failed to unmarshal metadata: %v", err)
		}
	} else {
		worker.Metadata = make(map[string]interface{})
	}
	
	return worker, nil
}

// GetByDBID retrieves a worker by its database ID
func (r *WorkerRepository) GetByDBID(ctx context.Context, id int64) (*Worker, error) {
	worker := &Worker{}
	var metadataJSON []byte
	
	query := `
		SELECT id, worker_id, username, password_hash, created_at, updated_at,
		       last_seen_at, total_shares, valid_shares, invalid_shares,
		       total_hashrate, status, metadata
		FROM workers
		WHERE id = ?
	`
	
	if r.db.driver == "postgres" {
		query = `
			SELECT id, worker_id, username, password_hash, created_at, updated_at,
			       last_seen_at, total_shares, valid_shares, invalid_shares,
			       total_hashrate, status, metadata
			FROM workers
			WHERE id = $1
		`
	}
	
	row := r.db.QueryRow(ctx, query, id)
	if err := row.Scan(
		&worker.ID,
		&worker.WorkerID,
		&worker.Username,
		&worker.PasswordHash,
		&worker.CreatedAt,
		&worker.UpdatedAt,
		&worker.LastSeenAt,
		&worker.TotalShares,
		&worker.ValidShares,
		&worker.InvalidShares,
		&worker.TotalHashrate,
		&worker.Status,
		&metadataJSON,
	); err != nil {
		if err == sql.ErrNoRows {
			return nil, common.ErrNotFound
		}
		return nil, err
	}
	
	if len(metadataJSON) > 0 {
		if err := json.Unmarshal(metadataJSON, &worker.Metadata); err != nil {
			return nil, fmt.Errorf("failed to unmarshal metadata: %v", err)
		}
	} else {
		worker.Metadata = make(map[string]interface{})
	}
	
	return worker, nil
}

// Update updates a worker
func (r *WorkerRepository) Update(ctx context.Context, worker *Worker) error {
	metadata, _ := json.Marshal(worker.Metadata)
	
	query := `
		UPDATE workers
		SET username = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP,
		    last_seen_at = ?, total_shares = ?, valid_shares = ?,
		    invalid_shares = ?, total_hashrate = ?, status = ?, metadata = ?
		WHERE worker_id = ?
	`
	
	if r.db.driver == "postgres" {
		query = `
			UPDATE workers
			SET username = $1, password_hash = $2, updated_at = CURRENT_TIMESTAMP,
			    last_seen_at = $3, total_shares = $4, valid_shares = $5,
			    invalid_shares = $6, total_hashrate = $7, status = $8, metadata = $9
			WHERE worker_id = $10
		`
	}
	
	_, err := r.db.Execute(ctx, query,
		worker.Username,
		worker.PasswordHash,
		worker.LastSeenAt,
		worker.TotalShares,
		worker.ValidShares,
		worker.InvalidShares,
		worker.TotalHashrate,
		worker.Status,
		metadata,
		worker.WorkerID,
	)
	
	return err
}

// UpdateLastSeen updates worker's last seen timestamp
func (r *WorkerRepository) UpdateLastSeen(ctx context.Context, workerID string) error {
	query := `UPDATE workers SET last_seen_at = CURRENT_TIMESTAMP WHERE worker_id = ?`
	
	if r.db.driver == "postgres" {
		query = `UPDATE workers SET last_seen_at = CURRENT_TIMESTAMP WHERE worker_id = $1`
	}
	
	_, err := r.db.Execute(ctx, query, workerID)
	return err
}

// ListActive lists all active workers
func (r *WorkerRepository) ListActive(ctx context.Context, limit int) ([]*Worker, error) {
	workers := make([]*Worker, 0)
	
	query := `
		SELECT id, worker_id, username, password_hash, created_at, updated_at,
		       last_seen_at, total_shares, valid_shares, invalid_shares,
		       total_hashrate, status, metadata
		FROM workers
		WHERE status = 'active'
		ORDER BY last_seen_at DESC
		LIMIT ?
	`
	
	if r.db.driver == "postgres" {
		query = `
			SELECT id, worker_id, username, password_hash, created_at, updated_at,
			       last_seen_at, total_shares, valid_shares, invalid_shares,
			       total_hashrate, status, metadata
			FROM workers
			WHERE status = 'active'
			ORDER BY last_seen_at DESC
			LIMIT $1
		`
	}
	
	rows, err := r.db.Query(ctx, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	for rows.Next() {
		worker := &Worker{}
		var metadataJSON []byte
		
		if err := rows.Scan(
			&worker.ID,
			&worker.WorkerID,
			&worker.Username,
			&worker.PasswordHash,
			&worker.CreatedAt,
			&worker.UpdatedAt,
			&worker.LastSeenAt,
			&worker.TotalShares,
			&worker.ValidShares,
			&worker.InvalidShares,
			&worker.TotalHashrate,
			&worker.Status,
			&metadataJSON,
		); err != nil {
			return nil, err
		}
		
		if len(metadataJSON) > 0 {
			if err := json.Unmarshal(metadataJSON, &worker.Metadata); err != nil {
				return nil, fmt.Errorf("failed to unmarshal metadata: %v", err)
			}
		} else {
			worker.Metadata = make(map[string]interface{})
		}
		
		workers = append(workers, worker)
	}
	
	return workers, rows.Err()
}