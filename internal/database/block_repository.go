package database

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"go.uber.org/zap"
)

// BlockRepository handles block-related database operations
type BlockRepository struct {
	db     *DB
	logger *zap.Logger
}

// Block represents a mined block
type Block struct {
	ID             int64      `db:"id"`
	Height         int64      `db:"height"`
	Hash           string     `db:"hash"`
	PreviousHash   string     `db:"previous_hash"`
	Timestamp      time.Time  `db:"timestamp"`
	Difficulty     float64    `db:"difficulty"`
	Reward         float64    `db:"reward"`
	FinderWorkerID *string    `db:"finder_worker_id"`
	Status         string     `db:"status"`
	Confirmations  int        `db:"confirmations"`
	Processed      bool       `db:"processed"`
	CreatedAt      time.Time  `db:"created_at"`
	ConfirmedAt    *time.Time `db:"confirmed_at"`
	Miner          string     // Alias for FinderWorkerID for compatibility
}

// NewBlockRepository creates a new block repository
func NewBlockRepository(db *DB, logger *zap.Logger) *BlockRepository {
	return &BlockRepository{
		db:     db,
		logger: logger,
	}
}

// Create creates a new block record
func (r *BlockRepository) Create(ctx context.Context, block *Block) error {
	query := `
		INSERT INTO blocks (height, hash, previous_hash, timestamp, difficulty, reward, finder_worker_id, status)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`
	
	if r.db.driver == "postgres" {
		query = `
			INSERT INTO blocks (height, hash, previous_hash, timestamp, difficulty, reward, finder_worker_id, status)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			RETURNING id, created_at
		`
		
		err := r.db.QueryRow(ctx, query,
			block.Height,
			block.Hash,
			block.PreviousHash,
			block.Timestamp,
			block.Difficulty,
			block.Reward,
			block.FinderWorkerID,
			block.Status,
		).Scan(&block.ID, &block.CreatedAt)
		
		return err
	}
	
	result, err := r.db.Execute(ctx, query,
		block.Height,
		block.Hash,
		block.PreviousHash,
		block.Timestamp,
		block.Difficulty,
		block.Reward,
		block.FinderWorkerID,
		block.Status,
	)
	if err != nil {
		return err
	}
	
	block.ID, err = result.LastInsertId()
	block.CreatedAt = time.Now()
	
	return err
}

// GetByHeight retrieves a block by height
func (r *BlockRepository) GetByHeight(ctx context.Context, height int64) (*Block, error) {
	block := &Block{}
	
	query := `
		SELECT id, height, hash, previous_hash, timestamp, difficulty, reward,
		       finder_worker_id, status, confirmations, created_at, confirmed_at
		FROM blocks
		WHERE height = ?
	`
	
	if r.db.driver == "postgres" {
		query = `
			SELECT id, height, hash, previous_hash, timestamp, difficulty, reward,
			       finder_worker_id, status, confirmations, created_at, confirmed_at
			FROM blocks
			WHERE height = $1
		`
	}
	
	err := r.db.QueryRow(ctx, query, height).Scan(
		&block.ID,
		&block.Height,
		&block.Hash,
		&block.PreviousHash,
		&block.Timestamp,
		&block.Difficulty,
		&block.Reward,
		&block.FinderWorkerID,
		&block.Status,
		&block.Confirmations,
		&block.CreatedAt,
		&block.ConfirmedAt,
	)
	
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("block not found at height: %d", height)
	}
	
	return block, err
}

// GetByHash retrieves a block by hash
func (r *BlockRepository) GetByHash(ctx context.Context, hash string) (*Block, error) {
	block := &Block{}
	
	query := `
		SELECT id, height, hash, previous_hash, timestamp, difficulty, reward,
		       finder_worker_id, status, confirmations, created_at, confirmed_at
		FROM blocks
		WHERE hash = ?
	`
	
	if r.db.driver == "postgres" {
		query = `
			SELECT id, height, hash, previous_hash, timestamp, difficulty, reward,
			       finder_worker_id, status, confirmations, created_at, confirmed_at
			FROM blocks
			WHERE hash = $1
		`
	}
	
	err := r.db.QueryRow(ctx, query, hash).Scan(
		&block.ID,
		&block.Height,
		&block.Hash,
		&block.PreviousHash,
		&block.Timestamp,
		&block.Difficulty,
		&block.Reward,
		&block.FinderWorkerID,
		&block.Status,
		&block.Confirmations,
		&block.CreatedAt,
		&block.ConfirmedAt,
	)
	
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("block not found with hash: %s", hash)
	}
	
	return block, err
}

// UpdateConfirmations updates block confirmations
func (r *BlockRepository) UpdateConfirmations(ctx context.Context, blockID int64, confirmations int) error {
	query := `UPDATE blocks SET confirmations = ? WHERE id = ?`
	
	if r.db.driver == "postgres" {
		query = `UPDATE blocks SET confirmations = $1 WHERE id = $2`
	}
	
	_, err := r.db.Execute(ctx, query, confirmations, blockID)
	return err
}

// UpdateStatus updates block status
func (r *BlockRepository) UpdateStatus(ctx context.Context, blockID int64, status string) error {
	var query string
	var args []interface{}
	
	if status == "confirmed" {
		query = `UPDATE blocks SET status = ?, confirmed_at = ? WHERE id = ?`
		args = []interface{}{status, time.Now(), blockID}
		
		if r.db.driver == "postgres" {
			query = `UPDATE blocks SET status = $1, confirmed_at = $2 WHERE id = $3`
		}
	} else {
		query = `UPDATE blocks SET status = ? WHERE id = ?`
		args = []interface{}{status, blockID}
		
		if r.db.driver == "postgres" {
			query = `UPDATE blocks SET status = $1 WHERE id = $2`
		}
	}
	
	_, err := r.db.Execute(ctx, query, args...)
	return err
}

// ListPending lists all pending blocks
func (r *BlockRepository) ListPending(ctx context.Context) ([]*Block, error) {
	query := `
		SELECT id, height, hash, previous_hash, timestamp, difficulty, reward,
		       finder_worker_id, status, confirmations, created_at, confirmed_at
		FROM blocks
		WHERE status = 'pending'
		ORDER BY height DESC
	`
	
	rows, err := r.db.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	var blocks []*Block
	for rows.Next() {
		block := &Block{}
		err := rows.Scan(
			&block.ID,
			&block.Height,
			&block.Hash,
			&block.PreviousHash,
			&block.Timestamp,
			&block.Difficulty,
			&block.Reward,
			&block.FinderWorkerID,
			&block.Status,
			&block.Confirmations,
			&block.CreatedAt,
			&block.ConfirmedAt,
		)
		if err != nil {
			return nil, err
		}
		blocks = append(blocks, block)
	}
	
	return blocks, nil
}

// ListRecent lists recent blocks
func (r *BlockRepository) ListRecent(ctx context.Context, limit int) ([]*Block, error) {
	query := `
		SELECT id, height, hash, previous_hash, timestamp, difficulty, reward,
		       finder_worker_id, status, confirmations, created_at, confirmed_at
		FROM blocks
		ORDER BY height DESC
		LIMIT ?
	`
	
	if r.db.driver == "postgres" {
		query = `
			SELECT id, height, hash, previous_hash, timestamp, difficulty, reward,
			       finder_worker_id, status, confirmations, created_at, confirmed_at
			FROM blocks
			ORDER BY height DESC
			LIMIT $1
		`
	}
	
	rows, err := r.db.Query(ctx, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	var blocks []*Block
	for rows.Next() {
		block := &Block{}
		err := rows.Scan(
			&block.ID,
			&block.Height,
			&block.Hash,
			&block.PreviousHash,
			&block.Timestamp,
			&block.Difficulty,
			&block.Reward,
			&block.FinderWorkerID,
			&block.Status,
			&block.Confirmations,
			&block.CreatedAt,
			&block.ConfirmedAt,
		)
		if err != nil {
			return nil, err
		}
		blocks = append(blocks, block)
	}
	
	return blocks, nil
}

// GetPendingBlocks retrieves all pending blocks
func (r *BlockRepository) GetPendingBlocks(ctx context.Context) ([]*Block, error) {
	query := `
		SELECT id, height, hash, previous_hash, difficulty, reward, miner, status, created_at
		FROM blocks
		WHERE status = 'pending'
		ORDER BY created_at ASC
	`
	
	rows, err := r.db.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	var blocks []*Block
	for rows.Next() {
		block := &Block{}
		err := rows.Scan(
			&block.ID,
			&block.Height,
			&block.Hash,
			&block.PreviousHash,
			&block.Difficulty,
			&block.Reward,
			&block.Miner,
			&block.Status,
			&block.CreatedAt,
		)
		if err != nil {
			return nil, err
		}
		blocks = append(blocks, block)
	}
	
	return blocks, nil
}

// GetUnprocessedMatureBlocks gets mature blocks that haven't been processed for payouts
func (r *BlockRepository) GetUnprocessedMatureBlocks(ctx context.Context, maturityBlocks int) ([]*Block, error) {
	// Get current chain height (would be from blockchain client in real implementation)
	// For now, using a placeholder
	currentHeight := int64(1000000) // This should come from blockchain
	
	query := `
		SELECT id, height, hash, previous_hash, difficulty, reward, miner, status, created_at
		FROM blocks
		WHERE status = 'confirmed'
		  AND height <= ?
		  AND processed = false
		ORDER BY height ASC
	`
	
	if r.db.driver == "postgres" {
		query = `
			SELECT id, height, hash, previous_hash, difficulty, reward, miner, status, created_at
			FROM blocks
			WHERE status = 'confirmed'
			  AND height <= $1
			  AND processed = false
			ORDER BY height ASC
		`
	}
	
	matureHeight := currentHeight - int64(maturityBlocks)
	
	rows, err := r.db.Query(ctx, query, matureHeight)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	var blocks []*Block
	for rows.Next() {
		block := &Block{}
		err := rows.Scan(
			&block.ID,
			&block.Height,
			&block.Hash,
			&block.PreviousHash,
			&block.Difficulty,
			&block.Reward,
			&block.Miner,
			&block.Status,
			&block.CreatedAt,
		)
		if err != nil {
			return nil, err
		}
		blocks = append(blocks, block)
	}
	
	return blocks, nil
}

// MarkProcessed marks a block as processed for payouts
func (r *BlockRepository) MarkProcessed(ctx context.Context, blockHeight int64) error {
	query := `UPDATE blocks SET processed = true WHERE height = ?`
	
	if r.db.driver == "postgres" {
		query = `UPDATE blocks SET processed = true WHERE height = $1`
	}
	
	_, err := r.db.Execute(ctx, query, blockHeight)
	return err
}

// UpdateStatus updates the status of a block with optional confirmations
func (r *BlockRepository) UpdateStatus(ctx context.Context, blockID int64, status string, confirmations *int) error {
	var query string
	var args []interface{}
	
	if confirmations != nil {
		query = `UPDATE blocks SET status = ?, confirmations = ? WHERE id = ?`
		args = []interface{}{status, *confirmations, blockID}
		
		if r.db.driver == "postgres" {
			query = `UPDATE blocks SET status = $1, confirmations = $2 WHERE id = $3`
		}
	} else {
		query = `UPDATE blocks SET status = ? WHERE id = ?`
		args = []interface{}{status, blockID}
		
		if r.db.driver == "postgres" {
			query = `UPDATE blocks SET status = $1 WHERE id = $2`
		}
	}
	
	_, err := r.db.Execute(ctx, query, args...)
	return err
}

// GetBlockStats returns block statistics
func (r *BlockRepository) GetBlockStats(ctx context.Context, duration time.Duration) (map[string]interface{}, error) {
	from := time.Now().Add(-duration)
	
	query := `
		SELECT 
			COUNT(*) as total_blocks,
			SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmed_blocks,
			SUM(CASE WHEN status = 'orphaned' THEN 1 ELSE 0 END) as orphaned_blocks,
			SUM(reward) as total_rewards,
			AVG(difficulty) as avg_difficulty
		FROM blocks
		WHERE created_at >= ?
	`
	
	if r.db.driver == "postgres" {
		query = `
			SELECT 
				COUNT(*) as total_blocks,
				SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmed_blocks,
				SUM(CASE WHEN status = 'orphaned' THEN 1 ELSE 0 END) as orphaned_blocks,
				SUM(reward) as total_rewards,
				AVG(difficulty) as avg_difficulty
			FROM blocks
			WHERE created_at >= $1
		`
	}
	
	var totalBlocks, confirmedBlocks, orphanedBlocks int64
	var totalRewards, avgDifficulty sql.NullFloat64
	
	err := r.db.QueryRow(ctx, query, from).Scan(
		&totalBlocks,
		&confirmedBlocks,
		&orphanedBlocks,
		&totalRewards,
		&avgDifficulty,
	)
	
	if err != nil {
		return nil, err
	}
	
	stats := map[string]interface{}{
		"total_blocks":      totalBlocks,
		"confirmed_blocks":  confirmedBlocks,
		"orphaned_blocks":   orphanedBlocks,
		"total_rewards":     totalRewards.Float64,
		"avg_difficulty":    avgDifficulty.Float64,
		"time_window":       duration,
		"blocks_per_hour":   float64(totalBlocks) / duration.Hours(),
	}
	
	return stats, nil
}

// GetWorkerBlocks gets blocks found by a specific worker
func (r *BlockRepository) GetWorkerBlocks(ctx context.Context, workerID string, limit int) ([]*Block, error) {
	query := `
		SELECT id, height, hash, previous_hash, timestamp, difficulty, reward,
		       finder_worker_id, status, confirmations, created_at, confirmed_at
		FROM blocks
		WHERE finder_worker_id = ?
		ORDER BY height DESC
		LIMIT ?
	`
	
	if r.db.driver == "postgres" {
		query = `
			SELECT id, height, hash, previous_hash, timestamp, difficulty, reward,
			       finder_worker_id, status, confirmations, created_at, confirmed_at
			FROM blocks
			WHERE finder_worker_id = $1
			ORDER BY height DESC
			LIMIT $2
		`
	}
	
	rows, err := r.db.Query(ctx, query, workerID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	var blocks []*Block
	for rows.Next() {
		block := &Block{}
		err := rows.Scan(
			&block.ID,
			&block.Height,
			&block.Hash,
			&block.PreviousHash,
			&block.Timestamp,
			&block.Difficulty,
			&block.Reward,
			&block.FinderWorkerID,
			&block.Status,
			&block.Confirmations,
			&block.CreatedAt,
			&block.ConfirmedAt,
		)
		if err != nil {
			return nil, err
		}
		blocks = append(blocks, block)
	}
	
	return blocks, nil
}