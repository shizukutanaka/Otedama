package database

import (
	"context"
	"database/sql"
	"fmt"
)

// payoutRepository implements the PayoutRepository interface
type payoutRepository struct {
	manager *Manager
}

// NewPayoutRepository creates a new payout repository
func NewPayoutRepository(manager *Manager) PayoutRepository {
	return &payoutRepository{
		manager: manager,
	}
}

// CreatePayout creates a new payout in the database
func (r *payoutRepository) CreatePayout(ctx context.Context, payout *Payout) error {
	query := `INSERT INTO payouts (worker_id, amount, tx_id, status, created_at) 
			  VALUES (?, ?, ?, ?, ?)`
	
	var txID interface{}
	if payout.TxID != nil {
		txID = *payout.TxID
	}
	
	_, err := r.manager.conn.ExecContext(ctx, query, 
		payout.WorkerID, 
		payout.Amount, 
		txID, 
		payout.Status, 
		payout.CreatedAt)
	
	if err != nil {
		return fmt.Errorf("failed to create payout: %w", err)
	}
	
	return nil
}

// GetPayoutByID retrieves a payout by its ID
func (r *payoutRepository) GetPayoutByID(ctx context.Context, id int64) (*Payout, error) {
	query := `SELECT id, worker_id, amount, tx_id, status, created_at 
			  FROM payouts WHERE id = ?`
	
	payout := &Payout{}
	
	var txID sql.NullString
	
	err := r.manager.conn.QueryRowContext(ctx, query, id).Scan(
		&payout.ID,
		&payout.WorkerID,
		&payout.Amount,
		&txID,
		&payout.Status,
		&payout.CreatedAt,
	)
	
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil // Payout not found
		}
		return nil, fmt.Errorf("failed to get payout by ID: %w", err)
	}
	
	// Handle nullable fields
	if txID.Valid {
		payout.TxID = &txID.String
	}
	
	return payout, nil
}

// GetPayoutsByWorker retrieves payouts for a specific worker
func (r *payoutRepository) GetPayoutsByWorker(ctx context.Context, workerID int64) ([]*Payout, error) {
	query := `SELECT id, worker_id, amount, tx_id, status, created_at 
			  FROM payouts WHERE worker_id = ?`
	
	rows, err := r.manager.conn.QueryContext(ctx, query, workerID)
	if err != nil {
		return nil, fmt.Errorf("failed to get payouts by worker: %w", err)
	}
	defer rows.Close()
	
	var payouts []*Payout
	for rows.Next() {
		payout := &Payout{}
		
		var txID sql.NullString
		
		err := rows.Scan(
			&payout.ID,
			&payout.WorkerID,
			&payout.Amount,
			&txID,
			&payout.Status,
			&payout.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan payout: %w", err)
		}
		
		// Handle nullable fields
		if txID.Valid {
			payout.TxID = &txID.String
		}
		
		payouts = append(payouts, payout)
	}
	
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating payouts: %w", err)
	}
	
	return payouts, nil
}

// GetPayoutsByStatus retrieves payouts with a specific status
func (r *payoutRepository) GetPayoutsByStatus(ctx context.Context, status string) ([]*Payout, error) {
	query := `SELECT id, worker_id, amount, tx_id, status, created_at 
			  FROM payouts WHERE status = ?`
	
	rows, err := r.manager.conn.QueryContext(ctx, query, status)
	if err != nil {
		return nil, fmt.Errorf("failed to get payouts by status: %w", err)
	}
	defer rows.Close()
	
	var payouts []*Payout
	for rows.Next() {
		payout := &Payout{}
		
		var txID sql.NullString
		
		err := rows.Scan(
			&payout.ID,
			&payout.WorkerID,
			&payout.Amount,
			&txID,
			&payout.Status,
			&payout.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan payout: %w", err)
		}
		
		// Handle nullable fields
		if txID.Valid {
			payout.TxID = &txID.String
		}
		
		payouts = append(payouts, payout)
	}
	
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating payouts: %w", err)
	}
	
	return payouts, nil
}

// UpdatePayoutStatus updates a payout's status with audit logging
func (r *payoutRepository) UpdatePayoutStatus(ctx context.Context, id int64, status string) error {
	// Get current status for audit log
	current, err := r.GetPayoutByID(ctx, id)
	if err != nil {
		return fmt.Errorf("failed to get current payout for audit: %w", err)
	}
	
	query := `UPDATE payouts SET status = ? WHERE id = ?`
	_, err = r.manager.conn.ExecContext(ctx, query, status, id)
	if err != nil {
		return fmt.Errorf("failed to update payout status: %w", err)
	}
	
	// Create audit log
	auditQuery := `INSERT INTO payout_audit (payout_id, action, old_value, new_value, timestamp) 
					 VALUES (?, ?, ?, ?, ?)`
	_, err = r.manager.conn.ExecContext(ctx, auditQuery, id, "status_update", current.Status, status, time.Now())
	if err != nil {
		return fmt.Errorf("failed to create audit log: %w", err)
	}
	
	return nil
}

// UpdatePayoutTxID updates a payout's transaction ID with audit logging
func (r *payoutRepository) UpdatePayoutTxID(ctx context.Context, id int64, txID string) error {
	// Get current tx_id for audit log
	current, err := r.GetPayoutByID(ctx, id)
	if err != nil {
		return fmt.Errorf("failed to get current payout for audit: %w", err)
	}
	
	query := `UPDATE payouts SET tx_id = ? WHERE id = ?`
	_, err = r.manager.conn.ExecContext(ctx, query, txID, id)
	if err != nil {
		return fmt.Errorf("failed to update payout tx_id: %w", err)
	}
	
	// Create audit log
	oldTxID := ""
	if current.TxID != nil {
		oldTxID = *current.TxID
	}
	
	auditQuery := `INSERT INTO payout_audit (payout_id, action, old_value, new_value, timestamp) 
					 VALUES (?, ?, ?, ?, ?)`
	_, err = r.manager.conn.ExecContext(ctx, auditQuery, id, "tx_id_update", oldTxID, txID, time.Now())
	if err != nil {
		return fmt.Errorf("failed to create audit log: %w", err)
	}
	
	return nil
}
