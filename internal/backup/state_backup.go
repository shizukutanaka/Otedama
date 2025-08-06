package backup

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"go.uber.org/zap"
)

// State backup and restore functions

// backupState backs up application state files
func (bm *BackupManager) backupState(statePath string) error {
	if err := os.MkdirAll(statePath, 0755); err != nil {
		return err
	}
	
	// Define state files to backup
	stateFiles := []struct {
		name   string
		path   string
		required bool
	}{
		{"worker_states", "./state/workers.json", false},
		{"pool_state", "./state/pool.json", false},
		{"stratum_state", "./state/stratum.json", false},
		{"p2p_peers", "./state/peers.json", false},
		{"mining_stats", "./state/mining_stats.json", false},
		{"payout_queue", "./state/payout_queue.json", false},
	}
	
	backedUp := 0
	
	for _, file := range stateFiles {
		src := file.path
		dst := filepath.Join(statePath, file.name+".json")
		
		if _, err := os.Stat(src); err != nil {
			if file.required {
				return fmt.Errorf("required state file not found: %s", src)
			}
			continue
		}
		
		if err := copyFile(src, dst); err != nil {
			if file.required {
				return fmt.Errorf("failed to backup state file %s: %w", src, err)
			}
			bm.logger.Warn("Failed to backup state file",
				zap.String("file", src),
				zap.Error(err),
			)
			continue
		}
		
		backedUp++
	}
	
	bm.logger.Info("State files backed up", zap.Int("count", backedUp))
	
	// Backup runtime state
	if err := bm.backupRuntimeState(statePath); err != nil {
		bm.logger.Warn("Failed to backup runtime state", zap.Error(err))
	}
	
	return nil
}

// restoreState restores application state files
func (bm *BackupManager) restoreState(ctx context.Context, backupPath string) error {
	statePath := filepath.Join(backupPath, "state")
	
	if _, err := os.Stat(statePath); err != nil {
		return fmt.Errorf("state backup not found: %s", statePath)
	}
	
	// Restore state files
	stateFiles := []struct {
		name string
		path string
	}{
		{"worker_states", "./state/workers.json"},
		{"pool_state", "./state/pool.json"},
		{"stratum_state", "./state/stratum.json"},
		{"p2p_peers", "./state/peers.json"},
		{"mining_stats", "./state/mining_stats.json"},
		{"payout_queue", "./state/payout_queue.json"},
	}
	
	// Create state directory
	if err := os.MkdirAll("./state", 0755); err != nil {
		return err
	}
	
	restored := 0
	
	for _, file := range stateFiles {
		src := filepath.Join(statePath, file.name+".json")
		dst := file.path
		
		if _, err := os.Stat(src); err != nil {
			continue
		}
		
		// Create backup of current state
		if _, err := os.Stat(dst); err == nil {
			backupPath := dst + ".backup"
			if err := copyFile(dst, backupPath); err != nil {
				bm.logger.Warn("Failed to backup current state file",
					zap.String("file", dst),
					zap.Error(err),
				)
			}
		}
		
		// Restore state file
		if err := copyFile(src, dst); err != nil {
			bm.logger.Error("Failed to restore state file",
				zap.String("file", dst),
				zap.Error(err),
			)
			continue
		}
		
		restored++
	}
	
	bm.logger.Info("State files restored", zap.Int("count", restored))
	
	return nil
}

// backupLogs backs up log files
func (bm *BackupManager) backupLogs(logsPath string) error {
	if err := os.MkdirAll(logsPath, 0755); err != nil {
		return err
	}
	
	// Define log directories
	logDirs := []string{
		"./logs",
		"/var/log/otedama",
	}
	
	backedUp := 0
	
	for _, dir := range logDirs {
		if _, err := os.Stat(dir); err != nil {
			continue
		}
		
		// Copy log directory
		dstDir := filepath.Join(logsPath, filepath.Base(dir))
		if err := copyDirectory(dir, dstDir); err != nil {
			bm.logger.Warn("Failed to backup log directory",
				zap.String("dir", dir),
				zap.Error(err),
			)
			continue
		}
		
		backedUp++
	}
	
	// Also backup specific log files
	logFiles := []string{
		"otedama.log",
		"error.log",
		"access.log",
		"stratum.log",
		"pool.log",
	}
	
	for _, file := range logFiles {
		src := filepath.Join(".", file)
		if _, err := os.Stat(src); err != nil {
			continue
		}
		
		dst := filepath.Join(logsPath, file)
		if err := copyFile(src, dst); err != nil {
			bm.logger.Warn("Failed to backup log file",
				zap.String("file", file),
				zap.Error(err),
			)
			continue
		}
		
		backedUp++
	}
	
	bm.logger.Info("Log files backed up", zap.Int("count", backedUp))
	
	return nil
}

// backupRuntimeState captures current runtime state
func (bm *BackupManager) backupRuntimeState(statePath string) error {
	// This would capture runtime state from various components
	// For now, create a placeholder
	
	runtimeState := map[string]interface{}{
		"timestamp": time.Now(),
		"version":   "2.1.4",
		"uptime":    time.Since(startTime).Seconds(),
		"status": map[string]interface{}{
			"mining_active": false, // Would get from actual mining engine
			"pool_active":   false, // Would get from pool manager
			"api_active":    true,
		},
		"metrics": map[string]interface{}{
			"total_shares":     0,
			"blocks_found":     0,
			"active_workers":   0,
			"total_hashrate":   0,
		},
	}
	
	// Save runtime state
	data, err := json.MarshalIndent(runtimeState, "", "  ")
	if err != nil {
		return err
	}
	
	runtimeFile := filepath.Join(statePath, "runtime.json")
	return os.WriteFile(runtimeFile, data, 0644)
}

// restoreConfig restores configuration files
func (bm *BackupManager) restoreConfig(ctx context.Context, backupPath string) error {
	configPath := filepath.Join(backupPath, "config")
	
	if _, err := os.Stat(configPath); err != nil {
		return fmt.Errorf("config backup not found: %s", configPath)
	}
	
	// Restore configuration files
	configFiles := []string{
		"config.yaml",
		"config.json",
		"otedama.conf",
	}
	
	restored := 0
	
	for _, file := range configFiles {
		src := filepath.Join(configPath, file)
		dst := filepath.Join(".", file)
		
		if _, err := os.Stat(src); err != nil {
			continue
		}
		
		// Create backup of current config
		if _, err := os.Stat(dst); err == nil {
			backupPath := dst + ".backup"
			if err := copyFile(dst, backupPath); err != nil {
				bm.logger.Warn("Failed to backup current config",
					zap.String("file", dst),
					zap.Error(err),
				)
			}
		}
		
		// Restore config file
		if err := copyFile(src, dst); err != nil {
			bm.logger.Error("Failed to restore config file",
				zap.String("file", dst),
				zap.Error(err),
			)
			continue
		}
		
		restored++
	}
	
	// Restore config directory
	srcConfigDir := filepath.Join(configPath, "config")
	if _, err := os.Stat(srcConfigDir); err == nil {
		dstConfigDir := "./config"
		
		// Backup current config directory
		if _, err := os.Stat(dstConfigDir); err == nil {
			backupDir := dstConfigDir + ".backup"
			if err := copyDirectory(dstConfigDir, backupDir); err != nil {
				bm.logger.Warn("Failed to backup config directory", zap.Error(err))
			}
		}
		
		// Restore config directory
		if err := copyDirectory(srcConfigDir, dstConfigDir); err != nil {
			bm.logger.Error("Failed to restore config directory", zap.Error(err))
		} else {
			restored++
		}
	}
	
	bm.logger.Info("Config files restored", zap.Int("count", restored))
	
	return nil
}

// Variables for runtime tracking
var (
	startTime = time.Now()
)