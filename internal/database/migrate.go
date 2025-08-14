package database

import (
	"fmt"
	"log"
)

// Migration represents a database migration
type Migration struct {
	ID      int
	Name    string
	UpSQL   string
	DownSQL string
}

// MigrationManager handles database migrations
type MigrationManager struct {
	manager *Manager
}

// NewMigrationManager creates a new migration manager
func NewMigrationManager(manager *Manager) *MigrationManager {
	return &MigrationManager{
		manager: manager,
	}
}

// Migrate applies all pending migrations
func (m *MigrationManager) Migrate() error {
	// Create migrations table if it doesn't exist
	createMigrationsTable := `CREATE TABLE IF NOT EXISTS migrations (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	);`

	_, err := m.manager.conn.Exec(createMigrationsTable)
	if err != nil {
		return fmt.Errorf("failed to create migrations table: %w", err)
	}

	// Get applied migrations
	appliedMigrations, err := m.getAppliedMigrations()
	if err != nil {
		return fmt.Errorf("failed to get applied migrations: %w", err)
	}

	// Define migrations
	migrations := []Migration{
		{
			ID:   1,
			Name: "create_workers_table",
			UpSQL: `CREATE TABLE IF NOT EXISTS workers (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL UNIQUE,
				wallet_address TEXT NOT NULL,
				hashrate REAL DEFAULT 0,
				last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			);`,
		},
		{
			ID:   2,
			Name: "create_shares_table",
			UpSQL: `CREATE TABLE IF NOT EXISTS shares (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				worker_id INTEGER NOT NULL,
				job_id TEXT NOT NULL,
				nonce TEXT NOT NULL,
				difficulty REAL NOT NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				FOREIGN KEY (worker_id) REFERENCES workers (id)
			);`,
		},
		{
			ID:   3,
			Name: "create_blocks_table",
			UpSQL: `CREATE TABLE IF NOT EXISTS blocks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				height INTEGER NOT NULL,
				hash TEXT NOT NULL UNIQUE,
				worker_id INTEGER,
				reward REAL,
				status TEXT DEFAULT 'pending',
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				FOREIGN KEY (worker_id) REFERENCES workers (id)
			);`,
		},
		{
			ID:   4,
			Name: "create_payouts_table",
			UpSQL: `CREATE TABLE IF NOT EXISTS payouts (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				worker_id INTEGER NOT NULL,
				amount REAL NOT NULL,
				tx_id TEXT,
				status TEXT DEFAULT 'pending',
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				FOREIGN KEY (worker_id) REFERENCES workers (id)
			);`,
		},
	}

	// Apply pending migrations
	for _, migration := range migrations {
		if !appliedMigrations[migration.Name] {
			log.Printf("Applying migration: %s", migration.Name)
			
			// Execute migration
			_, err := m.manager.conn.Exec(migration.UpSQL)
			if err != nil {
				return fmt.Errorf("failed to apply migration %s: %w", migration.Name, err)
			}

			// Record migration as applied
			_, err = m.manager.conn.Exec(
				`INSERT INTO migrations (name) VALUES (?)`,
				migration.Name,
			)
			if err != nil {
				return fmt.Errorf("failed to record migration %s: %w", migration.Name, err)
			}

			log.Printf("Migration applied: %s", migration.Name)
		}
	}

	return nil
}

// getAppliedMigrations returns a map of applied migration names
func (m *MigrationManager) getAppliedMigrations() (map[string]bool, error) {
	rows, err := m.manager.conn.Query(`SELECT name FROM migrations`)
	if err != nil {
		return nil, fmt.Errorf("failed to query migrations: %w", err)
	}
	defer rows.Close()

	applied := make(map[string]bool)
	for rows.Next() {
		var name string
		err := rows.Scan(&name)
		if err != nil {
			return nil, fmt.Errorf("failed to scan migration name: %w", err)
		}
		applied[name] = true
	}

	return applied, nil
}

// Rollback rolls back the last applied migration
func (m *MigrationManager) Rollback() error {
	// This is a simplified rollback implementation
	// In a production system, you would want more sophisticated rollback handling
	return fmt.Errorf("rollback not implemented")
}
