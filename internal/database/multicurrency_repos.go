package database

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"go.uber.org/zap"
)

// Multi-currency extensions for repositories

// GetLastNSharesByCurrency returns the last N shares for a specific currency
func (r *ShareRepository) GetLastNSharesByCurrency(ctx context.Context, currency string, limit int) ([]*Share, error) {
	query := `
		SELECT id, worker_id, job_id, nonce, hash, difficulty, valid, 
		       block_height, reward, created_at, updated_at 
		FROM shares 
		WHERE currency = $1
		ORDER BY created_at DESC 
		LIMIT $2
	`
	
	rows, err := r.db.Query(ctx, query, currency, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	var shares []*Share
	for rows.Next() {
		share := &Share{}
		err := rows.Scan(
			&share.ID, &share.WorkerID, &share.JobID, &share.Nonce,
			&share.Hash, &share.Difficulty, &share.Valid,
			&share.BlockHeight, &share.Reward, &share.CreatedAt, &share.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}
		shares = append(shares, share)
	}
	
	return shares, nil
}

// GetUnpaidSharesByCurrency returns unpaid shares for a currency
func (r *ShareRepository) GetUnpaidSharesByCurrency(ctx context.Context, currency string) ([]*Share, error) {
	query := `
		SELECT id, worker_id, job_id, nonce, hash, difficulty, valid, 
		       block_height, reward, created_at, updated_at 
		FROM shares 
		WHERE currency = $1 AND paid = false AND valid = true
		ORDER BY created_at ASC
	`
	
	rows, err := r.db.Query(ctx, query, currency)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	var shares []*Share
	for rows.Next() {
		share := &Share{}
		err := rows.Scan(
			&share.ID, &share.WorkerID, &share.JobID, &share.Nonce,
			&share.Hash, &share.Difficulty, &share.Valid,
			&share.BlockHeight, &share.Reward, &share.CreatedAt, &share.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}
		shares = append(shares, share)
	}
	
	return shares, nil
}

// GetSharesForBlockByCurrency returns shares for a specific block and currency
func (r *ShareRepository) GetSharesForBlockByCurrency(ctx context.Context, blockHeight int64, currency string) ([]*Share, error) {
	query := `
		SELECT id, worker_id, job_id, nonce, hash, difficulty, valid, 
		       block_height, reward, created_at, updated_at 
		FROM shares 
		WHERE block_height = $1 AND currency = $2
		ORDER BY created_at ASC
	`
	
	rows, err := r.db.Query(ctx, query, blockHeight, currency)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	var shares []*Share
	for rows.Next() {
		share := &Share{}
		err := rows.Scan(
			&share.ID, &share.WorkerID, &share.JobID, &share.Nonce,
			&share.Hash, &share.Difficulty, &share.Valid,
			&share.BlockHeight, &share.Reward, &share.CreatedAt, &share.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}
		shares = append(shares, share)
	}
	
	return shares, nil
}

// GetWorkerSharesByCurrency returns shares for a worker and currency
func (r *ShareRepository) GetWorkerSharesByCurrency(ctx context.Context, workerID, currency string, limit int) ([]*Share, error) {
	query := `
		SELECT id, worker_id, job_id, nonce, hash, difficulty, valid, 
		       block_height, reward, created_at, updated_at 
		FROM shares 
		WHERE worker_id = $1 AND currency = $2
		ORDER BY created_at DESC 
		LIMIT $3
	`
	
	rows, err := r.db.Query(ctx, query, workerID, currency, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	var shares []*Share
	for rows.Next() {
		share := &Share{}
		err := rows.Scan(
			&share.ID, &share.WorkerID, &share.JobID, &share.Nonce,
			&share.Hash, &share.Difficulty, &share.Valid,
			&share.BlockHeight, &share.Reward, &share.CreatedAt, &share.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}
		shares = append(shares, share)
	}
	
	return shares, nil
}

// Multi-currency block repository methods

// GetUnprocessedMatureBlocksByCurrency returns mature blocks for a currency
func (r *BlockRepository) GetUnprocessedMatureBlocksByCurrency(ctx context.Context, currency string, maturity int) ([]*Block, error) {
	query := `
		SELECT id, height, hash, previous_hash, timestamp, difficulty, 
		       nonce, miner, reward, tx_count, size, status, confirmations,
		       created_at, updated_at
		FROM blocks 
		WHERE currency = $1 
		  AND status = 'confirmed' 
		  AND processed = false
		  AND confirmations >= $2
		ORDER BY height ASC
	`
	
	rows, err := r.db.Query(ctx, query, currency, maturity)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	var blocks []*Block
	for rows.Next() {
		block := &Block{}
		err := rows.Scan(
			&block.ID, &block.Height, &block.Hash, &block.PreviousHash,
			&block.Timestamp, &block.Difficulty, &block.Nonce, &block.Miner,
			&block.Reward, &block.TxCount, &block.Size, &block.Status,
			&block.Confirmations, &block.CreatedAt, &block.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}
		blocks = append(blocks, block)
	}
	
	return blocks, nil
}

// Multi-currency payout repository methods

// ListPendingByCurrency returns pending payouts for a currency
func (r *PayoutRepository) ListPendingByCurrency(ctx context.Context, currency string) ([]*Payout, error) {
	query := `
		SELECT id, worker_id, amount, currency, address, tx_id, 
		       status, created_at, updated_at, paid_at
		FROM payouts
		WHERE currency = $1 AND status = 'pending'
		ORDER BY created_at ASC
	`
	
	rows, err := r.db.Query(ctx, query, currency)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	return r.scanPayouts(rows)
}

// GetWorkerBalanceByCurrency returns worker balance for a currency
func (r *PayoutRepository) GetWorkerBalanceByCurrency(ctx context.Context, workerID, currency string) (int64, error) {
	query := `
		SELECT COALESCE(SUM(amount), 0) 
		FROM payouts 
		WHERE worker_id = $1 AND currency = $2 AND status = 'paid'
	`
	
	var balance int64
	err := r.db.QueryRow(ctx, query, workerID, currency).Scan(&balance)
	if err != nil {
		return 0, err
	}
	
	return balance, nil
}

// GetWorkerPayoutsByCurrency returns worker payouts for a currency
func (r *PayoutRepository) GetWorkerPayoutsByCurrency(ctx context.Context, workerID, currency string, limit int) ([]*Payout, error) {
	query := `
		SELECT id, worker_id, amount, currency, address, tx_id, 
		       status, created_at, updated_at, paid_at
		FROM payouts
		WHERE worker_id = $1 AND currency = $2
		ORDER BY created_at DESC
		LIMIT $3
	`
	
	rows, err := r.db.Query(ctx, query, workerID, currency, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	return r.scanPayouts(rows)
}

// GetPayoutStatsByCurrency returns payout statistics by currency
func (r *PayoutRepository) GetPayoutStatsByCurrency(ctx context.Context, currency string, period time.Duration) (map[string]interface{}, error) {
	since := time.Now().Add(-period)
	
	// Total paid
	var totalPaid int64
	err := r.db.QueryRow(ctx, `
		SELECT COALESCE(SUM(amount), 0) 
		FROM payouts 
		WHERE currency = $1 AND status = 'paid' AND paid_at > $2
	`, currency, since).Scan(&totalPaid)
	if err != nil {
		return nil, err
	}
	
	// Total pending
	var totalPending int64
	err = r.db.QueryRow(ctx, `
		SELECT COALESCE(SUM(amount), 0) 
		FROM payouts 
		WHERE currency = $1 AND status = 'pending'
	`, currency).Scan(&totalPending)
	if err != nil {
		return nil, err
	}
	
	// Unique workers paid
	var workersPaid int
	err = r.db.QueryRow(ctx, `
		SELECT COUNT(DISTINCT worker_id) 
		FROM payouts 
		WHERE currency = $1 AND status = 'paid' AND paid_at > $2
	`, currency, since).Scan(&workersPaid)
	if err != nil {
		return nil, err
	}
	
	// Payout count
	var payoutCount int
	err = r.db.QueryRow(ctx, `
		SELECT COUNT(*) 
		FROM payouts 
		WHERE currency = $1 AND status = 'paid' AND paid_at > $2
	`, currency, since).Scan(&payoutCount)
	if err != nil {
		return nil, err
	}
	
	return map[string]interface{}{
		"currency":       currency,
		"total_paid":     totalPaid,
		"total_pending":  totalPending,
		"workers_paid":   workersPaid,
		"payout_count":   payoutCount,
		"period":         period.String(),
	}, nil
}

// Multi-currency statistics methods

// GetStatisticsByCurrency returns statistics for a specific currency
func (r *StatisticsRepository) GetStatisticsByCurrency(ctx context.Context, currency string, metricName string, period time.Duration) ([]*Statistic, error) {
	since := time.Now().Add(-period)
	
	query := `
		SELECT id, metric_name, metric_value, worker_id, metadata, created_at
		FROM statistics
		WHERE metric_name = $1 
		  AND created_at > $2
		  AND metadata->>'currency' = $3
		ORDER BY created_at DESC
	`
	
	rows, err := r.db.Query(ctx, query, metricName, since, currency)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	var stats []*Statistic
	for rows.Next() {
		stat := &Statistic{
			Metadata: make(map[string]interface{}),
		}
		
		var metadataJSON []byte
		err := rows.Scan(
			&stat.ID, &stat.MetricName, &stat.MetricValue,
			&stat.WorkerID, &metadataJSON, &stat.CreatedAt,
		)
		if err != nil {
			return nil, err
		}
		
		if len(metadataJSON) > 0 {
			if err := json.Unmarshal(metadataJSON, &stat.Metadata); err != nil {
				r.logger.Warn("Failed to unmarshal metadata", zap.Error(err))
			}
		}
		
		stats = append(stats, stat)
	}
	
	return stats, nil
}

// GetPoolStatsByCurrency returns pool-wide statistics for a currency
func (r *StatisticsRepository) GetPoolStatsByCurrency(ctx context.Context, currency string) (map[string]interface{}, error) {
	// Get current hashrate
	var hashrate float64
	err := r.db.QueryRow(ctx, `
		SELECT COALESCE(SUM(metric_value), 0)
		FROM statistics
		WHERE metric_name = 'worker_hashrate'
		  AND created_at > $1
		  AND metadata->>'currency' = $2
	`, time.Now().Add(-10*time.Minute), currency).Scan(&hashrate)
	if err != nil {
		return nil, err
	}
	
	// Get active workers
	var activeWorkers int
	err = r.db.QueryRow(ctx, `
		SELECT COUNT(DISTINCT worker_id)
		FROM statistics
		WHERE metric_name = 'worker_hashrate'
		  AND created_at > $1
		  AND metadata->>'currency' = $2
		  AND worker_id IS NOT NULL
	`, time.Now().Add(-10*time.Minute), currency).Scan(&activeWorkers)
	if err != nil {
		return nil, err
	}
	
	// Get total shares last 24h
	var totalShares int64
	err = r.db.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM shares
		WHERE created_at > $1
		  AND currency = $2
	`, time.Now().Add(-24*time.Hour), currency).Scan(&totalShares)
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	
	// Get blocks found last 24h
	var blocksFound int
	err = r.db.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM blocks
		WHERE created_at > $1
		  AND currency = $2
		  AND status != 'orphaned'
	`, time.Now().Add(-24*time.Hour), currency).Scan(&blocksFound)
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	
	return map[string]interface{}{
		"currency":       currency,
		"hashrate":       hashrate,
		"active_workers": activeWorkers,
		"shares_24h":     totalShares,
		"blocks_24h":     blocksFound,
		"timestamp":      time.Now(),
	}, nil
}

// GetHashrateHistoryByCurrency returns hashrate history for a currency
func (r *StatisticsRepository) GetHashrateHistoryByCurrency(ctx context.Context, currency string, interval time.Duration, points int) ([]map[string]interface{}, error) {
	// Calculate time buckets
	now := time.Now()
	bucketSize := interval / time.Duration(points)
	
	history := make([]map[string]interface{}, points)
	
	for i := 0; i < points; i++ {
		endTime := now.Add(-time.Duration(i) * bucketSize)
		startTime := endTime.Add(-bucketSize)
		
		var hashrate float64
		err := r.db.QueryRow(ctx, `
			SELECT COALESCE(AVG(metric_value), 0)
			FROM statistics
			WHERE metric_name = 'pool_hashrate'
			  AND created_at BETWEEN $1 AND $2
			  AND metadata->>'currency' = $3
		`, startTime, endTime, currency).Scan(&hashrate)
		
		if err != nil && err != sql.ErrNoRows {
			return nil, err
		}
		
		history[points-1-i] = map[string]interface{}{
			"timestamp": endTime,
			"hashrate":  hashrate,
		}
	}
	
	return history, nil
}