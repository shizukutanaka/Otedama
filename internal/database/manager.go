package database

import (
	"database/sql"
	"fmt"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

// Manager handles database connections and operations
type Manager struct {
	config *Config
	conn   *sql.DB
}

// NewManager creates a new database manager with the given configuration
func NewManager(config *Config) (*Manager, error) {
	manager := &Manager{
		config: config,
	}

	// Open database connection
	conn, err := sql.Open(config.Type, config.DSN)
	if err != nil {
		return nil, fmt.Errorf("failed to open database connection: %w", err)
	}

	// Configure connection pool
	conn.SetMaxOpenConns(config.MaxConnections)
	conn.SetMaxIdleConns(config.MaxIdleConns)
	conn.SetConnMaxLifetime(config.ConnMaxLifetime)

	// Test connection
	if err := conn.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	manager.conn = conn
	return manager, nil
}

// GetConnection returns the database connection
func (m *Manager) GetConnection() *sql.DB {
	return m.conn
}

// Close closes the database connection
func (m *Manager) Close() error {
	if m.conn != nil {
		return m.conn.Close()
	}
	return nil
}

// InitializeSchema creates the necessary database tables
func (m *Manager) InitializeSchema() error {
	queries := []string{
		`CREATE TABLE IF NOT EXISTS workers (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL UNIQUE,
			wallet_address TEXT NOT NULL,
			hashrate REAL DEFAULT 0,
			last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		);`,

		`CREATE TABLE IF NOT EXISTS shares (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			worker_id INTEGER NOT NULL,
			job_id TEXT NOT NULL,
			nonce TEXT NOT NULL,
			difficulty REAL NOT NULL,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (worker_id) REFERENCES workers (id)
		);`,

		`CREATE TABLE IF NOT EXISTS blocks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			height INTEGER NOT NULL,
			hash TEXT NOT NULL UNIQUE,
			worker_id INTEGER,
			reward REAL,
			status TEXT DEFAULT 'pending',
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (worker_id) REFERENCES workers (id)
		);`,

		`CREATE TABLE IF NOT EXISTS payouts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			worker_id INTEGER NOT NULL,
			amount REAL NOT NULL,
			tx_id TEXT,
			status TEXT DEFAULT 'pending',
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (worker_id) REFERENCES workers (id)
		);`,
	}

	for _, query := range queries {
		_, err := m.conn.Exec(query)
		if err != nil {
			return fmt.Errorf("failed to execute query: %w\nQuery: %s", err, query)
		}
	}

	return nil
}

// HealthCheck verifies the database connection is working properly
func (m *Manager) HealthCheck() error {
	// Test basic connectivity
	if err := m.conn.Ping(); err != nil {
		return fmt.Errorf("database ping failed: %w", err)
	}

	// Test simple query
	var version string
	err := m.conn.QueryRow("SELECT sqlite_version()").Scan(&version)
	if err != nil {
		return fmt.Errorf("database query failed: %w", err)
	}

	return nil
}
