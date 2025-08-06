package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "github.com/lib/pq"      // PostgreSQL driver
	_ "github.com/go-sql-driver/mysql" // MySQL driver
	_ "github.com/mattn/go-sqlite3"    // SQLite driver
	"go.uber.org/zap"
)

// DB represents the database connection
type DB struct {
	logger      *zap.Logger
	db          *sql.DB
	driver      string
	isConnected bool
}

// Config represents database configuration
type Config struct {
	Driver             string        `yaml:"driver" json:"driver"`
	DSN                string        `yaml:"dsn" json:"dsn"`
	MaxOpenConns       int           `yaml:"max_open_conns" json:"max_open_conns"`
	MaxIdleConns       int           `yaml:"max_idle_conns" json:"max_idle_conns"`
	ConnMaxLifetime    time.Duration `yaml:"conn_max_lifetime" json:"conn_max_lifetime"`
	ConnMaxIdleTime    time.Duration `yaml:"conn_max_idle_time" json:"conn_max_idle_time"`
	SlowQueryThreshold time.Duration `yaml:"slow_query_threshold" json:"slow_query_threshold"`
}

// New creates a new database connection
func New(logger *zap.Logger, config Config) (*DB, error) {
	// Validate driver
	switch config.Driver {
	case "postgres", "mysql", "sqlite", "sqlite3":
		// Valid drivers
	default:
		return nil, fmt.Errorf("unsupported database driver: %s", config.Driver)
	}

	// Normalize SQLite driver name
	driver := config.Driver
	if driver == "sqlite" {
		driver = "sqlite3"
	}

	// Open connection
	db, err := sql.Open(driver, config.DSN)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// Configure connection pool
	if config.MaxOpenConns > 0 {
		db.SetMaxOpenConns(config.MaxOpenConns)
	} else {
		db.SetMaxOpenConns(25)
	}

	if config.MaxIdleConns > 0 {
		db.SetMaxIdleConns(config.MaxIdleConns)
	} else {
		db.SetMaxIdleConns(5)
	}

	if config.ConnMaxLifetime > 0 {
		db.SetConnMaxLifetime(config.ConnMaxLifetime)
	} else {
		db.SetConnMaxLifetime(30 * time.Minute)
	}

	if config.ConnMaxIdleTime > 0 {
		db.SetConnMaxIdleTime(config.ConnMaxIdleTime)
	}

	// Test connection
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	d := &DB{
		logger:      logger,
		db:          db,
		driver:      driver,
		isConnected: true,
	}

	// Initialize schema
	if err := d.initializeSchema(); err != nil {
		db.Close()
		return nil, fmt.Errorf("failed to initialize schema: %w", err)
	}

	logger.Info("Database connected",
		zap.String("driver", driver),
		zap.Int("max_open_conns", config.MaxOpenConns),
	)

	return d, nil
}

// Close closes the database connection
func (d *DB) Close() error {
	if d.db != nil {
		d.isConnected = false
		return d.db.Close()
	}
	return nil
}

// IsConnected returns whether the database is connected
func (d *DB) IsConnected() bool {
	return d.isConnected
}

// Ping checks database connectivity
func (d *DB) Ping(ctx context.Context) error {
	if d.db == nil {
		return errors.New("database not initialized")
	}
	return d.db.PingContext(ctx)
}

// Begin starts a new transaction
func (d *DB) Begin(ctx context.Context) (*Transaction, error) {
	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}

	return &Transaction{
		tx:     tx,
		db:     d,
		logger: d.logger,
	}, nil
}

// Execute executes a query without returning results
func (d *DB) Execute(ctx context.Context, query string, args ...interface{}) (sql.Result, error) {
	start := time.Now()
	result, err := d.db.ExecContext(ctx, query, args...)
	duration := time.Since(start)

	if duration > 100*time.Millisecond {
		d.logger.Warn("Slow query",
			zap.String("query", query),
			zap.Duration("duration", duration),
		)
	}

	return result, err
}

// Query executes a query and returns rows
func (d *DB) Query(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
	start := time.Now()
	rows, err := d.db.QueryContext(ctx, query, args...)
	duration := time.Since(start)

	if duration > 100*time.Millisecond {
		d.logger.Warn("Slow query",
			zap.String("query", query),
			zap.Duration("duration", duration),
		)
	}

	return rows, err
}

// QueryRow executes a query and returns a single row
func (d *DB) QueryRow(ctx context.Context, query string, args ...interface{}) *sql.Row {
	return d.db.QueryRowContext(ctx, query, args...)
}

// GetStats returns database statistics
func (d *DB) GetStats() sql.DBStats {
	if d.db == nil {
		return sql.DBStats{}
	}
	return d.db.Stats()
}

// Transaction represents a database transaction
type Transaction struct {
	tx     *sql.Tx
	db     *DB
	logger *zap.Logger
}

// Commit commits the transaction
func (t *Transaction) Commit() error {
	return t.tx.Commit()
}

// Rollback rolls back the transaction
func (t *Transaction) Rollback() error {
	return t.tx.Rollback()
}

// Execute executes a query within the transaction
func (t *Transaction) Execute(ctx context.Context, query string, args ...interface{}) (sql.Result, error) {
	start := time.Now()
	result, err := t.tx.ExecContext(ctx, query, args...)
	duration := time.Since(start)

	if duration > 100*time.Millisecond {
		t.logger.Warn("Slow query in transaction",
			zap.String("query", query),
			zap.Duration("duration", duration),
		)
	}

	return result, err
}

// Query executes a query within the transaction
func (t *Transaction) Query(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
	start := time.Now()
	rows, err := t.tx.QueryContext(ctx, query, args...)
	duration := time.Since(start)

	if duration > 100*time.Millisecond {
		t.logger.Warn("Slow query in transaction",
			zap.String("query", query),
			zap.Duration("duration", duration),
		)
	}

	return rows, err
}

// QueryRow executes a query within the transaction and returns a single row
func (t *Transaction) QueryRow(ctx context.Context, query string, args ...interface{}) *sql.Row {
	return t.tx.QueryRowContext(ctx, query, args...)
}

// initializeSchema creates the database schema
func (d *DB) initializeSchema() error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Create schema based on driver
	switch d.driver {
	case "sqlite3":
		return d.initializeSQLiteSchema(ctx)
	case "postgres":
		return d.initializePostgresSchema(ctx)
	case "mysql":
		return d.initializeMySQLSchema(ctx)
	default:
		return fmt.Errorf("unsupported driver for schema initialization: %s", d.driver)
	}
}

// Helper function to check if table exists
func (d *DB) tableExists(ctx context.Context, tableName string) bool {
	var query string
	switch d.driver {
	case "sqlite3":
		query = "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
	case "postgres":
		query = "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=$1"
	case "mysql":
		query = "SELECT table_name FROM information_schema.tables WHERE table_name=?"
	default:
		return false
	}

	var name string
	err := d.QueryRow(ctx, query, tableName).Scan(&name)
	return err == nil
}