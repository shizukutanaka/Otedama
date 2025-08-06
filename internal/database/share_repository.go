package database

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"go.uber.org/zap"
)

// ShareRepository handles share-related database operations
type ShareRepository struct {
	db     *DB
	logger *zap.Logger
}

// Share represents a mining share
type Share struct {
	ID          int64     `db:"id"`
	WorkerID    string    `db:"worker_id"`
	JobID       string    `db:"job_id"`
	Nonce       string    `db:"nonce"`
	Hash        string    `db:"hash"`
	Difficulty  float64   `db:"difficulty"`
	Valid       bool      `db:"valid"`
	BlockHeight *int64    `db:"block_height"`
	Reward      float64   `db:"reward"`
	CreatedAt   time.Time `db:"created_at"`
}

// NewShareRepository creates a new share repository
func NewShareRepository(db *DB, logger *zap.Logger) *ShareRepository {
	return &ShareRepository{
		db:     db,
		logger: logger,
	}
}

// Create creates a new share record
func (r *ShareRepository) Create(ctx context.Context, share *Share) error {
	query := `
		INSERT INTO shares (worker_id, job_id, nonce, hash, difficulty, valid, block_height, reward)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`
	
	if r.db.driver == "postgres" {
		query = `
			INSERT INTO shares (worker_id, job_id, nonce, hash, difficulty, valid, block_height, reward)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			RETURNING id, created_at
		`
		
		err := r.db.QueryRow(ctx, query,
			share.WorkerID,
			share.JobID,
			share.Nonce,
			share.Hash,
			share.Difficulty,
			share.Valid,
			share.BlockHeight,
			share.Reward,
		).Scan(&share.ID, &share.CreatedAt)
		
		return err
	}
	
	result, err := r.db.Execute(ctx, query,
		share.WorkerID,
		share.JobID,
		share.Nonce,
		share.Hash,
		share.Difficulty,
		share.Valid,
		share.BlockHeight,
		share.Reward,
	)
	if err != nil {
		return err
	}
	
	share.ID, err = result.LastInsertId()
	share.CreatedAt = time.Now()
	
	return err
}

// GetLastNShares retrieves the last N shares
func (r *ShareRepository) GetLastNShares(ctx context.Context, n int) ([]*Share, error) {
	query := `
		SELECT id, worker_id, job_id, nonce, hash, difficulty, valid, block_height, reward, created_at
		FROM shares
		ORDER BY created_at DESC
		LIMIT ?
	`
	
	if r.db.driver == "postgres" {
		query = `
			SELECT id, worker_id, job_id, nonce, hash, difficulty, valid, block_height, reward, created_at
			FROM shares
			ORDER BY created_at DESC
			LIMIT $1
		`
	}
	
	rows, err := r.db.Query(ctx, query, n)
	if err != nil {
		return nil, err
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
			&share.Hash,
			&share.Difficulty,
			&share.Valid,
			&share.BlockHeight,
			&share.Reward,
			&share.CreatedAt,
		)
		if err != nil {
			return nil, err
		}
		shares = append(shares, share)
	}
	
	return shares, nil
}

// GetSharesForBlock retrieves all shares for a specific block round
func (r *ShareRepository) GetSharesForBlock(ctx context.Context, blockHeight int64) ([]*Share, error) {
	query := `
		SELECT id, worker_id, job_id, nonce, hash, difficulty, valid, block_height, reward, created_at
		FROM shares
		WHERE block_height = ?
		ORDER BY created_at ASC
	`
	
	if r.db.driver == "postgres" {
		query = `
			SELECT id, worker_id, job_id, nonce, hash, difficulty, valid, block_height, reward, created_at
			FROM shares
			WHERE block_height = $1
			ORDER BY created_at ASC
		`
	}
	
	rows, err := r.db.Query(ctx, query, blockHeight)
	if err != nil {
		return nil, err
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
			&share.Hash,
			&share.Difficulty,
			&share.Valid,
			&share.BlockHeight,
			&share.Reward,
			&share.CreatedAt,
		)
		if err != nil {
			return nil, err
		}
		shares = append(shares, share)
	}
	
	return shares, nil
}

// GetUnpaidShares retrieves unpaid shares
func (r *ShareRepository) GetUnpaidShares(ctx context.Context) ([]*Share, error) {
	query := `
		SELECT s.id, s.worker_id, s.job_id, s.nonce, s.hash, s.difficulty, s.valid, s.block_height, s.reward, s.created_at
		FROM shares s
		LEFT JOIN payouts p ON s.worker_id = p.worker_id AND p.status = 'completed'
		WHERE s.valid = true 
		  AND s.created_at > COALESCE((
		    SELECT MAX(processed_at) 
		    FROM payouts 
		    WHERE worker_id = s.worker_id AND status = 'completed'
		  ), '1970-01-01')
		ORDER BY s.created_at ASC
	`
	
	rows, err := r.db.Query(ctx, query)
	if err != nil {
		return nil, err
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
			&share.Hash,
			&share.Difficulty,
			&share.Valid,
			&share.BlockHeight,
			&share.Reward,
			&share.CreatedAt,
		)
		if err != nil {
			return nil, err
		}
		shares = append(shares, share)
	}
	
	return shares, nil
}

// GetWorkerShares retrieves shares for a specific worker
func (r *ShareRepository) GetWorkerShares(ctx context.Context, workerID string, limit int) ([]*Share, error) {
	query := `
		SELECT id, worker_id, job_id, nonce, hash, difficulty, valid, block_height, reward, created_at
		FROM shares
		WHERE worker_id = ?
		ORDER BY created_at DESC
		LIMIT ?
	`
	
	if r.db.driver == "postgres" {
		query = `
			SELECT id, worker_id, job_id, nonce, hash, difficulty, valid, block_height, reward, created_at
			FROM shares
			WHERE worker_id = $1
			ORDER BY created_at DESC
			LIMIT $2
		`
	}
	
	rows, err := r.db.Query(ctx, query, workerID, limit)
	if err != nil {
		return nil, err
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
			&share.Hash,
			&share.Difficulty,
			&share.Valid,
			&share.BlockHeight,
			&share.Reward,
			&share.CreatedAt,
		)
		if err != nil {
			return nil, err
		}
		shares = append(shares, share)
	}
	
	return shares, nil
}

// GetShareStats returns share statistics
func (r *ShareRepository) GetShareStats(ctx context.Context, duration time.Duration) (map[string]interface{}, error) {
	from := time.Now().Add(-duration)
	
	query := `
		SELECT 
			COUNT(*) as total_shares,
			SUM(CASE WHEN valid = true THEN 1 ELSE 0 END) as valid_shares,
			SUM(CASE WHEN valid = false THEN 1 ELSE 0 END) as invalid_shares,
			SUM(CASE WHEN valid = true THEN difficulty ELSE 0 END) as total_difficulty,
			COUNT(DISTINCT worker_id) as unique_workers
		FROM shares
		WHERE created_at >= ?
	`
	
	if r.db.driver == "postgres" {
		query = `
			SELECT 
				COUNT(*) as total_shares,
				SUM(CASE WHEN valid = true THEN 1 ELSE 0 END) as valid_shares,
				SUM(CASE WHEN valid = false THEN 1 ELSE 0 END) as invalid_shares,
				SUM(CASE WHEN valid = true THEN difficulty ELSE 0 END) as total_difficulty,
				COUNT(DISTINCT worker_id) as unique_workers
			FROM shares
			WHERE created_at >= $1
		`
	}
	
	var totalShares, validShares, invalidShares, uniqueWorkers int64
	var totalDifficulty sql.NullFloat64
	
	err := r.db.QueryRow(ctx, query, from).Scan(
		&totalShares,
		&validShares,
		&invalidShares,
		&totalDifficulty,
		&uniqueWorkers,
	)
	
	if err != nil {
		return nil, err
	}
	
	validRate := float64(0)
	if totalShares > 0 {
		validRate = float64(validShares) / float64(totalShares) * 100
	}
	
	stats := map[string]interface{}{
		"total_shares":     totalShares,
		"valid_shares":     validShares,
		"invalid_shares":   invalidShares,
		"valid_rate":       validRate,
		"total_difficulty": totalDifficulty.Float64,
		"unique_workers":   uniqueWorkers,
		"time_window":      duration,
	}
	
	return stats, nil
}

// CleanupOld removes old share records
func (r *ShareRepository) CleanupOld(ctx context.Context, retention time.Duration) error {
	cutoff := time.Now().Add(-retention)
	
	query := `DELETE FROM shares WHERE created_at < ?`
	
	if r.db.driver == "postgres" {
		query = `DELETE FROM shares WHERE created_at < $1`
	}
	
	result, err := r.db.Execute(ctx, query, cutoff)
	if err != nil {
		return err
	}
	
	affected, _ := result.RowsAffected()
	r.logger.Info("Cleaned up old shares",
		zap.Int64("records_deleted", affected),
		zap.Duration("retention", retention),
	)
	
	return nil
}

// GetWorkerShareStats returns share statistics for a specific worker
func (r *ShareRepository) GetWorkerShareStats(ctx context.Context, workerID string, duration time.Duration) (map[string]interface{}, error) {
	from := time.Now().Add(-duration)
	
	query := `
		SELECT 
			COUNT(*) as total_shares,
			SUM(CASE WHEN valid = true THEN 1 ELSE 0 END) as valid_shares,
			SUM(CASE WHEN valid = false THEN 1 ELSE 0 END) as invalid_shares,
			SUM(CASE WHEN valid = true THEN difficulty ELSE 0 END) as total_difficulty,
			MIN(created_at) as first_share,
			MAX(created_at) as last_share
		FROM shares
		WHERE worker_id = ? AND created_at >= ?
	`
	
	if r.db.driver == "postgres" {
		query = `
			SELECT 
				COUNT(*) as total_shares,
				SUM(CASE WHEN valid = true THEN 1 ELSE 0 END) as valid_shares,
				SUM(CASE WHEN valid = false THEN 1 ELSE 0 END) as invalid_shares,
				SUM(CASE WHEN valid = true THEN difficulty ELSE 0 END) as total_difficulty,
				MIN(created_at) as first_share,
				MAX(created_at) as last_share
			FROM shares
			WHERE worker_id = $1 AND created_at >= $2
		`
	}
	
	var totalShares, validShares, invalidShares int64
	var totalDifficulty sql.NullFloat64
	var firstShare, lastShare sql.NullTime
	
	err := r.db.QueryRow(ctx, query, workerID, from).Scan(
		&totalShares,
		&validShares,
		&invalidShares,
		&totalDifficulty,
		&firstShare,
		&lastShare,
	)
	
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	
	validRate := float64(0)
	if totalShares > 0 {
		validRate = float64(validShares) / float64(totalShares) * 100
	}
	
	// Calculate average hashrate
	avgHashrate := float64(0)
	if firstShare.Valid && lastShare.Valid {
		timeDiff := lastShare.Time.Sub(firstShare.Time).Seconds()
		if timeDiff > 0 {
			avgHashrate = totalDifficulty.Float64 * 4294967296 / timeDiff // 2^32
		}
	}
	
	stats := map[string]interface{}{
		"worker_id":        workerID,
		"total_shares":     totalShares,
		"valid_shares":     validShares,
		"invalid_shares":   invalidShares,
		"valid_rate":       validRate,
		"total_difficulty": totalDifficulty.Float64,
		"avg_hashrate":     avgHashrate,
		"time_window":      duration,
		"first_share":      firstShare.Time,
		"last_share":       lastShare.Time,
	}
	
	return stats, nil
}