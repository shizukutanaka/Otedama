package database

import (
	"context"
	"fmt"
)

// initializeSQLiteSchema creates SQLite schema
func (d *DB) initializeSQLiteSchema(ctx context.Context) error {
	schema := []string{
		// Workers table
		`CREATE TABLE IF NOT EXISTS workers (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			worker_id TEXT UNIQUE NOT NULL,
			username TEXT NOT NULL,
			password_hash TEXT,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			last_seen_at TIMESTAMP,
			total_shares INTEGER DEFAULT 0,
			valid_shares INTEGER DEFAULT 0,
			invalid_shares INTEGER DEFAULT 0,
			total_hashrate REAL DEFAULT 0,
			status TEXT DEFAULT 'active',
			metadata TEXT
		)`,

		// Shares table
		`CREATE TABLE IF NOT EXISTS shares (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			worker_id TEXT NOT NULL,
			job_id TEXT NOT NULL,
			nonce TEXT NOT NULL,
			hash TEXT NOT NULL,
			difficulty REAL NOT NULL,
			timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			valid BOOLEAN DEFAULT true,
			block_height INTEGER,
			reward REAL DEFAULT 0,
			FOREIGN KEY (worker_id) REFERENCES workers(worker_id)
		)`,

		// Blocks table
		`CREATE TABLE IF NOT EXISTS blocks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			height INTEGER UNIQUE NOT NULL,
			hash TEXT UNIQUE NOT NULL,
			previous_hash TEXT NOT NULL,
			timestamp TIMESTAMP NOT NULL,
			difficulty REAL NOT NULL,
			reward REAL NOT NULL,
			finder_worker_id TEXT,
			status TEXT DEFAULT 'pending',
			confirmations INTEGER DEFAULT 0,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			confirmed_at TIMESTAMP,
			FOREIGN KEY (finder_worker_id) REFERENCES workers(worker_id)
		)`,

		// Payouts table
		`CREATE TABLE IF NOT EXISTS payouts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			worker_id TEXT NOT NULL,
			amount REAL NOT NULL,
			currency TEXT NOT NULL,
			address TEXT NOT NULL,
			transaction_id TEXT,
			status TEXT DEFAULT 'pending',
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			processed_at TIMESTAMP,
			error_message TEXT,
			FOREIGN KEY (worker_id) REFERENCES workers(worker_id)
		)`,

		// Jobs table
		`CREATE TABLE IF NOT EXISTS jobs (
			id TEXT PRIMARY KEY,
			algorithm TEXT NOT NULL,
			target TEXT NOT NULL,
			block_template TEXT NOT NULL,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			expires_at TIMESTAMP NOT NULL,
			difficulty REAL NOT NULL,
			height INTEGER NOT NULL
		)`,

		// Statistics table
		`CREATE TABLE IF NOT EXISTS statistics (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			metric_name TEXT NOT NULL,
			metric_value REAL NOT NULL,
			worker_id TEXT,
			metadata TEXT
		)`,

		// Audit log table
		`CREATE TABLE IF NOT EXISTS audit_logs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			event_type TEXT NOT NULL,
			user_id TEXT,
			ip_address TEXT,
			action TEXT NOT NULL,
			resource TEXT,
			result TEXT,
			details TEXT
		)`,

		// Create indexes
		`CREATE INDEX IF NOT EXISTS idx_workers_username ON workers(username)`,
		`CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status)`,
		`CREATE INDEX IF NOT EXISTS idx_shares_worker_id ON shares(worker_id)`,
		`CREATE INDEX IF NOT EXISTS idx_shares_timestamp ON shares(timestamp)`,
		`CREATE INDEX IF NOT EXISTS idx_shares_valid ON shares(valid)`,
		`CREATE INDEX IF NOT EXISTS idx_blocks_height ON blocks(height)`,
		`CREATE INDEX IF NOT EXISTS idx_blocks_status ON blocks(status)`,
		`CREATE INDEX IF NOT EXISTS idx_payouts_worker_id ON payouts(worker_id)`,
		`CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status)`,
		`CREATE INDEX IF NOT EXISTS idx_statistics_timestamp ON statistics(timestamp)`,
		`CREATE INDEX IF NOT EXISTS idx_statistics_metric ON statistics(metric_name, timestamp)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type ON audit_logs(event_type)`,
	}

	// Execute schema creation
	for _, query := range schema {
		if _, err := d.Execute(ctx, query); err != nil {
			return fmt.Errorf("failed to execute schema query: %w", err)
		}
	}

	d.logger.Info("SQLite schema initialized")
	return nil
}

// initializePostgresSchema creates PostgreSQL schema
func (d *DB) initializePostgresSchema(ctx context.Context) error {
	schema := []string{
		// Workers table
		`CREATE TABLE IF NOT EXISTS workers (
			id SERIAL PRIMARY KEY,
			worker_id VARCHAR(255) UNIQUE NOT NULL,
			username VARCHAR(255) NOT NULL,
			password_hash VARCHAR(255),
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			last_seen_at TIMESTAMP,
			total_shares BIGINT DEFAULT 0,
			valid_shares BIGINT DEFAULT 0,
			invalid_shares BIGINT DEFAULT 0,
			total_hashrate DOUBLE PRECISION DEFAULT 0,
			status VARCHAR(50) DEFAULT 'active',
			metadata JSONB
		)`,

		// Shares table
		`CREATE TABLE IF NOT EXISTS shares (
			id BIGSERIAL PRIMARY KEY,
			worker_id VARCHAR(255) NOT NULL,
			job_id VARCHAR(255) NOT NULL,
			nonce VARCHAR(255) NOT NULL,
			hash VARCHAR(255) NOT NULL,
			difficulty DOUBLE PRECISION NOT NULL,
			timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			valid BOOLEAN DEFAULT true,
			block_height INTEGER,
			reward DOUBLE PRECISION DEFAULT 0,
			FOREIGN KEY (worker_id) REFERENCES workers(worker_id)
		)`,

		// Blocks table
		`CREATE TABLE IF NOT EXISTS blocks (
			id SERIAL PRIMARY KEY,
			height INTEGER UNIQUE NOT NULL,
			hash VARCHAR(255) UNIQUE NOT NULL,
			previous_hash VARCHAR(255) NOT NULL,
			timestamp TIMESTAMP NOT NULL,
			difficulty DOUBLE PRECISION NOT NULL,
			reward DOUBLE PRECISION NOT NULL,
			finder_worker_id VARCHAR(255),
			status VARCHAR(50) DEFAULT 'pending',
			confirmations INTEGER DEFAULT 0,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			confirmed_at TIMESTAMP,
			FOREIGN KEY (finder_worker_id) REFERENCES workers(worker_id)
		)`,

		// Payouts table
		`CREATE TABLE IF NOT EXISTS payouts (
			id SERIAL PRIMARY KEY,
			worker_id VARCHAR(255) NOT NULL,
			amount DOUBLE PRECISION NOT NULL,
			currency VARCHAR(10) NOT NULL,
			address VARCHAR(255) NOT NULL,
			transaction_id VARCHAR(255),
			status VARCHAR(50) DEFAULT 'pending',
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			processed_at TIMESTAMP,
			error_message TEXT,
			FOREIGN KEY (worker_id) REFERENCES workers(worker_id)
		)`,

		// Jobs table
		`CREATE TABLE IF NOT EXISTS jobs (
			id VARCHAR(255) PRIMARY KEY,
			algorithm VARCHAR(50) NOT NULL,
			target VARCHAR(255) NOT NULL,
			block_template TEXT NOT NULL,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			expires_at TIMESTAMP NOT NULL,
			difficulty DOUBLE PRECISION NOT NULL,
			height INTEGER NOT NULL
		)`,

		// Statistics table
		`CREATE TABLE IF NOT EXISTS statistics (
			id BIGSERIAL PRIMARY KEY,
			timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			metric_name VARCHAR(255) NOT NULL,
			metric_value DOUBLE PRECISION NOT NULL,
			worker_id VARCHAR(255),
			metadata JSONB
		)`,

		// Audit log table
		`CREATE TABLE IF NOT EXISTS audit_logs (
			id BIGSERIAL PRIMARY KEY,
			timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			event_type VARCHAR(100) NOT NULL,
			user_id VARCHAR(255),
			ip_address VARCHAR(45),
			action VARCHAR(255) NOT NULL,
			resource VARCHAR(255),
			result VARCHAR(50),
			details JSONB
		)`,

		// Create indexes
		`CREATE INDEX IF NOT EXISTS idx_workers_username ON workers(username)`,
		`CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status)`,
		`CREATE INDEX IF NOT EXISTS idx_shares_worker_id ON shares(worker_id)`,
		`CREATE INDEX IF NOT EXISTS idx_shares_timestamp ON shares(timestamp)`,
		`CREATE INDEX IF NOT EXISTS idx_shares_valid ON shares(valid)`,
		`CREATE INDEX IF NOT EXISTS idx_blocks_height ON blocks(height)`,
		`CREATE INDEX IF NOT EXISTS idx_blocks_status ON blocks(status)`,
		`CREATE INDEX IF NOT EXISTS idx_payouts_worker_id ON payouts(worker_id)`,
		`CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status)`,
		`CREATE INDEX IF NOT EXISTS idx_statistics_timestamp ON statistics(timestamp)`,
		`CREATE INDEX IF NOT EXISTS idx_statistics_metric ON statistics(metric_name, timestamp)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type ON audit_logs(event_type)`,

		// Create update trigger for updated_at
		`CREATE OR REPLACE FUNCTION update_updated_at_column()
		RETURNS TRIGGER AS $$
		BEGIN
			NEW.updated_at = CURRENT_TIMESTAMP;
			RETURN NEW;
		END;
		$$ language 'plpgsql'`,

		`DO $$ 
		BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_workers_updated_at') THEN
				CREATE TRIGGER update_workers_updated_at BEFORE UPDATE ON workers
				FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
			END IF;
		END $$`,
	}

	// Execute schema creation
	for _, query := range schema {
		if _, err := d.Execute(ctx, query); err != nil {
			return fmt.Errorf("failed to execute schema query: %w", err)
		}
	}

	d.logger.Info("PostgreSQL schema initialized")
	return nil
}

// initializeMySQLSchema creates MySQL schema
func (d *DB) initializeMySQLSchema(ctx context.Context) error {
	schema := []string{
		// Workers table
		`CREATE TABLE IF NOT EXISTS workers (
			id INT AUTO_INCREMENT PRIMARY KEY,
			worker_id VARCHAR(255) UNIQUE NOT NULL,
			username VARCHAR(255) NOT NULL,
			password_hash VARCHAR(255),
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			last_seen_at TIMESTAMP NULL,
			total_shares BIGINT DEFAULT 0,
			valid_shares BIGINT DEFAULT 0,
			invalid_shares BIGINT DEFAULT 0,
			total_hashrate DOUBLE DEFAULT 0,
			status VARCHAR(50) DEFAULT 'active',
			metadata JSON,
			INDEX idx_username (username),
			INDEX idx_status (status)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

		// Shares table
		`CREATE TABLE IF NOT EXISTS shares (
			id BIGINT AUTO_INCREMENT PRIMARY KEY,
			worker_id VARCHAR(255) NOT NULL,
			job_id VARCHAR(255) NOT NULL,
			nonce VARCHAR(255) NOT NULL,
			hash VARCHAR(255) NOT NULL,
			difficulty DOUBLE NOT NULL,
			timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			valid BOOLEAN DEFAULT true,
			block_height INT,
			reward DOUBLE DEFAULT 0,
			FOREIGN KEY (worker_id) REFERENCES workers(worker_id),
			INDEX idx_worker_id (worker_id),
			INDEX idx_timestamp (timestamp),
			INDEX idx_valid (valid)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

		// Blocks table
		`CREATE TABLE IF NOT EXISTS blocks (
			id INT AUTO_INCREMENT PRIMARY KEY,
			height INT UNIQUE NOT NULL,
			hash VARCHAR(255) UNIQUE NOT NULL,
			previous_hash VARCHAR(255) NOT NULL,
			timestamp TIMESTAMP NOT NULL,
			difficulty DOUBLE NOT NULL,
			reward DOUBLE NOT NULL,
			finder_worker_id VARCHAR(255),
			status VARCHAR(50) DEFAULT 'pending',
			confirmations INT DEFAULT 0,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			confirmed_at TIMESTAMP NULL,
			FOREIGN KEY (finder_worker_id) REFERENCES workers(worker_id),
			INDEX idx_height (height),
			INDEX idx_status (status)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

		// Payouts table
		`CREATE TABLE IF NOT EXISTS payouts (
			id INT AUTO_INCREMENT PRIMARY KEY,
			worker_id VARCHAR(255) NOT NULL,
			amount DOUBLE NOT NULL,
			currency VARCHAR(10) NOT NULL,
			address VARCHAR(255) NOT NULL,
			transaction_id VARCHAR(255),
			status VARCHAR(50) DEFAULT 'pending',
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			processed_at TIMESTAMP NULL,
			error_message TEXT,
			FOREIGN KEY (worker_id) REFERENCES workers(worker_id),
			INDEX idx_worker_id (worker_id),
			INDEX idx_status (status)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

		// Jobs table
		`CREATE TABLE IF NOT EXISTS jobs (
			id VARCHAR(255) PRIMARY KEY,
			algorithm VARCHAR(50) NOT NULL,
			target VARCHAR(255) NOT NULL,
			block_template TEXT NOT NULL,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			expires_at TIMESTAMP NOT NULL,
			difficulty DOUBLE NOT NULL,
			height INT NOT NULL
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

		// Statistics table
		`CREATE TABLE IF NOT EXISTS statistics (
			id BIGINT AUTO_INCREMENT PRIMARY KEY,
			timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			metric_name VARCHAR(255) NOT NULL,
			metric_value DOUBLE NOT NULL,
			worker_id VARCHAR(255),
			metadata JSON,
			INDEX idx_timestamp (timestamp),
			INDEX idx_metric (metric_name, timestamp)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

		// Audit log table
		`CREATE TABLE IF NOT EXISTS audit_logs (
			id BIGINT AUTO_INCREMENT PRIMARY KEY,
			timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			event_type VARCHAR(100) NOT NULL,
			user_id VARCHAR(255),
			ip_address VARCHAR(45),
			action VARCHAR(255) NOT NULL,
			resource VARCHAR(255),
			result VARCHAR(50),
			details JSON,
			INDEX idx_timestamp (timestamp),
			INDEX idx_event_type (event_type)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
	}

	// Execute schema creation
	for _, query := range schema {
		if _, err := d.Execute(ctx, query); err != nil {
			return fmt.Errorf("failed to execute schema query: %w", err)
		}
	}

	d.logger.Info("MySQL schema initialized")
	return nil
}