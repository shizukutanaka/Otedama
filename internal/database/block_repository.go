package database

import (
	"context"
	"database/sql"
	"fmt"
)

// blockRepository implements the BlockRepository interface
type blockRepository struct {
	manager *Manager
}

// NewBlockRepository creates a new block repository
func NewBlockRepository(manager *Manager) BlockRepository {
	return &blockRepository{
		manager: manager,
	}
}

// CreateBlock creates a new block in the database
func (r *blockRepository) CreateBlock(ctx context.Context, block *Block) error {
	query := `INSERT INTO blocks (height, hash, worker_id, reward, status, created_at) 
			  VALUES (?, ?, ?, ?, ?, ?)`
	
	_, err := r.manager.conn.ExecContext(ctx, query, 
		block.Height, 
		block.Hash, 
		block.WorkerID, 
		block.Reward, 
		block.Status, 
		block.CreatedAt)
	
	if err != nil {
		return fmt.Errorf("failed to create block: %w", err)
	}
	
	return nil
}

// GetBlockByHash retrieves a block by its hash
func (r *blockRepository) GetBlockByHash(ctx context.Context, hash string) (*Block, error) {
	query := `SELECT id, height, hash, worker_id, reward, status, created_at 
			  FROM blocks WHERE hash = ?`
	
	block := &Block{}
	
	var workerID sql.NullInt64
	var reward sql.NullFloat64
	
	err := r.manager.conn.QueryRowContext(ctx, query, hash).Scan(
		&block.ID,
		&block.Height,
		&block.Hash,
		&workerID,
		&reward,
		&block.Status,
		&block.CreatedAt,
	)
	
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil // Block not found
		}
		return nil, fmt.Errorf("failed to get block by hash: %w", err)
	}
	
	// Handle nullable fields
	if workerID.Valid {
		block.WorkerID = &workerID.Int64
	}
	if reward.Valid {
		block.Reward = &reward.Float64
	}
	
	return block, nil
}

// GetBlockByID retrieves a block by its ID
func (r *blockRepository) GetBlockByID(ctx context.Context, id int64) (*Block, error) {
	query := `SELECT id, height, hash, worker_id, reward, status, created_at 
			  FROM blocks WHERE id = ?`
	
	block := &Block{}
	
	var workerID sql.NullInt64
	var reward sql.NullFloat64
	
	err := r.manager.conn.QueryRowContext(ctx, query, id).Scan(
		&block.ID,
		&block.Height,
		&block.Hash,
		&workerID,
		&reward,
		&block.Status,
		&block.CreatedAt,
	)
	
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil // Block not found
		}
		return nil, fmt.Errorf("failed to get block by ID: %w", err)
	}
	
	// Handle nullable fields
	if workerID.Valid {
		block.WorkerID = &workerID.Int64
	}
	if reward.Valid {
		block.Reward = &reward.Float64
	}
	
	return block, nil
}

// UpdateBlockStatus updates a block's status
func (r *blockRepository) UpdateBlockStatus(ctx context.Context, id int64, status string) error {
	query := `UPDATE blocks SET status = ? WHERE id = ?`
	
	_, err := r.manager.conn.ExecContext(ctx, query, status, id)
	if err != nil {
		return fmt.Errorf("failed to update block status: %w", err)
	}
	
	return nil
}

// UpdateBlockReward updates a block's reward
func (r *blockRepository) UpdateBlockReward(ctx context.Context, id int64, reward float64) error {
	query := `UPDATE blocks SET reward = ? WHERE id = ?`
	
	_, err := r.manager.conn.ExecContext(ctx, query, reward, id)
	if err != nil {
		return fmt.Errorf("failed to update block reward: %w", err)
	}
	
	return nil
}
