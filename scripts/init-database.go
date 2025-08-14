package main

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"path/filepath"

	_ "github.com/mattn/go-sqlite3"
)

func main() {
	// Ensure data directory exists
	dataDir := "./data"
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		log.Fatalf("Failed to create data directory: %v", err)
	}

	// Database path
	dbPath := filepath.Join(dataDir, "otedama.db")
	
	// Open database
	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		log.Fatalf("Failed to open database: %v", err)
	}
	defer db.Close()

	// Test connection
	if err := db.Ping(); err != nil {
		log.Fatalf("Failed to ping database: %v", err)
	}

	// Create tables
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
		_, err := db.Exec(query)
		if err != nil {
			log.Fatalf("Failed to execute query: %v\nQuery: %s", err, query)
		}
	}

	fmt.Println("Database initialized successfully!")
}
