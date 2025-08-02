package logging

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// EnhancedLogger wraps zap logger with rotation and disk management support
type EnhancedLogger struct {
	*zap.Logger
	config         LoggerConfig
	rotator        *LogRotator
	diskManager    *DiskSpaceManager
	logDir         string
}

// LoggerConfig defines enhanced logger configuration
type LoggerConfig struct {
	// Level is the minimum log level
	Level string `yaml:"level" default:"info"`
	
	// OutputPaths is the list of output paths
	OutputPaths []string `yaml:"output_paths"`
	
	// ErrorOutputPaths is the list of error output paths
	ErrorOutputPaths []string `yaml:"error_output_paths"`
	
	// Encoding is the log encoding (json or console)
	Encoding string `yaml:"encoding" default:"json"`
	
	// Development enables development mode
	Development bool `yaml:"development" default:"false"`
	
	// DisableCaller disables caller information
	DisableCaller bool `yaml:"disable_caller" default:"false"`
	
	// DisableStacktrace disables stack traces
	DisableStacktrace bool `yaml:"disable_stacktrace" default:"false"`
	
	// Rotation configuration
	Rotation RotationConfig `yaml:"rotation"`
	
	// EnableDiskManagement enables disk space management
	EnableDiskManagement bool `yaml:"enable_disk_management" default:"true"`
	
	// MaxDiskUsageGB is the maximum disk usage for logs in GB
	MaxDiskUsageGB int `yaml:"max_disk_usage_gb" default:"10"`
}

// NewEnhancedLogger creates a new logger with rotation support
func NewEnhancedLogger(config LoggerConfig) (*EnhancedLogger, error) {
	// Set default values
	if config.Level == "" {
		config.Level = "info"
	}
	if config.Encoding == "" {
		config.Encoding = "json"
	}
	if len(config.OutputPaths) == 0 {
		config.OutputPaths = []string{"stdout", "logs/otedama.log"}
	}
	if len(config.ErrorOutputPaths) == 0 {
		config.ErrorOutputPaths = []string{"stderr", "logs/otedama-error.log"}
	}

	// Create log directory
	logDir := "logs"
	for _, path := range config.OutputPaths {
		if path != "stdout" && path != "stderr" {
			dir := filepath.Dir(path)
			if dir != "." && dir != "" {
				logDir = dir
				os.MkdirAll(dir, 0755)
			}
		}
	}

	// Parse log level
	level, err := zapcore.ParseLevel(config.Level)
	if err != nil {
		return nil, fmt.Errorf("invalid log level: %w", err)
	}

	// Create encoder config
	encoderConfig := zapcore.EncoderConfig{
		TimeKey:        "timestamp",
		LevelKey:       "level",
		NameKey:        "logger",
		CallerKey:      "caller",
		FunctionKey:    zapcore.OmitKey,
		MessageKey:     "message",
		StacktraceKey:  "stacktrace",
		LineEnding:     zapcore.DefaultLineEnding,
		EncodeLevel:    zapcore.LowercaseLevelEncoder,
		EncodeTime:     zapcore.ISO8601TimeEncoder,
		EncodeDuration: zapcore.SecondsDurationEncoder,
		EncodeCaller:   zapcore.ShortCallerEncoder,
	}

	// Create zap config
	zapConfig := zap.Config{
		Level:             zap.NewAtomicLevelAt(level),
		Development:       config.Development,
		DisableCaller:     config.DisableCaller,
		DisableStacktrace: config.DisableStacktrace,
		Encoding:          config.Encoding,
		EncoderConfig:     encoderConfig,
		OutputPaths:       config.OutputPaths,
		ErrorOutputPaths:  config.ErrorOutputPaths,
		InitialFields: map[string]interface{}{
			"service": "otedama",
			"version": "2.1.1",
		},
	}

	// Build logger
	zapLogger, err := zapConfig.Build()
	if err != nil {
		return nil, fmt.Errorf("failed to build logger: %w", err)
	}

	logger := &EnhancedLogger{
		Logger: zapLogger,
		config: config,
		logDir: logDir,
	}

	// Setup log rotation for file outputs
	for _, path := range config.OutputPaths {
		if path != "stdout" && path != "stderr" {
			rotator := NewLogRotator(path, config.Rotation, zapLogger)
			if err := rotator.Start(); err != nil {
				return nil, fmt.Errorf("failed to start log rotation: %w", err)
			}
			logger.rotator = rotator
			break // Only need one rotator
		}
	}

	// Setup disk space management
	if config.EnableDiskManagement {
		diskManager := NewDiskSpaceManager(logDir, config.MaxDiskUsageGB, zapLogger)
		diskManager.Start()
		logger.diskManager = diskManager
	}

	// Log startup message
	logger.Info("Enhanced logger initialized",
		zap.String("level", config.Level),
		zap.String("encoding", config.Encoding),
		zap.Strings("outputs", config.OutputPaths),
		zap.Bool("rotation_enabled", logger.rotator != nil),
		zap.Bool("disk_management_enabled", config.EnableDiskManagement),
	)

	return logger, nil
}

// Sync flushes any buffered log entries
func (l *EnhancedLogger) Sync() error {
	return l.Logger.Sync()
}

// Close closes the logger and stops rotation
func (l *EnhancedLogger) Close() error {
	// Stop disk manager
	if l.diskManager != nil {
		l.diskManager.Stop()
	}

	// Stop rotator
	if l.rotator != nil {
		l.rotator.Stop()
	}

	// Sync logger
	return l.Sync()
}

// Rotate forces log rotation
func (l *EnhancedLogger) Rotate() error {
	if l.rotator != nil {
		return l.rotator.Rotate()
	}
	return nil
}

// GetLogFiles returns a list of log files
func (l *EnhancedLogger) GetLogFiles() ([]LogFileInfo, error) {
	var files []LogFileInfo

	err := filepath.Walk(l.logDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}

		if !info.IsDir() && (filepath.Ext(path) == ".log" || filepath.Ext(path) == ".gz") {
			files = append(files, LogFileInfo{
				Path:         path,
				Size:         info.Size(),
				ModTime:      info.ModTime(),
				IsCompressed: filepath.Ext(path) == ".gz",
			})
		}

		return nil
	})

	return files, err
}

// LogFileInfo contains information about a log file
type LogFileInfo struct {
	Path         string
	Size         int64
	ModTime      time.Time
	IsCompressed bool
}

// CleanupOldLogs removes logs older than the specified number of days
func (l *EnhancedLogger) CleanupOldLogs(daysOld int) error {
	cutoff := time.Now().Add(-time.Duration(daysOld) * 24 * time.Hour)
	
	files, err := l.GetLogFiles()
	if err != nil {
		return err
	}

	var deletedCount int
	var deletedSize int64

	for _, file := range files {
		if file.ModTime.Before(cutoff) {
			if err := os.Remove(file.Path); err != nil {
				l.Error("Failed to delete old log file",
					zap.String("file", file.Path),
					zap.Error(err),
				)
				continue
			}
			deletedCount++
			deletedSize += file.Size
		}
	}

	l.Info("Cleaned up old log files",
		zap.Int("deleted_count", deletedCount),
		zap.Int64("deleted_size_mb", deletedSize/1024/1024),
		zap.Int("days_old", daysOld),
	)

	return nil
}

// CompressOldLogs compresses logs older than the specified number of days
func (l *EnhancedLogger) CompressOldLogs(daysOld int) error {
	if err := CompressOldLogs(l.logDir, daysOld); err != nil {
		return fmt.Errorf("failed to compress old logs: %w", err)
	}

	l.Info("Compressed old log files",
		zap.Int("days_old", daysOld),
	)

	return nil
}

// GetDiskUsage returns the current disk usage of log files
func (l *EnhancedLogger) GetDiskUsage() (int64, error) {
	var totalSize int64

	files, err := l.GetLogFiles()
	if err != nil {
		return 0, err
	}

	for _, file := range files {
		totalSize += file.Size
	}

	return totalSize, nil
}

// LogRotationStatus returns the status of log rotation
type LogRotationStatus struct {
	Enabled        bool
	MaxSize        int
	MaxAge         int
	MaxBackups     int
	Compress       bool
	DiskUsage      int64
	MaxDiskUsage   int64
	FileCount      int
	OldestFile     time.Time
	NewestFile     time.Time
}

// GetRotationStatus returns the current log rotation status
func (l *EnhancedLogger) GetRotationStatus() (*LogRotationStatus, error) {
	status := &LogRotationStatus{
		Enabled: l.rotator != nil,
	}

	if l.rotator != nil {
		status.MaxSize = l.config.Rotation.MaxSize
		status.MaxAge = l.config.Rotation.MaxAge
		status.MaxBackups = l.config.Rotation.MaxBackups
		status.Compress = l.config.Rotation.Compress
	}

	// Get disk usage
	usage, err := l.GetDiskUsage()
	if err != nil {
		return nil, err
	}
	status.DiskUsage = usage

	if l.config.EnableDiskManagement {
		status.MaxDiskUsage = int64(l.config.MaxDiskUsageGB) * 1024 * 1024 * 1024
	}

	// Get file info
	files, err := l.GetLogFiles()
	if err != nil {
		return nil, err
	}

	status.FileCount = len(files)
	if len(files) > 0 {
		status.OldestFile = files[0].ModTime
		status.NewestFile = files[0].ModTime

		for _, file := range files {
			if file.ModTime.Before(status.OldestFile) {
				status.OldestFile = file.ModTime
			}
			if file.ModTime.After(status.NewestFile) {
				status.NewestFile = file.ModTime
			}
		}
	}

	return status, nil
}