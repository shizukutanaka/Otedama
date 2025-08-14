package database

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// shareRepository implements the ShareRepository interface
type shareRepository struct {
	manager *Manager
}

// NewShareRepository creates a new share repository
func NewShareRepository(manager *Manager) ShareRepository {
	return &shareRepository{
		manager: manager,
	}
}

// CreateShare creates a new share in the database
func (r *shareRepository) CreateShare(ctx context.Context, share *Share) error {
	query := `INSERT INTO shares (worker_id, job_id, nonce, difficulty, created_at) 
			  VALUES (?, ?, ?, ?, ?)`
	
	_, err := r.manager.conn.ExecContext(ctx, query, 
		share.WorkerID, 
		share.JobID, 
		share.Nonce, 
		share.Difficulty, 
		share.CreatedAt)
	
	if err != nil {
		return fmt.Errorf("failed to create share: %w", err)
	}
	
	return nil
}

// GetSharesByWorker retrieves shares for a specific worker
func (r *shareRepository) GetSharesByWorker(ctx context.Context, workerID int64) ([]*Share, error) {
	query := `SELECT id, worker_id, job_id, nonce, difficulty, created_at 
			  FROM shares WHERE worker_id = ?`
	
	rows, err := r.manager.conn.QueryContext(ctx, query, workerID)
	if err != nil {
		return nil, fmt.Errorf("failed to get shares by worker: %w", err)
	}
	defer rows.Close()
	
	var shares []*Share
	for rows.Next() {
		share := &Share{}
		err := rows.Scan(
			&share.ID,
			&share.WorkerID,
			&share.JobID,
			&share.Nonce,
			&share.Difficulty,
			&share.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan share: %w", err)
		}
		shares = append(shares, share)
	}
	
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating shares: %w", err)
	}
	
	return shares, nil
}

// GetSharesByTimeRange retrieves shares within a time range
func (r *shareRepository) GetSharesByTimeRange(ctx context.Context, start, end time.Time) ([]*Share, error) {
	query := `SELECT id, worker_id, job_id, nonce, difficulty, created_at 
			  FROM shares WHERE created_at >= ? AND created_at <= ?`
	
	rows, err := r.manager.conn.QueryContext(ctx, query, start, end)
	if err != nil {
		return nil, fmt.Errorf("failed to get shares by time range: %w", err)
	}
	defer rows.Close()
	
	var shares []*Share
	for rows.Next() {
		share := &Share{}
		err := rows.Scan(
			&share.ID,
			&share.WorkerID,
			&share.JobID,
			&share.Nonce,
			&share.Difficulty,
			&share.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan share: %w", err)
		}
		shares = append(shares, share)
	}
	
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating shares: %w", err)
	}
	
	return shares, nil
}
