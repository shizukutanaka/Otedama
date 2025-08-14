package database

import (
	"context"
	"time"
)

// Worker represents a mining worker in the database
type Worker struct {
	ID           int64     `db:"id"`
	Name         string    `db:"name"`
	WalletAddress string   `db:"wallet_address"`
	Hashrate     float64   `db:"hashrate"`
	LastSeen     time.Time `db:"last_seen"`
	CreatedAt    time.Time `db:"created_at"`
}

// Share represents a submitted share from a worker
type Share struct {
	ID        int64     `db:"id"`
	WorkerID  int64     `db:"worker_id"`
	JobID     string    `db:"job_id"`
	Nonce     string    `db:"nonce"`
	Difficulty float64   `db:"difficulty"`
	CreatedAt time.Time `db:"created_at"`
}

// Block represents a mined block
type Block struct {
	ID       int64     `db:"id"`
	Height   int64     `db:"height"`
	Hash     string    `db:"hash"`
	WorkerID *int64    `db:"worker_id"`
	Reward   *float64  `db:"reward"`
	Status   string    `db:"status"`
	CreatedAt time.Time `db:"created_at"`
}

// Payout represents a payout to a worker
type Payout struct {
	ID        int64     `db:"id"`
	WorkerID  int64     `db:"worker_id"`
	Amount    float64   `db:"amount"`
	TxID      *string   `db:"tx_id"`
	Status    string    `db:"status"`
	CreatedAt time.Time `db:"created_at"`
}

// WorkerRepository defines the interface for worker database operations
type WorkerRepository interface {
	// CreateWorker creates a new worker in the database
	CreateWorker(ctx context.Context, worker *Worker) error
	
	// GetWorkerByName retrieves a worker by their name
	GetWorkerByName(ctx context.Context, name string) (*Worker, error)
	
	// GetWorkerByID retrieves a worker by their ID
	GetWorkerByID(ctx context.Context, id int64) (*Worker, error)
	
	// UpdateWorkerHashrate updates a worker's hashrate
	UpdateWorkerHashrate(ctx context.Context, id int64, hashrate float64) error
	
	// UpdateWorkerLastSeen updates a worker's last seen timestamp
	UpdateWorkerLastSeen(ctx context.Context, id int64, lastSeen time.Time) error
	
	// UpdateWorkerWallet updates a worker's wallet address
	UpdateWorkerWallet(ctx context.Context, id int64, walletAddress string) error
	
	// GetAllWorkers retrieves all workers
	GetAllWorkers(ctx context.Context) ([]*Worker, error)
	
	// DeleteWorker removes a worker from the database
	DeleteWorker(ctx context.Context, id int64) error
}

// ShareRepository defines the interface for share database operations
type ShareRepository interface {
	// CreateShare creates a new share in the database
	CreateShare(ctx context.Context, share *Share) error
	
	// GetSharesByWorker retrieves shares for a specific worker
	GetSharesByWorker(ctx context.Context, workerID int64) ([]*Share, error)
	
	// GetSharesByTimeRange retrieves shares within a time range
	GetSharesByTimeRange(ctx context.Context, start, end time.Time) ([]*Share, error)
}

// BlockRepository defines the interface for block database operations
type BlockRepository interface {
	// CreateBlock creates a new block in the database
	CreateBlock(ctx context.Context, block *Block) error
	
	// GetBlockByHash retrieves a block by its hash
	GetBlockByHash(ctx context.Context, hash string) (*Block, error)
	
	// GetBlockByID retrieves a block by its ID
	GetBlockByID(ctx context.Context, id int64) (*Block, error)
	
	// UpdateBlockStatus updates a block's status
	UpdateBlockStatus(ctx context.Context, id int64, status string) error
	
	// UpdateBlockReward updates a block's reward
	UpdateBlockReward(ctx context.Context, id int64, reward float64) error
}

// PayoutRepository defines the interface for payout database operations
type PayoutRepository interface {
	// CreatePayout creates a new payout in the database
	CreatePayout(ctx context.Context, payout *Payout) error
	
	// GetPayoutByID retrieves a payout by its ID
	GetPayoutByID(ctx context.Context, id int64) (*Payout, error)
	
	// GetPayoutsByWorker retrieves payouts for a specific worker
	GetPayoutsByWorker(ctx context.Context, workerID int64) ([]*Payout, error)
	
	// GetPayoutsByStatus retrieves payouts with a specific status
	GetPayoutsByStatus(ctx context.Context, status string) ([]*Payout, error)
	
	// UpdatePayoutStatus updates a payout's status
	UpdatePayoutStatus(ctx context.Context, id int64, status string) error
	
	// UpdatePayoutTxID updates a payout's transaction ID
	UpdatePayoutTxID(ctx context.Context, id int64, txID string) error
}
