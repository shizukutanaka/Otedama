package backup

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"go.uber.org/zap"
)

// Database backup implementations

// backupSQLite backs up SQLite database
func (bm *BackupManager) backupSQLite(ctx context.Context, backupPath string) error {
	// Get database path from connection string
	dbPath := bm.db.ConnectionString()
	
	// Use SQLite backup command
	backupFile := filepath.Join(backupPath, "database.db")
	
	// Open source database
	srcDB, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		return err
	}
	defer srcDB.Close()
	
	// Create backup using SQLite backup API
	query := fmt.Sprintf("VACUUM INTO '%s'", backupFile)
	if _, err := srcDB.ExecContext(ctx, query); err != nil {
		// Fallback to file copy
		return copyFile(dbPath, backupFile)
	}
	
	// Also export as SQL for portability
	sqlFile := filepath.Join(backupPath, "database.sql")
	if err := bm.exportSQLiteToSQL(ctx, dbPath, sqlFile); err != nil {
		bm.logger.Warn("Failed to export SQLite to SQL", zap.Error(err))
	}
	
	// Export schema
	schemaFile := filepath.Join(backupPath, "schema.sql")
	if err := bm.exportSQLiteSchema(ctx, dbPath, schemaFile); err != nil {
		bm.logger.Warn("Failed to export SQLite schema", zap.Error(err))
	}
	
	// Export data as JSON for easy inspection
	jsonFile := filepath.Join(backupPath, "data.json")
	if err := bm.exportDatabaseToJSON(ctx, jsonFile); err != nil {
		bm.logger.Warn("Failed to export data to JSON", zap.Error(err))
	}
	
	return nil
}

// backupPostgres backs up PostgreSQL database
func (bm *BackupManager) backupPostgres(ctx context.Context, backupPath string) error {
	// Parse connection string
	connStr := bm.db.ConnectionString()
	params := parsePostgresConnStr(connStr)
	
	// Create pg_dump command
	dumpFile := filepath.Join(backupPath, "database.sql")
	
	cmd := exec.CommandContext(ctx, "pg_dump",
		"-h", params["host"],
		"-p", params["port"],
		"-U", params["user"],
		"-d", params["dbname"],
		"-f", dumpFile,
		"--clean",
		"--if-exists",
		"--no-owner",
		"--no-privileges",
	)
	
	// Set password via environment
	if password, ok := params["password"]; ok {
		cmd.Env = append(os.Environ(), fmt.Sprintf("PGPASSWORD=%s", password))
	}
	
	// Execute backup
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("pg_dump failed: %w\nOutput: %s", err, string(output))
	}
	
	// Also create custom format backup for faster restore
	customFile := filepath.Join(backupPath, "database.custom")
	cmdCustom := exec.CommandContext(ctx, "pg_dump",
		"-h", params["host"],
		"-p", params["port"],
		"-U", params["user"],
		"-d", params["dbname"],
		"-f", customFile,
		"-Fc", // Custom format
		"--clean",
		"--if-exists",
	)
	
	if password, ok := params["password"]; ok {
		cmdCustom.Env = append(os.Environ(), fmt.Sprintf("PGPASSWORD=%s", password))
	}
	
	if output, err := cmdCustom.CombinedOutput(); err != nil {
		bm.logger.Warn("Failed to create custom format backup",
			zap.Error(err),
			zap.String("output", string(output)),
		)
	}
	
	// Export data as JSON
	jsonFile := filepath.Join(backupPath, "data.json")
	if err := bm.exportDatabaseToJSON(ctx, jsonFile); err != nil {
		bm.logger.Warn("Failed to export data to JSON", zap.Error(err))
	}
	
	return nil
}

// backupMySQL backs up MySQL database
func (bm *BackupManager) backupMySQL(ctx context.Context, backupPath string) error {
	// Parse connection string
	connStr := bm.db.ConnectionString()
	params := parseMySQLConnStr(connStr)
	
	// Create mysqldump command
	dumpFile := filepath.Join(backupPath, "database.sql")
	
	cmd := exec.CommandContext(ctx, "mysqldump",
		"-h", params["host"],
		"-P", params["port"],
		"-u", params["user"],
		fmt.Sprintf("-p%s", params["password"]),
		params["dbname"],
		"--single-transaction",
		"--routines",
		"--triggers",
		"--result-file", dumpFile,
	)
	
	// Execute backup
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("mysqldump failed: %w\nOutput: %s", err, string(output))
	}
	
	// Export data as JSON
	jsonFile := filepath.Join(backupPath, "data.json")
	if err := bm.exportDatabaseToJSON(ctx, jsonFile); err != nil {
		bm.logger.Warn("Failed to export data to JSON", zap.Error(err))
	}
	
	return nil
}

// Database restore implementations

// restoreDatabase restores the database from backup
func (bm *BackupManager) restoreDatabase(ctx context.Context, backupPath string) error {
	dbPath := filepath.Join(backupPath, "database")
	
	switch bm.db.Type() {
	case "sqlite":
		return bm.restoreSQLite(ctx, dbPath)
	case "postgres":
		return bm.restorePostgres(ctx, dbPath)
	case "mysql":
		return bm.restoreMySQL(ctx, dbPath)
	default:
		return fmt.Errorf("unsupported database type: %s", bm.db.Type())
	}
}

// restoreSQLite restores SQLite database
func (bm *BackupManager) restoreSQLite(ctx context.Context, backupPath string) error {
	dbFile := filepath.Join(backupPath, "database.db")
	sqlFile := filepath.Join(backupPath, "database.sql")
	
	// Check which backup file exists
	if _, err := os.Stat(dbFile); err == nil {
		// Restore from database file
		targetPath := bm.db.ConnectionString()
		
		// Create backup of current database
		backupCurrent := targetPath + ".restore-backup"
		if err := copyFile(targetPath, backupCurrent); err != nil {
			bm.logger.Warn("Failed to backup current database", zap.Error(err))
		}
		
		// Restore database file
		return copyFile(dbFile, targetPath)
	} else if _, err := os.Stat(sqlFile); err == nil {
		// Restore from SQL file
		return bm.restoreSQLiteFromSQL(ctx, sqlFile)
	}
	
	return fmt.Errorf("no backup file found in %s", backupPath)
}

// restorePostgres restores PostgreSQL database
func (bm *BackupManager) restorePostgres(ctx context.Context, backupPath string) error {
	// Parse connection string
	connStr := bm.db.ConnectionString()
	params := parsePostgresConnStr(connStr)
	
	// Check for custom format backup first
	customFile := filepath.Join(backupPath, "database.custom")
	if _, err := os.Stat(customFile); err == nil {
		// Restore using pg_restore
		cmd := exec.CommandContext(ctx, "pg_restore",
			"-h", params["host"],
			"-p", params["port"],
			"-U", params["user"],
			"-d", params["dbname"],
			"--clean",
			"--if-exists",
			"--no-owner",
			"--no-privileges",
			customFile,
		)
		
		if password, ok := params["password"]; ok {
			cmd.Env = append(os.Environ(), fmt.Sprintf("PGPASSWORD=%s", password))
		}
		
		output, err := cmd.CombinedOutput()
		if err != nil {
			bm.logger.Warn("pg_restore with custom format failed, trying SQL format",
				zap.Error(err),
				zap.String("output", string(output)),
			)
		} else {
			return nil
		}
	}
	
	// Fallback to SQL file
	sqlFile := filepath.Join(backupPath, "database.sql")
	if _, err := os.Stat(sqlFile); err != nil {
		return fmt.Errorf("no backup file found in %s", backupPath)
	}
	
	// Restore using psql
	cmd := exec.CommandContext(ctx, "psql",
		"-h", params["host"],
		"-p", params["port"],
		"-U", params["user"],
		"-d", params["dbname"],
		"-f", sqlFile,
	)
	
	if password, ok := params["password"]; ok {
		cmd.Env = append(os.Environ(), fmt.Sprintf("PGPASSWORD=%s", password))
	}
	
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("psql restore failed: %w\nOutput: %s", err, string(output))
	}
	
	return nil
}

// restoreMySQL restores MySQL database
func (bm *BackupManager) restoreMySQL(ctx context.Context, backupPath string) error {
	// Parse connection string
	connStr := bm.db.ConnectionString()
	params := parseMySQLConnStr(connStr)
	
	sqlFile := filepath.Join(backupPath, "database.sql")
	if _, err := os.Stat(sqlFile); err != nil {
		return fmt.Errorf("backup file not found: %s", sqlFile)
	}
	
	// Restore using mysql command
	cmd := exec.CommandContext(ctx, "mysql",
		"-h", params["host"],
		"-P", params["port"],
		"-u", params["user"],
		fmt.Sprintf("-p%s", params["password"]),
		params["dbname"],
	)
	
	// Open SQL file
	sqlData, err := os.ReadFile(sqlFile)
	if err != nil {
		return err
	}
	
	// Pipe SQL to mysql command
	cmd.Stdin = strings.NewReader(string(sqlData))
	
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("mysql restore failed: %w\nOutput: %s", err, string(output))
	}
	
	return nil
}

// Helper functions for database operations

func (bm *BackupManager) exportSQLiteToSQL(ctx context.Context, dbPath, outputPath string) error {
	cmd := exec.CommandContext(ctx, "sqlite3", dbPath, ".dump")
	output, err := cmd.Output()
	if err != nil {
		return err
	}
	
	return os.WriteFile(outputPath, output, 0644)
}

func (bm *BackupManager) exportSQLiteSchema(ctx context.Context, dbPath, outputPath string) error {
	cmd := exec.CommandContext(ctx, "sqlite3", dbPath, ".schema")
	output, err := cmd.Output()
	if err != nil {
		return err
	}
	
	return os.WriteFile(outputPath, output, 0644)
}

func (bm *BackupManager) restoreSQLiteFromSQL(ctx context.Context, sqlFile string) error {
	targetPath := bm.db.ConnectionString()
	
	// Read SQL file
	sqlData, err := os.ReadFile(sqlFile)
	if err != nil {
		return err
	}
	
	// Execute SQL
	db, err := sql.Open("sqlite3", targetPath)
	if err != nil {
		return err
	}
	defer db.Close()
	
	_, err = db.ExecContext(ctx, string(sqlData))
	return err
}

func (bm *BackupManager) exportDatabaseToJSON(ctx context.Context, outputPath string) error {
	// Export key tables to JSON for inspection
	tables := []string{"workers", "shares", "blocks", "payouts"}
	data := make(map[string][]map[string]interface{})
	
	for _, table := range tables {
		rows, err := bm.db.Query(ctx, fmt.Sprintf("SELECT * FROM %s LIMIT 1000", table))
		if err != nil {
			continue
		}
		
		columns, err := rows.Columns()
		if err != nil {
			rows.Close()
			continue
		}
		
		var tableData []map[string]interface{}
		
		for rows.Next() {
			values := make([]interface{}, len(columns))
			valuePtrs := make([]interface{}, len(columns))
			for i := range values {
				valuePtrs[i] = &values[i]
			}
			
			if err := rows.Scan(valuePtrs...); err != nil {
				continue
			}
			
			row := make(map[string]interface{})
			for i, col := range columns {
				row[col] = values[i]
			}
			
			tableData = append(tableData, row)
		}
		rows.Close()
		
		data[table] = tableData
	}
	
	// Write JSON
	jsonData, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	
	return os.WriteFile(outputPath, jsonData, 0644)
}

// Connection string parsers

func parsePostgresConnStr(connStr string) map[string]string {
	params := make(map[string]string)
	
	// Default values
	params["host"] = "localhost"
	params["port"] = "5432"
	params["sslmode"] = "disable"
	
	// Parse connection string
	parts := strings.Fields(connStr)
	for _, part := range parts {
		kv := strings.SplitN(part, "=", 2)
		if len(kv) == 2 {
			params[kv[0]] = kv[1]
		}
	}
	
	return params
}

func parseMySQLConnStr(connStr string) map[string]string {
	params := make(map[string]string)
	
	// Default values
	params["host"] = "localhost"
	params["port"] = "3306"
	
	// Parse DSN format: user:password@tcp(host:port)/dbname
	if idx := strings.Index(connStr, "@"); idx > 0 {
		userPass := connStr[:idx]
		if colonIdx := strings.Index(userPass, ":"); colonIdx > 0 {
			params["user"] = userPass[:colonIdx]
			params["password"] = userPass[colonIdx+1:]
		}
		
		remaining := connStr[idx+1:]
		if tcpIdx := strings.Index(remaining, "tcp("); tcpIdx >= 0 {
			hostPort := remaining[tcpIdx+4:]
			if endIdx := strings.Index(hostPort, ")"); endIdx > 0 {
				hostPort = hostPort[:endIdx]
				if colonIdx := strings.LastIndex(hostPort, ":"); colonIdx > 0 {
					params["host"] = hostPort[:colonIdx]
					params["port"] = hostPort[colonIdx+1:]
				} else {
					params["host"] = hostPort
				}
			}
		}
		
		if dbIdx := strings.LastIndex(remaining, "/"); dbIdx > 0 {
			params["dbname"] = remaining[dbIdx+1:]
		}
	}
	
	return params
}