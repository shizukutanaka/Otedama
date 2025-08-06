package backup

import (
	"context"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"
)

// BackupScheduler handles scheduled backups
type BackupScheduler struct {
	logger        *zap.Logger
	config        *BackupConfig
	
	// Schedule state
	running       bool
	runningMu     sync.Mutex
	lastFullBackup time.Time
	lastIncBackup  time.Time
	
	// Channels
	stop          chan struct{}
	done          chan struct{}
}

// ScheduledBackup represents a scheduled backup task
type ScheduledBackup struct {
	Type          BackupType
	Schedule      string
	LastRun       time.Time
	NextRun       time.Time
	Enabled       bool
}

// NewBackupScheduler creates a new backup scheduler
func NewBackupScheduler(logger *zap.Logger, config *BackupConfig) *BackupScheduler {
	return &BackupScheduler{
		logger: logger,
		config: config,
		stop:   make(chan struct{}),
		done:   make(chan struct{}),
	}
}

// Start starts the backup scheduler
func (s *BackupScheduler) Start(ctx context.Context, manager *BackupManager) error {
	s.runningMu.Lock()
	if s.running {
		s.runningMu.Unlock()
		return nil
	}
	s.running = true
	s.runningMu.Unlock()
	
	s.logger.Info("Starting backup scheduler",
		zap.Duration("backup_interval", s.config.BackupInterval),
		zap.Duration("full_backup_interval", s.config.FullBackupInterval),
	)
	
	// Start scheduler goroutine
	go s.run(ctx, manager)
	
	return nil
}

// Stop stops the backup scheduler
func (s *BackupScheduler) Stop() {
	s.runningMu.Lock()
	if !s.running {
		s.runningMu.Unlock()
		return
	}
	s.running = false
	s.runningMu.Unlock()
	
	close(s.stop)
	<-s.done
	
	s.logger.Info("Backup scheduler stopped")
}

// run is the main scheduler loop
func (s *BackupScheduler) run(ctx context.Context, manager *BackupManager) {
	defer close(s.done)
	
	// Create tickers
	backupTicker := time.NewTicker(s.config.BackupInterval)
	defer backupTicker.Stop()
	
	fullBackupTicker := time.NewTicker(s.config.FullBackupInterval)
	defer fullBackupTicker.Stop()
	
	// Perform initial backup
	s.performBackup(ctx, manager, IncrementalBackup)
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.stop:
			return
		case <-backupTicker.C:
			s.performBackup(ctx, manager, IncrementalBackup)
		case <-fullBackupTicker.C:
			s.performBackup(ctx, manager, FullBackup)
		}
	}
}

// performBackup performs a scheduled backup
func (s *BackupScheduler) performBackup(ctx context.Context, manager *BackupManager, backupType BackupType) {
	s.logger.Info("Starting scheduled backup", zap.String("type", string(backupType)))
	
	// Create context with timeout
	backupCtx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	
	// Perform backup
	metadata, err := manager.CreateBackup(backupCtx, backupType)
	if err != nil {
		s.logger.Error("Scheduled backup failed",
			zap.String("type", string(backupType)),
			zap.Error(err),
		)
		
		// Send failure notification
		if s.config.NotifyOnFailure {
			s.sendFailureNotification(backupType, err)
		}
		return
	}
	
	// Update last backup times
	switch backupType {
	case FullBackup:
		s.lastFullBackup = time.Now()
	case IncrementalBackup:
		s.lastIncBackup = time.Now()
	}
	
	s.logger.Info("Scheduled backup completed",
		zap.String("backup_id", metadata.ID),
		zap.String("type", string(backupType)),
		zap.Duration("duration", metadata.Duration),
		zap.Int64("size", metadata.Size),
	)
}

// GetSchedule returns the current backup schedule
func (s *BackupScheduler) GetSchedule() []ScheduledBackup {
	s.runningMu.Lock()
	running := s.running
	s.runningMu.Unlock()
	
	schedules := []ScheduledBackup{
		{
			Type:     IncrementalBackup,
			Schedule: formatDuration(s.config.BackupInterval),
			LastRun:  s.lastIncBackup,
			NextRun:  s.lastIncBackup.Add(s.config.BackupInterval),
			Enabled:  running && s.config.AutoBackupEnabled,
		},
		{
			Type:     FullBackup,
			Schedule: formatDuration(s.config.FullBackupInterval),
			LastRun:  s.lastFullBackup,
			NextRun:  s.lastFullBackup.Add(s.config.FullBackupInterval),
			Enabled:  running && s.config.AutoBackupEnabled,
		},
	}
	
	return schedules
}

// sendFailureNotification sends a notification about backup failure
func (s *BackupScheduler) sendFailureNotification(backupType BackupType, err error) {
	// TODO: Implement notification logic
	s.logger.Warn("Backup failure notification not implemented",
		zap.String("type", string(backupType)),
		zap.Error(err),
	)
}

// formatDuration formats a duration for display
func formatDuration(d time.Duration) string {
	if d >= 24*time.Hour {
		days := d / (24 * time.Hour)
		if days == 1 {
			return "Daily"
		}
		return fmt.Sprintf("Every %d days", days)
	}
	
	if d >= time.Hour {
		hours := d / time.Hour
		if hours == 1 {
			return "Hourly"
		}
		return fmt.Sprintf("Every %d hours", hours)
	}
	
	minutes := d / time.Minute
	return fmt.Sprintf("Every %d minutes", minutes)
}