package main

import (
	"database/sql"
	"fmt"
	"log"
	"path/filepath"

	_ "github.com/mattn/go-sqlite3"
)

func main() {
	// Database path
	dbPath := filepath.Join("./data", "otedama.db")
	
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

	fmt.Println("Database connection successful!")

	// Test table creation
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS test_table (id INTEGER PRIMARY KEY, name TEXT)`)
	if err != nil {
		log.Fatalf("Failed to create test table: %v", err)
	}

	fmt.Println("Database test completed successfully!")
}
