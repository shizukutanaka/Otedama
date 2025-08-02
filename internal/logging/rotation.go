// Package logging provides enhanced logging capabilities for the Otedama system.
package logging

import (
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
	"gopkg.in/natefinch/lumberjack.v2"
)

// RotationConfig defines log rotation configuration
type RotationConfig struct {
	// MaxSize is the maximum size in megabytes of the log file before it gets rotated
	MaxSize int `yaml:"max_size" default:"100"`
	
	// MaxAge is the maximum number of days to retain old log files
	MaxAge int `yaml:"max_age" default:"30"`
	
	// MaxBackups is the maximum number of old log files to retain
	MaxBackups int `yaml:"max_backups" default:"10"`
	
	// Compress determines if the rotated log files should be compressed
	Compress bool `yaml:"compress" default:"true"`
	
	// LocalTime determines if the time used for formatting timestamps is local time
	LocalTime bool `yaml:"local_time" default:"true"`
	
	// RotationTime is the time of day to rotate logs (HH:MM format)
	RotationTime string `yaml:"rotation_time" default:"00:00"`
	
	// ArchiveDir is the directory where old logs are archived
	ArchiveDir string `yaml:"archive_dir" default:"logs/archive"`
}

// LogRotator manages log file rotation
type LogRotator struct {
	config     RotationConfig
	logger     *zap.Logger
	lumberjack *lumberjack.Logger
	mu         sync.Mutex
	stopCh     chan struct{}
	wg         sync.WaitGroup
}

// NewLogRotator creates a new log rotator
func NewLogRotator(filename string, config RotationConfig, logger *zap.Logger) *LogRotator {
	// Create lumberjack logger for rotation
	ljLogger := &lumberjack.Logger{
		Filename:   filename,
		MaxSize:    config.MaxSize,
		MaxAge:     config.MaxAge,
		MaxBackups: config.MaxBackups,
		Compress:   config.Compress,
		LocalTime:  config.LocalTime,
	}

	rotator := &LogRotator{
		config:     config,
		logger:     logger,
		lumberjack: ljLogger,
		stopCh:     make(chan struct{}),
	}

	// Create archive directory if it doesn't exist
	if config.ArchiveDir != "" {
		os.MkdirAll(config.ArchiveDir, 0755)
	}

	return rotator
}

// Start starts the log rotation scheduler
func (lr *LogRotator) Start() error {
	lr.wg.Add(1)
	go lr.rotationScheduler()
	
	lr.logger.Info("Log rotation started",
		zap.Int("max_size_mb", lr.config.MaxSize),
		zap.Int("max_age_days", lr.config.MaxAge),
		zap.Int("max_backups", lr.config.MaxBackups),
		zap.Bool("compress", lr.config.Compress),
	)
	
	return nil
}

// Stop stops the log rotation scheduler
func (lr *LogRotator) Stop() {
	close(lr.stopCh)
	lr.wg.Wait()
	lr.lumberjack.Close()
}

// Write implements io.Writer interface
func (lr *LogRotator) Write(p []byte) (n int, err error) {
	return lr.lumberjack.Write(p)
}

// Rotate forces log rotation
func (lr *LogRotator) Rotate() error {
	lr.mu.Lock()
	defer lr.mu.Unlock()
	
	return lr.lumberjack.Rotate()
}

// rotationScheduler handles scheduled log rotation
func (lr *LogRotator) rotationScheduler() {
	defer lr.wg.Done()

	// Parse rotation time
	rotationHour, rotationMin := lr.parseRotationTime()
	
	for {
		// Calculate next rotation time
		now := time.Now()
		next := time.Date(now.Year(), now.Month(), now.Day(),
			rotationHour, rotationMin, 0, 0, now.Location())
		
		if next.Before(now) {
			next = next.Add(24 * time.Hour)
		}
		
		duration := next.Sub(now)
		
		select {
		case <-time.After(duration):
			if err := lr.Rotate(); err != nil {
				lr.logger.Error("Failed to rotate log", zap.Error(err))
			} else {
				lr.logger.Info("Log rotated successfully")
				lr.archiveOldLogs()
			}
		case <-lr.stopCh:
			return
		}
	}
}

// parseRotationTime parses rotation time from config
func (lr *LogRotator) parseRotationTime() (hour, min int) {
	parts := strings.Split(lr.config.RotationTime, ":")
	if len(parts) != 2 {
		return 0, 0
	}
	
	fmt.Sscanf(parts[0], "%d", &hour)
	fmt.Sscanf(parts[1], "%d", &min)
	
	if hour < 0 || hour > 23 {
		hour = 0
	}
	if min < 0 || min > 59 {
		min = 0
	}
	
	return hour, min
}

// archiveOldLogs moves old logs to archive directory
func (lr *LogRotator) archiveOldLogs() {
	if lr.config.ArchiveDir == "" {
		return
	}
	
	// Get log directory
	logDir := filepath.Dir(lr.lumberjack.Filename)
	logBase := filepath.Base(lr.lumberjack.Filename)
	
	// Find rotated log files
	files, err := filepath.Glob(filepath.Join(logDir, logBase+".*"))
	if err != nil {
		lr.logger.Error("Failed to list log files", zap.Error(err))
		return
	}
	
	// Sort files by modification time
	sort.Slice(files, func(i, j int) bool {
		fi, _ := os.Stat(files[i])
		fj, _ := os.Stat(files[j])
		return fi.ModTime().Before(fj.ModTime())
	})
	
	// Archive old files
	cutoffTime := time.Now().Add(-time.Duration(lr.config.MaxAge) * 24 * time.Hour)
	for _, file := range files {
		fi, err := os.Stat(file)
		if err != nil {
			continue
		}
		
		if fi.ModTime().Before(cutoffTime) {
			archivePath := filepath.Join(lr.config.ArchiveDir, filepath.Base(file))
			if err := os.Rename(file, archivePath); err != nil {
				lr.logger.Error("Failed to archive log file",
					zap.String("file", file),
					zap.Error(err),
				)
			} else {
				lr.logger.Debug("Archived log file",
					zap.String("file", file),
					zap.String("archive", archivePath),
				)
			}
		}
	}
}

// DiskSpaceManager monitors and manages disk space for logs
type DiskSpaceManager struct {
	logger        *zap.Logger
	logDir        string
	maxDiskUsage  int64 // Maximum disk usage in bytes
	checkInterval time.Duration
	stopCh        chan struct{}
	wg            sync.WaitGroup
}

// NewDiskSpaceManager creates a new disk space manager
func NewDiskSpaceManager(logDir string, maxDiskUsageGB int, logger *zap.Logger) *DiskSpaceManager {
	return &DiskSpaceManager{
		logger:        logger,
		logDir:        logDir,
		maxDiskUsage:  int64(maxDiskUsageGB) * 1024 * 1024 * 1024,
		checkInterval: 5 * time.Minute,
		stopCh:        make(chan struct{}),
	}
}

// Start starts the disk space monitoring
func (dsm *DiskSpaceManager) Start() {
	dsm.wg.Add(1)
	go dsm.monitor()
	
	dsm.logger.Info("Disk space manager started",
		zap.String("log_dir", dsm.logDir),
		zap.Int64("max_disk_usage_gb", dsm.maxDiskUsage/1024/1024/1024),
	)
}

// Stop stops the disk space monitoring
func (dsm *DiskSpaceManager) Stop() {
	close(dsm.stopCh)
	dsm.wg.Wait()
}

// monitor periodically checks disk usage
func (dsm *DiskSpaceManager) monitor() {
	defer dsm.wg.Done()
	
	ticker := time.NewTicker(dsm.checkInterval)
	defer ticker.Stop()
	
	// Check immediately on start
	dsm.checkAndCleanup()
	
	for {
		select {
		case <-ticker.C:
			dsm.checkAndCleanup()
		case <-dsm.stopCh:
			return
		}
	}
}

// checkAndCleanup checks disk usage and cleans up if necessary
func (dsm *DiskSpaceManager) checkAndCleanup() {
	usage := dsm.calculateDiskUsage()
	
	dsm.logger.Debug("Current log disk usage",
		zap.Int64("usage_bytes", usage),
		zap.Int64("usage_mb", usage/1024/1024),
		zap.Float64("usage_percent", float64(usage)/float64(dsm.maxDiskUsage)*100),
	)
	
	if usage > dsm.maxDiskUsage {
		dsm.logger.Warn("Log disk usage exceeded limit, cleaning up",
			zap.Int64("usage_mb", usage/1024/1024),
			zap.Int64("limit_mb", dsm.maxDiskUsage/1024/1024),
		)
		dsm.cleanup(usage - dsm.maxDiskUsage)
	}
}

// calculateDiskUsage calculates total disk usage of log files
func (dsm *DiskSpaceManager) calculateDiskUsage() int64 {
	var totalSize int64
	
	err := filepath.Walk(dsm.logDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if !info.IsDir() && strings.HasSuffix(path, ".log") || strings.HasSuffix(path, ".gz") {
			totalSize += info.Size()
		}
		return nil
	})
	
	if err != nil {
		dsm.logger.Error("Failed to calculate disk usage", zap.Error(err))
	}
	
	return totalSize
}

// cleanup removes oldest log files to free up space
func (dsm *DiskSpaceManager) cleanup(bytesToFree int64) {
	// Get all log files
	var logFiles []fileInfo
	
	err := filepath.Walk(dsm.logDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if !info.IsDir() && (strings.HasSuffix(path, ".log") || strings.HasSuffix(path, ".gz")) {
			logFiles = append(logFiles, fileInfo{
				path:    path,
				size:    info.Size(),
				modTime: info.ModTime(),
			})
		}
		return nil
	})
	
	if err != nil {
		dsm.logger.Error("Failed to list log files", zap.Error(err))
		return
	}
	
	// Sort by modification time (oldest first)
	sort.Slice(logFiles, func(i, j int) bool {
		return logFiles[i].modTime.Before(logFiles[j].modTime)
	})
	
	// Delete oldest files until enough space is freed
	var freedBytes int64
	for _, file := range logFiles {
		// Skip files modified in the last 24 hours
		if time.Since(file.modTime) < 24*time.Hour {
			continue
		}
		
		if err := os.Remove(file.path); err != nil {
			dsm.logger.Error("Failed to delete log file",
				zap.String("file", file.path),
				zap.Error(err),
			)
			continue
		}
		
		freedBytes += file.size
		dsm.logger.Info("Deleted old log file",
			zap.String("file", file.path),
			zap.Int64("size_mb", file.size/1024/1024),
		)
		
		if freedBytes >= bytesToFree {
			break
		}
	}
	
	dsm.logger.Info("Disk cleanup completed",
		zap.Int64("freed_mb", freedBytes/1024/1024),
	)
}

type fileInfo struct {
	path    string
	size    int64
	modTime time.Time
}

// CompressOldLogs compresses old log files
func CompressOldLogs(logDir string, daysOld int) error {
	cutoffTime := time.Now().Add(-time.Duration(daysOld) * 24 * time.Hour)
	
	err := filepath.Walk(logDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		
		// Skip if already compressed or not a log file
		if info.IsDir() || strings.HasSuffix(path, ".gz") || !strings.HasSuffix(path, ".log") {
			return nil
		}
		
		// Skip if not old enough
		if info.ModTime().After(cutoffTime) {
			return nil
		}
		
		// Compress the file
		if err := compressFile(path); err != nil {
			return fmt.Errorf("failed to compress %s: %w", path, err)
		}
		
		return nil
	})
	
	return err
}

// compressFile compresses a single file
func compressFile(filename string) error {
	// Open source file
	src, err := os.Open(filename)
	if err != nil {
		return err
	}
	defer src.Close()
	
	// Create compressed file
	dst, err := os.Create(filename + ".gz")
	if err != nil {
		return err
	}
	defer dst.Close()
	
	// Create gzip writer
	gz := gzip.NewWriter(dst)
	defer gz.Close()
	
	// Copy data
	if _, err := io.Copy(gz, src); err != nil {
		return err
	}
	
	// Close gzip writer to flush data
	if err := gz.Close(); err != nil {
		return err
	}
	
	// Close destination file
	if err := dst.Close(); err != nil {
		return err
	}
	
	// Remove original file
	return os.Remove(filename)
}