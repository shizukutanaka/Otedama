package database

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/shizukutanaka/Otedama/internal/config"
	_ "github.com/lib/pq"
	_ "github.com/mattn/go-sqlite3"
	"go.uber.org/zap"
)

// DB represents the database connection
type DB struct {
	logger *zap.Logger
	db     *sql.DB
	driver string
	
	// Connection pool settings
	maxConns     int
	maxIdleConns int
	connLifetime time.Duration
	
	// Query optimization
	queryCache   map[string]*sql.Stmt
	cacheMu      sync.RWMutex
	
	// Transaction management
	txManager    *TransactionManager
	
	// Repositories
	blocks       *BlockRepository
	shares       *ShareRepository
	workers      *WorkerRepository
	payouts      *PayoutRepository
	statistics   *StatisticsRepository
	
	// Metrics
	metrics      *DBMetrics
}

// DBMetrics tracks database performance metrics
type DBMetrics struct {
	queries      uint64
	transactions uint64
	errors       uint64
	avgQueryTime time.Duration
	mu           sync.RWMutex
}

// TransactionManager manages database transactions
type TransactionManager struct {
	db           *sql.DB
	logger       *zap.Logger
	activeTx     map[string]*sql.Tx
	mu           sync.RWMutex
}

// Block represents a mined block
type Block struct {
	ID           int64     `db:"id"`
	Height       int64     `db:"height"`
	Hash         string    `db:"hash"`
	PrevHash     string    `db:"prev_hash"`
	Difficulty   float64   `db:"difficulty"`
	Nonce        uint64    `db:"nonce"`
	Reward       float64   `db:"reward"`
	MinedBy      string    `db:"mined_by"`
	MinedAt      time.Time `db:"mined_at"`
	Confirmed    bool      `db:"confirmed"`
	ConfirmedAt  *time.Time `db:"confirmed_at"`
	Currency     string    `db:"currency"`
}

// Share represents a mining share
type Share struct {
	ID           int64     `db:"id"`
	WorkerID     string    `db:"worker_id"`
	JobID        string    `db:"job_id"`
	Difficulty   float64   `db:"difficulty"`
	ShareDiff    float64   `db:"share_diff"`
	Valid        bool      `db:"valid"`
	Hash         string    `db:"hash"`
	SubmittedAt  time.Time `db:"submitted_at"`
	ProcessedAt  *time.Time `db:"processed_at"`
}

// Worker represents a mining worker
type Worker struct {
	ID           string    `db:"id"`
	Name         string    `db:"name"`
	WalletAddr   string    `db:"wallet_address"`
	HashRate     float64   `db:"hashrate"`
	SharesValid  int64     `db:"shares_valid"`
	SharesStale  int64     `db:"shares_stale"`
	SharesInvalid int64    `db:"shares_invalid"`
	LastSeen     time.Time `db:"last_seen"`
	CreatedAt    time.Time `db:"created_at"`
	Active       bool      `db:"active"`
}

// Payout represents a payout to a worker
type Payout struct {
	ID           int64     `db:"id"`
	WorkerID     string    `db:"worker_id"`
	Amount       float64   `db:"amount"`
	Currency     string    `db:"currency"`
	TxHash       string    `db:"tx_hash"`
	Status       string    `db:"status"`
	ProcessedAt  *time.Time `db:"processed_at"`
	CreatedAt    time.Time `db:"created_at"`
}

// Statistics represents pool statistics
type Statistics struct {
	ID           int64     `db:"id"`
	Timestamp    time.Time `db:"timestamp"`
	HashRate     float64   `db:"hashrate"`
	Workers      int       `db:"workers"`
	Difficulty   float64   `db:"difficulty"`
	SharesValid  int64     `db:"shares_valid"`
	SharesStale  int64     `db:"shares_stale"`
	SharesInvalid int64    `db:"shares_invalid"`
	BlocksFound  int64     `db:"blocks_found"`
	TotalPayout  float64   `db:"total_payout"`
}

// New creates a new database connection
func New(config config.DatabaseConfig) (*DB, error) {
	var db *sql.DB
	var driver string
	var err error
	
	switch config.Type {
	case "postgres", "postgresql":
		driver = "postgres"
		db, err = sql.Open("postgres", config.DSN)
	case "sqlite", "sqlite3":
		driver = "sqlite3"
		db, err = sql.Open("sqlite3", config.DSN)
	default:
		return nil, fmt.Errorf("unsupported database type: %s", config.Type)
	}
	
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}
	
	// Configure connection pool
	db.SetMaxOpenConns(config.MaxConnections)
	db.SetMaxIdleConns(config.MaxIdleConns)
	db.SetConnMaxLifetime(config.ConnMaxLifetime)
	
	// Test connection
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}
	
	logger := zap.L().Named("database")
	
	d := &DB{
		logger:       logger,
		db:           db,
		driver:       driver,
		maxConns:     config.MaxConnections,
		maxIdleConns: config.MaxIdleConns,
		connLifetime: config.ConnMaxLifetime,
		queryCache:   make(map[string]*sql.Stmt),
		metrics:      &DBMetrics{},
	}
	
	// Initialize transaction manager
	d.txManager = &TransactionManager{
		db:       db,
		logger:   logger,
		activeTx: make(map[string]*sql.Tx),
	}
	
	// Initialize repositories
	d.initRepositories()
	
	return d, nil
}

// initRepositories initializes all repositories
func (d *DB) initRepositories() {
	d.blocks = &BlockRepository{db: d}
	d.shares = &ShareRepository{db: d}
	d.workers = &WorkerRepository{db: d}
	d.payouts = &PayoutRepository{db: d}
	d.statistics = &StatisticsRepository{db: d}
}

// Migrate runs database migrations
func (d *DB) Migrate() error {
	// Create tables if not exists
	migrations := []string{
		// Blocks table
		`CREATE TABLE IF NOT EXISTS blocks (
			id BIGSERIAL PRIMARY KEY,
			height BIGINT NOT NULL UNIQUE,
			hash VARCHAR(255) NOT NULL UNIQUE,
			prev_hash VARCHAR(255) NOT NULL,
			difficulty DOUBLE PRECISION NOT NULL,
			nonce BIGINT NOT NULL,
			reward DOUBLE PRECISION NOT NULL,
			mined_by VARCHAR(255) NOT NULL,
			mined_at TIMESTAMP NOT NULL,
			confirmed BOOLEAN DEFAULT FALSE,
			confirmed_at TIMESTAMP,
			currency VARCHAR(10) NOT NULL DEFAULT 'BTC',
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)`,
		
		// Shares table
		`CREATE TABLE IF NOT EXISTS shares (
			id BIGSERIAL PRIMARY KEY,
			worker_id VARCHAR(255) NOT NULL,
			job_id VARCHAR(255) NOT NULL,
			difficulty DOUBLE PRECISION NOT NULL,
			share_diff DOUBLE PRECISION NOT NULL,
			valid BOOLEAN NOT NULL,
			hash VARCHAR(255),
			submitted_at TIMESTAMP NOT NULL,
			processed_at TIMESTAMP,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			INDEX idx_worker_time (worker_id, submitted_at),
			INDEX idx_valid (valid)
		)`,
		
		// Workers table
		`CREATE TABLE IF NOT EXISTS workers (
			id VARCHAR(255) PRIMARY KEY,
			name VARCHAR(255) NOT NULL,
			wallet_address VARCHAR(255) NOT NULL,
			hashrate DOUBLE PRECISION DEFAULT 0,
			shares_valid BIGINT DEFAULT 0,
			shares_stale BIGINT DEFAULT 0,
			shares_invalid BIGINT DEFAULT 0,
			last_seen TIMESTAMP,
			active BOOLEAN DEFAULT TRUE,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			INDEX idx_wallet (wallet_address),
			INDEX idx_active (active)
		)`,
		
		// Payouts table
		`CREATE TABLE IF NOT EXISTS payouts (
			id BIGSERIAL PRIMARY KEY,
			worker_id VARCHAR(255) NOT NULL,
			amount DOUBLE PRECISION NOT NULL,
			currency VARCHAR(10) NOT NULL DEFAULT 'BTC',
			tx_hash VARCHAR(255),
			status VARCHAR(50) NOT NULL,
			processed_at TIMESTAMP,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			INDEX idx_worker (worker_id),
			INDEX idx_status (status)
		)`,
		
		// Statistics table
		`CREATE TABLE IF NOT EXISTS statistics (
			id BIGSERIAL PRIMARY KEY,
			timestamp TIMESTAMP NOT NULL,
			hashrate DOUBLE PRECISION NOT NULL,
			workers INT NOT NULL,
			difficulty DOUBLE PRECISION NOT NULL,
			shares_valid BIGINT DEFAULT 0,
			shares_stale BIGINT DEFAULT 0,
			shares_invalid BIGINT DEFAULT 0,
			blocks_found BIGINT DEFAULT 0,
			total_payout DOUBLE PRECISION DEFAULT 0,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			INDEX idx_timestamp (timestamp)
		)`,
	}
	
	// Adjust SQL syntax for SQLite
	if d.driver == "sqlite3" {
		for i, migration := range migrations {
			// SQLite adjustments
			migration = replacePostgreSQLWithSQLite(migration)
			migrations[i] = migration
		}
	}
	
	// Execute migrations
	for _, migration := range migrations {
		if _, err := d.db.Exec(migration); err != nil {
			return fmt.Errorf("migration failed: %w", err)
		}
	}
	
	d.logger.Info("Database migrations completed")
	return nil
}

// Close closes the database connection
func (d *DB) Close() error {
	// Close all prepared statements
	d.cacheMu.Lock()
	for _, stmt := range d.queryCache {
		stmt.Close()
	}
	d.cacheMu.Unlock()
	
	return d.db.Close()
}

// BeginTx starts a new transaction
func (d *DB) BeginTx(ctx context.Context, opts *sql.TxOptions) (*sql.Tx, error) {
	tx, err := d.db.BeginTx(ctx, opts)
	if err != nil {
		return nil, err
	}
	
	d.metrics.transactions++
	return tx, nil
}

// Execute executes a query without returning results
func (d *DB) Execute(query string, args ...interface{}) error {
	start := time.Now()
	defer d.recordMetrics(start)
	
	_, err := d.db.Exec(query, args...)
	if err != nil {
		d.metrics.errors++
		return err
	}
	
	return nil
}

// Query executes a query and returns results
func (d *DB) Query(query string, args ...interface{}) (*sql.Rows, error) {
	start := time.Now()
	defer d.recordMetrics(start)
	
	rows, err := d.db.Query(query, args...)
	if err != nil {
		d.metrics.errors++
		return nil, err
	}
	
	return rows, nil
}

// QueryRow executes a query and returns a single row
func (d *DB) QueryRow(query string, args ...interface{}) *sql.Row {
	start := time.Now()
	defer d.recordMetrics(start)
	
	return d.db.QueryRow(query, args...)
}

// Prepare prepares a statement for repeated use
func (d *DB) Prepare(query string) (*sql.Stmt, error) {
	// Check cache first
	d.cacheMu.RLock()
	if stmt, exists := d.queryCache[query]; exists {
		d.cacheMu.RUnlock()
		return stmt, nil
	}
	d.cacheMu.RUnlock()
	
	// Prepare new statement
	stmt, err := d.db.Prepare(query)
	if err != nil {
		return nil, err
	}
	
	// Cache statement
	d.cacheMu.Lock()
	d.queryCache[query] = stmt
	d.cacheMu.Unlock()
	
	return stmt, nil
}

// recordMetrics records query metrics
func (d *DB) recordMetrics(start time.Time) {
	duration := time.Since(start)
	
	d.metrics.mu.Lock()
	d.metrics.queries++
	d.metrics.avgQueryTime = (d.metrics.avgQueryTime + duration) / 2
	d.metrics.mu.Unlock()
}

// GetMetrics returns database metrics
func (d *DB) GetMetrics() map[string]interface{} {
	d.metrics.mu.RLock()
	defer d.metrics.mu.RUnlock()
	
	stats := d.db.Stats()
	
	return map[string]interface{}{
		"queries":         d.metrics.queries,
		"transactions":    d.metrics.transactions,
		"errors":          d.metrics.errors,
		"avg_query_time":  d.metrics.avgQueryTime,
		"open_connections": stats.OpenConnections,
		"idle_connections": stats.Idle,
		"in_use":          stats.InUse,
	}
}

// Repository implementations

// BlockRepository manages block data
type BlockRepository struct {
	db *DB
}

// Create creates a new block record
func (r *BlockRepository) Create(block *Block) error {
	query := `
		INSERT INTO blocks (height, hash, prev_hash, difficulty, nonce, reward, mined_by, mined_at, currency)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id`
	
	err := r.db.QueryRow(
		query,
		block.Height,
		block.Hash,
		block.PrevHash,
		block.Difficulty,
		block.Nonce,
		block.Reward,
		block.MinedBy,
		block.MinedAt,
		block.Currency,
	).Scan(&block.ID)
	
	return err
}

// GetByHeight gets a block by height
func (r *BlockRepository) GetByHeight(height int64) (*Block, error) {
	block := &Block{}
	query := `SELECT * FROM blocks WHERE height = $1`
	
	row := r.db.QueryRow(query, height)
	err := scanBlock(row, block)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	
	return block, err
}

// GetLatest gets the latest block
func (r *BlockRepository) GetLatest() (*Block, error) {
	block := &Block{}
	query := `SELECT * FROM blocks ORDER BY height DESC LIMIT 1`
	
	row := r.db.QueryRow(query)
	err := scanBlock(row, block)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	
	return block, err
}

// ShareRepository manages share data
type ShareRepository struct {
	db *DB
}

// Create creates a new share record
func (r *ShareRepository) Create(share *Share) error {
	query := `
		INSERT INTO shares (worker_id, job_id, difficulty, share_diff, valid, hash, submitted_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id`
	
	err := r.db.QueryRow(
		query,
		share.WorkerID,
		share.JobID,
		share.Difficulty,
		share.ShareDiff,
		share.Valid,
		share.Hash,
		share.SubmittedAt,
	).Scan(&share.ID)
	
	return err
}

// GetWorkerShares gets shares for a worker
func (r *ShareRepository) GetWorkerShares(workerID string, since time.Time) ([]*Share, error) {
	query := `SELECT * FROM shares WHERE worker_id = $1 AND submitted_at >= $2 ORDER BY submitted_at DESC`
	
	rows, err := r.db.Query(query, workerID, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	var shares []*Share
	for rows.Next() {
		share := &Share{}
		if err := scanShare(rows, share); err != nil {
			return nil, err
		}
		shares = append(shares, share)
	}
	
	return shares, nil
}

// WorkerRepository manages worker data
type WorkerRepository struct {
	db *DB
}

// Create creates a new worker record
func (r *WorkerRepository) Create(worker *Worker) error {
	query := `
		INSERT INTO workers (id, name, wallet_address, created_at)
		VALUES ($1, $2, $3, $4)`
	
	return r.db.Execute(query, worker.ID, worker.Name, worker.WalletAddr, time.Now())
}

// GetByID gets a worker by ID
func (r *WorkerRepository) GetByID(id string) (*Worker, error) {
	worker := &Worker{}
	query := `SELECT * FROM workers WHERE id = $1`
	
	row := r.db.QueryRow(query, id)
	err := scanWorker(row, worker)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	
	return worker, err
}

// UpdateStats updates worker statistics
func (r *WorkerRepository) UpdateStats(id string, hashrate float64, validShares, staleShares, invalidShares int64) error {
	query := `
		UPDATE workers 
		SET hashrate = $2, 
		    shares_valid = shares_valid + $3,
		    shares_stale = shares_stale + $4,
		    shares_invalid = shares_invalid + $5,
		    last_seen = $6
		WHERE id = $1`
	
	return r.db.Execute(query, id, hashrate, validShares, staleShares, invalidShares, time.Now())
}

// PayoutRepository manages payout data
type PayoutRepository struct {
	db *DB
}

// Create creates a new payout record
func (r *PayoutRepository) Create(payout *Payout) error {
	query := `
		INSERT INTO payouts (worker_id, amount, currency, status, created_at)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id`
	
	err := r.db.QueryRow(
		query,
		payout.WorkerID,
		payout.Amount,
		payout.Currency,
		payout.Status,
		time.Now(),
	).Scan(&payout.ID)
	
	return err
}

// GetPending gets pending payouts
func (r *PayoutRepository) GetPending() ([]*Payout, error) {
	query := `SELECT * FROM payouts WHERE status = 'pending' ORDER BY created_at`
	
	rows, err := r.db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	var payouts []*Payout
	for rows.Next() {
		payout := &Payout{}
		if err := scanPayout(rows, payout); err != nil {
			return nil, err
		}
		payouts = append(payouts, payout)
	}
	
	return payouts, nil
}

// UpdateStatus updates payout status
func (r *PayoutRepository) UpdateStatus(id int64, status, txHash string) error {
	query := `UPDATE payouts SET status = $2, tx_hash = $3, processed_at = $4 WHERE id = $1`
	return r.db.Execute(query, id, status, txHash, time.Now())
}

// StatisticsRepository manages statistics data
type StatisticsRepository struct {
	db *DB
}

// Create creates a new statistics record
func (r *StatisticsRepository) Create(stats *Statistics) error {
	query := `
		INSERT INTO statistics (
			timestamp, hashrate, workers, difficulty, 
			shares_valid, shares_stale, shares_invalid, 
			blocks_found, total_payout
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id`
	
	err := r.db.QueryRow(
		query,
		stats.Timestamp,
		stats.HashRate,
		stats.Workers,
		stats.Difficulty,
		stats.SharesValid,
		stats.SharesStale,
		stats.SharesInvalid,
		stats.BlocksFound,
		stats.TotalPayout,
	).Scan(&stats.ID)
	
	return err
}

// GetRecent gets recent statistics
func (r *StatisticsRepository) GetRecent(limit int) ([]*Statistics, error) {
	query := `SELECT * FROM statistics ORDER BY timestamp DESC LIMIT $1`
	
	rows, err := r.db.Query(query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	var stats []*Statistics
	for rows.Next() {
		stat := &Statistics{}
		if err := scanStatistics(rows, stat); err != nil {
			return nil, err
		}
		stats = append(stats, stat)
	}
	
	return stats, nil
}

// Scanner functions

func scanBlock(scanner interface{ Scan(...interface{}) error }, block *Block) error {
	return scanner.Scan(
		&block.ID,
		&block.Height,
		&block.Hash,
		&block.PrevHash,
		&block.Difficulty,
		&block.Nonce,
		&block.Reward,
		&block.MinedBy,
		&block.MinedAt,
		&block.Confirmed,
		&block.ConfirmedAt,
		&block.Currency,
	)
}

func scanShare(scanner interface{ Scan(...interface{}) error }, share *Share) error {
	return scanner.Scan(
		&share.ID,
		&share.WorkerID,
		&share.JobID,
		&share.Difficulty,
		&share.ShareDiff,
		&share.Valid,
		&share.Hash,
		&share.SubmittedAt,
		&share.ProcessedAt,
	)
}

func scanWorker(scanner interface{ Scan(...interface{}) error }, worker *Worker) error {
	return scanner.Scan(
		&worker.ID,
		&worker.Name,
		&worker.WalletAddr,
		&worker.HashRate,
		&worker.SharesValid,
		&worker.SharesStale,
		&worker.SharesInvalid,
		&worker.LastSeen,
		&worker.Active,
		&worker.CreatedAt,
	)
}

func scanPayout(scanner interface{ Scan(...interface{}) error }, payout *Payout) error {
	return scanner.Scan(
		&payout.ID,
		&payout.WorkerID,
		&payout.Amount,
		&payout.Currency,
		&payout.TxHash,
		&payout.Status,
		&payout.ProcessedAt,
		&payout.CreatedAt,
	)
}

func scanStatistics(scanner interface{ Scan(...interface{}) error }, stats *Statistics) error {
	return scanner.Scan(
		&stats.ID,
		&stats.Timestamp,
		&stats.HashRate,
		&stats.Workers,
		&stats.Difficulty,
		&stats.SharesValid,
		&stats.SharesStale,
		&stats.SharesInvalid,
		&stats.BlocksFound,
		&stats.TotalPayout,
	)
}

// Helper function to convert PostgreSQL syntax to SQLite
func replacePostgreSQLWithSQLite(query string) string {
	// Replace BIGSERIAL with INTEGER for SQLite
	query = strings.ReplaceAll(query, "BIGSERIAL", "INTEGER")
	// Replace DOUBLE PRECISION with REAL
	query = strings.ReplaceAll(query, "DOUBLE PRECISION", "REAL")
	// Remove INDEX statements (SQLite creates them differently)
	// This is simplified; a more robust solution would parse SQL properly
	lines := strings.Split(query, "\n")
	var result []string
	for _, line := range lines {
		if !strings.Contains(strings.ToUpper(line), "INDEX") {
			result = append(result, line)
		}
	}
	return strings.Join(result, "\n")
}