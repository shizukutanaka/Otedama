package database

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"go.uber.org/zap"
)

// PayoutRepository handles payout-related database operations
type PayoutRepository struct {
	db     *DB
	logger *zap.Logger
}

// Payout represents a payout transaction
type Payout struct {
	ID            int64      `db:"id"`
	WorkerID      string     `db:"worker_id"`
	Amount        float64    `db:"amount"`
	Currency      string     `db:"currency"`
	Address       string     `db:"address"`
	TransactionID *string    `db:"transaction_id"`
	Status        string     `db:"status"`
	CreatedAt     time.Time  `db:"created_at"`
	ProcessedAt   *time.Time `db:"processed_at"`
	ErrorMessage  *string    `db:"error_message"`
}

// NewPayoutRepository creates a new payout repository
func NewPayoutRepository(db *DB, logger *zap.Logger) *PayoutRepository {
	return &PayoutRepository{
		db:     db,
		logger: logger,
	}
}

// Create creates a new payout record
func (r *PayoutRepository) Create(ctx context.Context, payout *Payout) error {
	query := `
		INSERT INTO payouts (worker_id, amount, currency, address, status)
		VALUES (?, ?, ?, ?, ?)
	`
	
	if r.db.driver == "postgres" {
		query = `
			INSERT INTO payouts (worker_id, amount, currency, address, status)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id, created_at
		`
		
		err := r.db.QueryRow(ctx, query,
			payout.WorkerID,
			payout.Amount,
			payout.Currency,
			payout.Address,
			payout.Status,
		).Scan(&payout.ID, &payout.CreatedAt)
		
		return err
	}
	
	result, err := r.db.Execute(ctx, query,
		payout.WorkerID,
		payout.Amount,
		payout.Currency,
		payout.Address,
		payout.Status,
	)
	if err != nil {
		return err
	}
	
	payout.ID, err = result.LastInsertId()
	payout.CreatedAt = time.Now()
	
	return err
}

// Get retrieves a payout by ID
func (r *PayoutRepository) Get(ctx context.Context, payoutID int64) (*Payout, error) {
	payout := &Payout{}
	
	query := `
		SELECT id, worker_id, amount, currency, address, transaction_id,
		       status, created_at, processed_at, error_message
		FROM payouts
		WHERE id = ?
	`
	
	if r.db.driver == "postgres" {
		query = `
			SELECT id, worker_id, amount, currency, address, transaction_id,
			       status, created_at, processed_at, error_message
			FROM payouts
			WHERE id = $1
		`
	}
	
	err := r.db.QueryRow(ctx, query, payoutID).Scan(
		&payout.ID,
		&payout.WorkerID,
		&payout.Amount,
		&payout.Currency,
		&payout.Address,
		&payout.TransactionID,
		&payout.Status,
		&payout.CreatedAt,
		&payout.ProcessedAt,
		&payout.ErrorMessage,
	)
	
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("payout not found: %d", payoutID)
	}
	
	return payout, err
}

// UpdateStatus updates payout status
func (r *PayoutRepository) UpdateStatus(ctx context.Context, payoutID int64, status string, txID *string, errorMsg *string) error {
	var query string
	var args []interface{}
	
	if status == "completed" && txID != nil {
		query = `UPDATE payouts SET status = ?, transaction_id = ?, processed_at = ? WHERE id = ?`
		args = []interface{}{status, *txID, time.Now(), payoutID}
		
		if r.db.driver == "postgres" {
			query = `UPDATE payouts SET status = $1, transaction_id = $2, processed_at = $3 WHERE id = $4`
		}
	} else if status == "failed" && errorMsg != nil {
		query = `UPDATE payouts SET status = ?, error_message = ?, processed_at = ? WHERE id = ?`
		args = []interface{}{status, *errorMsg, time.Now(), payoutID}
		
		if r.db.driver == "postgres" {
			query = `UPDATE payouts SET status = $1, error_message = $2, processed_at = $3 WHERE id = $4`
		}
	} else {
		query = `UPDATE payouts SET status = ? WHERE id = ?`
		args = []interface{}{status, payoutID}
		
		if r.db.driver == "postgres" {
			query = `UPDATE payouts SET status = $1 WHERE id = $2`
		}
	}
	
	_, err := r.db.Execute(ctx, query, args...)
	return err
}

// ListPending lists all pending payouts
func (r *PayoutRepository) ListPending(ctx context.Context) ([]*Payout, error) {
	query := `
		SELECT id, worker_id, amount, currency, address, transaction_id,
		       status, created_at, processed_at, error_message
		FROM payouts
		WHERE status = 'pending'
		ORDER BY created_at ASC
	`
	
	rows, err := r.db.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	var payouts []*Payout
	for rows.Next() {
		payout := &Payout{}
		err := rows.Scan(
			&payout.ID,
			&payout.WorkerID,
			&payout.Amount,
			&payout.Currency,
			&payout.Address,
			&payout.TransactionID,
			&payout.Status,
			&payout.CreatedAt,
			&payout.ProcessedAt,
			&payout.ErrorMessage,
		)
		if err != nil {
			return nil, err
		}
		payouts = append(payouts, payout)
	}
	
	return payouts, nil
}

// GetWorkerPayouts gets payouts for a specific worker
func (r *PayoutRepository) GetWorkerPayouts(ctx context.Context, workerID string, limit int) ([]*Payout, error) {
	query := `
		SELECT id, worker_id, amount, currency, address, transaction_id,
		       status, created_at, processed_at, error_message
		FROM payouts
		WHERE worker_id = ?
		ORDER BY created_at DESC
		LIMIT ?
	`
	
	if r.db.driver == "postgres" {
		query = `
			SELECT id, worker_id, amount, currency, address, transaction_id,
			       status, created_at, processed_at, error_message
			FROM payouts
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
	
	var payouts []*Payout
	for rows.Next() {
		payout := &Payout{}
		err := rows.Scan(
			&payout.ID,
			&payout.WorkerID,
			&payout.Amount,
			&payout.Currency,
			&payout.Address,
			&payout.TransactionID,
			&payout.Status,
			&payout.CreatedAt,
			&payout.ProcessedAt,
			&payout.ErrorMessage,
		)
		if err != nil {
			return nil, err
		}
		payouts = append(payouts, payout)
	}
	
	return payouts, nil
}

// GetWorkerBalance calculates the unpaid balance for a worker
func (r *PayoutRepository) GetWorkerBalance(ctx context.Context, workerID string) (float64, error) {
	// Calculate total earnings from confirmed blocks
	earningsQuery := `
		SELECT COALESCE(SUM(s.reward), 0)
		FROM shares s
		JOIN blocks b ON s.block_height = b.height
		WHERE s.worker_id = ? AND b.status = 'confirmed'
	`
	
	if r.db.driver == "postgres" {
		earningsQuery = `
			SELECT COALESCE(SUM(s.reward), 0)
			FROM shares s
			JOIN blocks b ON s.block_height = b.height
			WHERE s.worker_id = $1 AND b.status = 'confirmed'
		`
	}
	
	var totalEarnings float64
	err := r.db.QueryRow(ctx, earningsQuery, workerID).Scan(&totalEarnings)
	if err != nil {
		return 0, err
	}
	
	// Calculate total paid out
	paidQuery := `
		SELECT COALESCE(SUM(amount), 0)
		FROM payouts
		WHERE worker_id = ? AND status = 'completed'
	`
	
	if r.db.driver == "postgres" {
		paidQuery = `
			SELECT COALESCE(SUM(amount), 0)
			FROM payouts
			WHERE worker_id = $1 AND status = 'completed'
		`
	}
	
	var totalPaid float64
	err = r.db.QueryRow(ctx, paidQuery, workerID).Scan(&totalPaid)
	if err != nil {
		return 0, err
	}
	
	balance := totalEarnings - totalPaid
	return balance, nil
}

// GetPayoutStats returns payout statistics
func (r *PayoutRepository) GetPayoutStats(ctx context.Context, duration time.Duration) (map[string]interface{}, error) {
	from := time.Now().Add(-duration)
	
	query := `
		SELECT 
			COUNT(*) as total_payouts,
			SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_payouts,
			SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_payouts,
			SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END) as total_paid,
			AVG(CASE WHEN status = 'completed' THEN amount ELSE NULL END) as avg_payout,
			COUNT(DISTINCT worker_id) as unique_workers
		FROM payouts
		WHERE created_at >= ?
	`
	
	if r.db.driver == "postgres" {
		query = `
			SELECT 
				COUNT(*) as total_payouts,
				SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_payouts,
				SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_payouts,
				SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END) as total_paid,
				AVG(CASE WHEN status = 'completed' THEN amount ELSE NULL END) as avg_payout,
				COUNT(DISTINCT worker_id) as unique_workers
			FROM payouts
			WHERE created_at >= $1
		`
	}
	
	var totalPayouts, completedPayouts, failedPayouts, uniqueWorkers int64
	var totalPaid, avgPayout sql.NullFloat64
	
	err := r.db.QueryRow(ctx, query, from).Scan(
		&totalPayouts,
		&completedPayouts,
		&failedPayouts,
		&totalPaid,
		&avgPayout,
		&uniqueWorkers,
	)
	
	if err != nil {
		return nil, err
	}
	
	stats := map[string]interface{}{
		"total_payouts":      totalPayouts,
		"completed_payouts":  completedPayouts,
		"failed_payouts":     failedPayouts,
		"total_paid":         totalPaid.Float64,
		"avg_payout":         avgPayout.Float64,
		"unique_workers":     uniqueWorkers,
		"time_window":        duration,
	}
	
	return stats, nil
}

// CreateBatch creates multiple payouts in a transaction
func (r *PayoutRepository) CreateBatch(ctx context.Context, payouts []*Payout) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	
	query := `
		INSERT INTO payouts (worker_id, amount, currency, address, status)
		VALUES (?, ?, ?, ?, ?)
	`
	
	if r.db.driver == "postgres" {
		query = `
			INSERT INTO payouts (worker_id, amount, currency, address, status)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id, created_at
		`
	}
	
	for _, payout := range payouts {
		if r.db.driver == "postgres" {
			err := tx.QueryRow(ctx, query,
				payout.WorkerID,
				payout.Amount,
				payout.Currency,
				payout.Address,
				payout.Status,
			).Scan(&payout.ID, &payout.CreatedAt)
			
			if err != nil {
				return err
			}
		} else {
			result, err := tx.Execute(ctx, query,
				payout.WorkerID,
				payout.Amount,
				payout.Currency,
				payout.Address,
				payout.Status,
			)
			if err != nil {
				return err
			}
			
			payout.ID, err = result.LastInsertId()
			if err != nil {
				return err
			}
			payout.CreatedAt = time.Now()
		}
	}
	
	return tx.Commit()
}