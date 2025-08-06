package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// BackupManager handles backup and recovery operations
// Following Robert C. Martin's clean architecture principles
type BackupManager struct {
	logger *zap.Logger
	config BackupConfig
	
	// Backup storage
	localStorage  *LocalStorage
	remoteStorage RemoteStorage
	
	// Backup scheduling
	scheduler     *BackupScheduler
	
	// State tracking
	lastBackup    atomic.Value // time.Time
	backupInProgress atomic.Bool
	
	// Statistics
	stats         *BackupStats
	
	// Lifecycle
	ctx           context.Context
	cancel        context.CancelFunc
	wg            sync.WaitGroup
}

// BackupConfig contains backup configuration
type BackupConfig struct {
	// Storage settings
	LocalPath       string
	RemotePath      string
	MaxLocalBackups int
	MaxRemoteBackups int
	
	// Schedule settings
	FullBackupInterval    time.Duration
	IncrementalInterval   time.Duration
	RetentionDays         int
	
	// Backup settings
	CompressionLevel      int
	EncryptionEnabled     bool
	EncryptionKey         string
	
	// Database settings
	DatabasePath          string
	DatabaseBackupMethod  string // "snapshot", "dump"
	
	// Include patterns
	IncludePatterns       []string
	ExcludePatterns       []string
	
	// Performance
	ParallelWorkers       int
	BufferSize            int
}

// BackupStats tracks backup statistics
type BackupStats struct {
	TotalBackups       atomic.Uint64
	SuccessfulBackups  atomic.Uint64
	FailedBackups      atomic.Uint64
	TotalSize          atomic.Uint64
	LastBackupSize     atomic.Uint64
	LastBackupDuration atomic.Int64 // nanoseconds
	RestoredBackups    atomic.Uint64
}

// BackupMetadata contains backup metadata
type BackupMetadata struct {
	ID            string                 `json:"id"`
	Type          BackupType            `json:"type"`
	Timestamp     time.Time             `json:"timestamp"`
	Size          int64                 `json:"size"`
	Checksum      string                `json:"checksum"`
	Version       string                `json:"version"`
	Description   string                `json:"description"`
	Files         []BackupFile          `json:"files"`
	DatabaseInfo  *DatabaseBackupInfo   `json:"database_info,omitempty"`
	Dependencies  []string              `json:"dependencies,omitempty"`
	Encrypted     bool                  `json:"encrypted"`
}

// BackupType defines backup types
type BackupType string

const (
	FullBackup        BackupType = "full"
	IncrementalBackup BackupType = "incremental"
	SnapshotBackup    BackupType = "snapshot"
)

// BackupFile represents a file in the backup
type BackupFile struct {
	Path         string    `json:"path"`
	Size         int64     `json:"size"`
	ModTime      time.Time `json:"mod_time"`
	Checksum     string    `json:"checksum"`
	Permissions  os.FileMode `json:"permissions"`
}

// DatabaseBackupInfo contains database backup information
type DatabaseBackupInfo struct {
	Engine       string    `json:"engine"`
	Version      string    `json:"version"`
	Tables       []string  `json:"tables"`
	RowCount     int64     `json:"row_count"`
	LastSequence int64     `json:"last_sequence"`
}

// RemoteStorage interface for remote backup storage
type RemoteStorage interface {
	Upload(ctx context.Context, localPath, remotePath string) error
	Download(ctx context.Context, remotePath, localPath string) error
	List(ctx context.Context, prefix string) ([]string, error)
	Delete(ctx context.Context, path string) error
	Exists(ctx context.Context, path string) (bool, error)
}

// LocalStorage manages local backup storage
type LocalStorage struct {
	basePath string
	logger   *zap.Logger
}

// BackupScheduler handles backup scheduling
type BackupScheduler struct {
	manager      *BackupManager
	fullBackupTimer    *time.Timer
	incrementalTimer   *time.Timer
	mu                 sync.Mutex
}

// NewBackupManager creates a new backup manager
func NewBackupManager(logger *zap.Logger, config BackupConfig, remoteStorage RemoteStorage) *BackupManager {
	ctx, cancel := context.WithCancel(context.Background())
	
	bm := &BackupManager{
		logger:        logger,
		config:        config,
		localStorage:  &LocalStorage{
			basePath: config.LocalPath,
			logger:   logger,
		},
		remoteStorage: remoteStorage,
		stats:         &BackupStats{},
		ctx:           ctx,
		cancel:        cancel,
	}
	
	bm.scheduler = &BackupScheduler{manager: bm}
	
	return bm
}

// Start starts the backup manager
func (bm *BackupManager) Start() error {
	bm.logger.Info("Starting backup manager",
		zap.String("local_path", bm.config.LocalPath),
		zap.Duration("full_interval", bm.config.FullBackupInterval),
		zap.Duration("incremental_interval", bm.config.IncrementalInterval),
	)
	
	// Create local backup directory
	if err := os.MkdirAll(bm.config.LocalPath, 0755); err != nil {
		return fmt.Errorf("failed to create backup directory: %w", err)
	}
	
	// Start scheduler
	bm.wg.Add(1)
	go bm.scheduler.run(bm.ctx, &bm.wg)
	
	// Start cleanup routine
	bm.wg.Add(1)
	go bm.cleanupRoutine()
	
	return nil
}

// Stop stops the backup manager
func (bm *BackupManager) Stop() error {
	bm.logger.Info("Stopping backup manager")
	
	bm.cancel()
	bm.wg.Wait()
	
	return nil
}

// CreateBackup creates a new backup
func (bm *BackupManager) CreateBackup(backupType BackupType, description string) (*BackupMetadata, error) {
	if !bm.backupInProgress.CompareAndSwap(false, true) {
		return nil, errors.New("backup already in progress")
	}
	defer bm.backupInProgress.Store(false)
	
	startTime := time.Now()
	bm.logger.Info("Creating backup",
		zap.String("type", string(backupType)),
		zap.String("description", description),
	)
	
	// Create backup metadata
	metadata := &BackupMetadata{
		ID:          generateBackupID(),
		Type:        backupType,
		Timestamp:   startTime,
		Version:     "2.1.4",
		Description: description,
		Encrypted:   bm.config.EncryptionEnabled,
	}
	
	// Create temporary directory for backup
	tempDir := filepath.Join(bm.config.LocalPath, "temp", metadata.ID)
	if err := os.MkdirAll(tempDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create temp directory: %w", err)
	}
	defer os.RemoveAll(tempDir)
	
	// Collect files to backup
	files, err := bm.collectFiles(backupType)
	if err != nil {
		bm.stats.FailedBackups.Add(1)
		return nil, fmt.Errorf("failed to collect files: %w", err)
	}
	
	// Backup database
	if bm.config.DatabasePath != "" {
		dbInfo, err := bm.backupDatabase(tempDir)
		if err != nil {
			bm.stats.FailedBackups.Add(1)
			return nil, fmt.Errorf("failed to backup database: %w", err)
		}
		metadata.DatabaseInfo = dbInfo
	}
	
	// Create backup archive
	archivePath := filepath.Join(bm.config.LocalPath, fmt.Sprintf("%s.tar.gz", metadata.ID))
	if err := bm.createArchive(archivePath, tempDir, files); err != nil {
		bm.stats.FailedBackups.Add(1)
		return nil, fmt.Errorf("failed to create archive: %w", err)
	}
	
	// Calculate checksum
	checksum, err := bm.calculateChecksum(archivePath)
	if err != nil {
		bm.stats.FailedBackups.Add(1)
		return nil, fmt.Errorf("failed to calculate checksum: %w", err)
	}
	metadata.Checksum = checksum
	
	// Get file info
	info, err := os.Stat(archivePath)
	if err != nil {
		bm.stats.FailedBackups.Add(1)
		return nil, fmt.Errorf("failed to stat archive: %w", err)
	}
	metadata.Size = info.Size()
	metadata.Files = files
	
	// Save metadata
	metadataPath := filepath.Join(bm.config.LocalPath, fmt.Sprintf("%s.json", metadata.ID))
	if err := bm.saveMetadata(metadataPath, metadata); err != nil {
		bm.stats.FailedBackups.Add(1)
		return nil, fmt.Errorf("failed to save metadata: %w", err)
	}
	
	// Upload to remote storage if configured
	if bm.remoteStorage != nil {
		if err := bm.uploadToRemote(archivePath, metadataPath); err != nil {
			bm.logger.Error("Failed to upload to remote storage", zap.Error(err))
			// Don't fail the backup if remote upload fails
		}
	}
	
	// Update statistics
	duration := time.Since(startTime)
	bm.stats.TotalBackups.Add(1)
	bm.stats.SuccessfulBackups.Add(1)
	bm.stats.TotalSize.Add(uint64(metadata.Size))
	bm.stats.LastBackupSize.Store(uint64(metadata.Size))
	bm.stats.LastBackupDuration.Store(duration.Nanoseconds())
	bm.lastBackup.Store(time.Now())
	
	bm.logger.Info("Backup completed",
		zap.String("id", metadata.ID),
		zap.Int64("size", metadata.Size),
		zap.Duration("duration", duration),
	)
	
	return metadata, nil
}

// RestoreBackup restores from a backup
func (bm *BackupManager) RestoreBackup(backupID string, targetPath string) error {
	bm.logger.Info("Restoring backup",
		zap.String("backup_id", backupID),
		zap.String("target_path", targetPath),
	)
	
	// Load metadata
	metadataPath := filepath.Join(bm.config.LocalPath, fmt.Sprintf("%s.json", backupID))
	metadata, err := bm.loadMetadata(metadataPath)
	if err != nil {
		// Try remote storage
		if bm.remoteStorage != nil {
			if err := bm.downloadFromRemote(backupID); err != nil {
				return fmt.Errorf("failed to download backup: %w", err)
			}
			metadata, err = bm.loadMetadata(metadataPath)
			if err != nil {
				return fmt.Errorf("failed to load metadata: %w", err)
			}
		} else {
			return fmt.Errorf("failed to load metadata: %w", err)
		}
	}
	
	// Verify checksum
	archivePath := filepath.Join(bm.config.LocalPath, fmt.Sprintf("%s.tar.gz", backupID))
	checksum, err := bm.calculateChecksum(archivePath)
	if err != nil {
		return fmt.Errorf("failed to calculate checksum: %w", err)
	}
	
	if checksum != metadata.Checksum {
		return errors.New("checksum mismatch")
	}
	
	// Create target directory
	if err := os.MkdirAll(targetPath, 0755); err != nil {
		return fmt.Errorf("failed to create target directory: %w", err)
	}
	
	// Extract archive
	if err := bm.extractArchive(archivePath, targetPath); err != nil {
		return fmt.Errorf("failed to extract archive: %w", err)
	}
	
	// Restore database if present
	if metadata.DatabaseInfo != nil {
		if err := bm.restoreDatabase(targetPath, metadata.DatabaseInfo); err != nil {
			return fmt.Errorf("failed to restore database: %w", err)
		}
	}
	
	// Update statistics
	bm.stats.RestoredBackups.Add(1)
	
	bm.logger.Info("Backup restored successfully",
		zap.String("backup_id", backupID),
		zap.String("target_path", targetPath),
	)
	
	return nil
}

// ListBackups lists available backups
func (bm *BackupManager) ListBackups() ([]*BackupMetadata, error) {
	backups := make([]*BackupMetadata, 0)
	
	// List local backups
	entries, err := os.ReadDir(bm.config.LocalPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read backup directory: %w", err)
	}
	
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) == ".json" {
			metadataPath := filepath.Join(bm.config.LocalPath, entry.Name())
			metadata, err := bm.loadMetadata(metadataPath)
			if err != nil {
				bm.logger.Warn("Failed to load metadata",
					zap.String("file", entry.Name()),
					zap.Error(err),
				)
				continue
			}
			backups = append(backups, metadata)
		}
	}
	
	// List remote backups if configured
	if bm.remoteStorage != nil {
		remoteBackups, err := bm.remoteStorage.List(bm.ctx, bm.config.RemotePath)
		if err != nil {
			bm.logger.Warn("Failed to list remote backups", zap.Error(err))
		} else {
			// Process remote backups
			for _, remotePath := range remoteBackups {
				// Check if already in local list
				backupID := filepath.Base(remotePath)
				backupID = backupID[:len(backupID)-len(filepath.Ext(backupID))]
				
				found := false
				for _, b := range backups {
					if b.ID == backupID {
						found = true
						break
					}
				}
				
				if !found {
					// Add placeholder for remote-only backup
					backups = append(backups, &BackupMetadata{
						ID:        backupID,
						Timestamp: time.Time{}, // Unknown
					})
				}
			}
		}
	}
	
	return backups, nil
}

// GetStats returns backup statistics
func (bm *BackupManager) GetStats() map[string]interface{} {
	lastBackup := time.Time{}
	if val := bm.lastBackup.Load(); val != nil {
		lastBackup = val.(time.Time)
	}
	
	return map[string]interface{}{
		"total_backups":       bm.stats.TotalBackups.Load(),
		"successful_backups":  bm.stats.SuccessfulBackups.Load(),
		"failed_backups":      bm.stats.FailedBackups.Load(),
		"total_size":          bm.stats.TotalSize.Load(),
		"last_backup_size":    bm.stats.LastBackupSize.Load(),
		"last_backup_duration": time.Duration(bm.stats.LastBackupDuration.Load()),
		"restored_backups":    bm.stats.RestoredBackups.Load(),
		"last_backup":         lastBackup,
		"backup_in_progress":  bm.backupInProgress.Load(),
	}
}

// Helper methods

func (bm *BackupManager) collectFiles(backupType BackupType) ([]BackupFile, error) {
	files := make([]BackupFile, 0)
	
	// Define what to backup based on type
	includePaths := []string{
		"config",
		"internal",
		"cmd",
		"scripts",
	}
	
	if backupType == FullBackup {
		includePaths = append(includePaths, "logs", "data")
	}
	
	// Collect files
	for _, path := range includePaths {
		if err := filepath.Walk(path, func(filePath string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			
			// Skip directories and excluded patterns
			if info.IsDir() || bm.isExcluded(filePath) {
				return nil
			}
			
			// Calculate checksum for important files
			checksum := ""
			if filepath.Ext(filePath) == ".go" || filepath.Ext(filePath) == ".yaml" {
				sum, _ := bm.calculateFileChecksum(filePath)
				checksum = sum
			}
			
			files = append(files, BackupFile{
				Path:        filePath,
				Size:        info.Size(),
				ModTime:     info.ModTime(),
				Checksum:    checksum,
				Permissions: info.Mode(),
			})
			
			return nil
		}); err != nil {
			// Continue on error
			bm.logger.Warn("Error collecting files",
				zap.String("path", path),
				zap.Error(err),
			)
		}
	}
	
	return files, nil
}

func (bm *BackupManager) isExcluded(path string) bool {
	// Check exclude patterns
	for _, pattern := range bm.config.ExcludePatterns {
		if matched, _ := filepath.Match(pattern, path); matched {
			return true
		}
	}
	
	// Default excludes
	excludes := []string{
		"*.tmp",
		"*.log",
		".git",
		"node_modules",
		"vendor",
	}
	
	for _, pattern := range excludes {
		if matched, _ := filepath.Match(pattern, filepath.Base(path)); matched {
			return true
		}
	}
	
	return false
}

func (bm *BackupManager) createArchive(archivePath, sourceDir string, files []BackupFile) error {
	file, err := os.Create(archivePath)
	if err != nil {
		return err
	}
	defer file.Close()
	
	// Create gzip writer
	gzipWriter, err := gzip.NewWriterLevel(file, bm.config.CompressionLevel)
	if err != nil {
		return err
	}
	defer gzipWriter.Close()
	
	// Create tar writer
	tarWriter := tar.NewWriter(gzipWriter)
	defer tarWriter.Close()
	
	// Add files to archive
	for _, backupFile := range files {
		if err := bm.addFileToArchive(tarWriter, backupFile.Path); err != nil {
			bm.logger.Warn("Failed to add file to archive",
				zap.String("file", backupFile.Path),
				zap.Error(err),
			)
		}
	}
	
	// Add database backup if present
	dbBackupPath := filepath.Join(sourceDir, "database_backup.sql")
	if _, err := os.Stat(dbBackupPath); err == nil {
		if err := bm.addFileToArchive(tarWriter, dbBackupPath); err != nil {
			return fmt.Errorf("failed to add database backup: %w", err)
		}
	}
	
	return nil
}

func (bm *BackupManager) addFileToArchive(tw *tar.Writer, filePath string) error {
	file, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer file.Close()
	
	info, err := file.Stat()
	if err != nil {
		return err
	}
	
	header, err := tar.FileInfoHeader(info, "")
	if err != nil {
		return err
	}
	
	header.Name = filePath
	
	if err := tw.WriteHeader(header); err != nil {
		return err
	}
	
	_, err = io.Copy(tw, file)
	return err
}

func (bm *BackupManager) extractArchive(archivePath, targetPath string) error {
	file, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer file.Close()
	
	// Create gzip reader
	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer gzipReader.Close()
	
	// Create tar reader
	tarReader := tar.NewReader(gzipReader)
	
	// Extract files
	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		
		targetFile := filepath.Join(targetPath, header.Name)
		
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(targetFile, os.FileMode(header.Mode)); err != nil {
				return err
			}
			
		case tar.TypeReg:
			// Create directory if needed
			if err := os.MkdirAll(filepath.Dir(targetFile), 0755); err != nil {
				return err
			}
			
			// Create file
			file, err := os.OpenFile(targetFile, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(header.Mode))
			if err != nil {
				return err
			}
			
			if _, err := io.Copy(file, tarReader); err != nil {
				file.Close()
				return err
			}
			file.Close()
		}
	}
	
	return nil
}

func (bm *BackupManager) calculateChecksum(filePath string) (string, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer file.Close()
	
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func (bm *BackupManager) calculateFileChecksum(filePath string) (string, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return "", err
	}
	
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:]), nil
}

func (bm *BackupManager) saveMetadata(path string, metadata *BackupMetadata) error {
	data, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return err
	}
	
	return os.WriteFile(path, data, 0644)
}

func (bm *BackupManager) loadMetadata(path string) (*BackupMetadata, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	
	var metadata BackupMetadata
	if err := json.Unmarshal(data, &metadata); err != nil {
		return nil, err
	}
	
	return &metadata, nil
}

func (bm *BackupManager) backupDatabase(tempDir string) (*DatabaseBackupInfo, error) {
	// Simplified database backup
	// In production, use proper database backup tools
	
	info := &DatabaseBackupInfo{
		Engine:  "sqlite",
		Version: "3.0",
		Tables:  []string{"miners", "shares", "blocks", "payouts"},
	}
	
	// Copy database file
	dbBackupPath := filepath.Join(tempDir, "database_backup.sql")
	if err := bm.copyFile(bm.config.DatabasePath, dbBackupPath); err != nil {
		return nil, err
	}
	
	return info, nil
}

func (bm *BackupManager) restoreDatabase(targetPath string, info *DatabaseBackupInfo) error {
	// Simplified database restore
	dbBackupPath := filepath.Join(targetPath, "database_backup.sql")
	dbTargetPath := filepath.Join(targetPath, "database.db")
	
	return bm.copyFile(dbBackupPath, dbTargetPath)
}

func (bm *BackupManager) copyFile(src, dst string) error {
	sourceFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer sourceFile.Close()
	
	destFile, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer destFile.Close()
	
	_, err = io.Copy(destFile, sourceFile)
	return err
}

func (bm *BackupManager) uploadToRemote(archivePath, metadataPath string) error {
	// Upload archive
	remotePath := filepath.Join(bm.config.RemotePath, filepath.Base(archivePath))
	if err := bm.remoteStorage.Upload(bm.ctx, archivePath, remotePath); err != nil {
		return fmt.Errorf("failed to upload archive: %w", err)
	}
	
	// Upload metadata
	remoteMetadataPath := filepath.Join(bm.config.RemotePath, filepath.Base(metadataPath))
	if err := bm.remoteStorage.Upload(bm.ctx, metadataPath, remoteMetadataPath); err != nil {
		return fmt.Errorf("failed to upload metadata: %w", err)
	}
	
	return nil
}

func (bm *BackupManager) downloadFromRemote(backupID string) error {
	// Download archive
	archiveName := fmt.Sprintf("%s.tar.gz", backupID)
	remotePath := filepath.Join(bm.config.RemotePath, archiveName)
	localPath := filepath.Join(bm.config.LocalPath, archiveName)
	
	if err := bm.remoteStorage.Download(bm.ctx, remotePath, localPath); err != nil {
		return fmt.Errorf("failed to download archive: %w", err)
	}
	
	// Download metadata
	metadataName := fmt.Sprintf("%s.json", backupID)
	remoteMetadataPath := filepath.Join(bm.config.RemotePath, metadataName)
	localMetadataPath := filepath.Join(bm.config.LocalPath, metadataName)
	
	if err := bm.remoteStorage.Download(bm.ctx, remoteMetadataPath, localMetadataPath); err != nil {
		return fmt.Errorf("failed to download metadata: %w", err)
	}
	
	return nil
}

// Scheduler methods

func (s *BackupScheduler) run(ctx context.Context, wg *sync.WaitGroup) {
	defer wg.Done()
	
	// Schedule initial backups
	s.scheduleFullBackup()
	s.scheduleIncrementalBackup()
	
	for {
		select {
		case <-ctx.Done():
			return
			
		case <-s.fullBackupTimer.C:
			s.manager.CreateBackup(FullBackup, "Scheduled full backup")
			s.scheduleFullBackup()
			
		case <-s.incrementalTimer.C:
			s.manager.CreateBackup(IncrementalBackup, "Scheduled incremental backup")
			s.scheduleIncrementalBackup()
		}
	}
}

func (s *BackupScheduler) scheduleFullBackup() {
	s.mu.Lock()
	defer s.mu.Unlock()
	
	s.fullBackupTimer = time.NewTimer(s.manager.config.FullBackupInterval)
}

func (s *BackupScheduler) scheduleIncrementalBackup() {
	s.mu.Lock()
	defer s.mu.Unlock()
	
	s.incrementalTimer = time.NewTimer(s.manager.config.IncrementalInterval)
}

// Cleanup routine

func (bm *BackupManager) cleanupRoutine() {
	defer bm.wg.Done()
	
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	
	for {
		select {
		case <-bm.ctx.Done():
			return
			
		case <-ticker.C:
			bm.performCleanup()
		}
	}
}

func (bm *BackupManager) performCleanup() {
	bm.logger.Info("Performing backup cleanup")
	
	// Get all backups
	backups, err := bm.ListBackups()
	if err != nil {
		bm.logger.Error("Failed to list backups", zap.Error(err))
		return
	}
	
	// Sort by timestamp
	// Remove old backups based on retention policy
	cutoffTime := time.Now().AddDate(0, 0, -bm.config.RetentionDays)
	
	for _, backup := range backups {
		if !backup.Timestamp.IsZero() && backup.Timestamp.Before(cutoffTime) {
			// Delete old backup
			if err := bm.deleteBackup(backup.ID); err != nil {
				bm.logger.Error("Failed to delete old backup",
					zap.String("backup_id", backup.ID),
					zap.Error(err),
				)
			} else {
				bm.logger.Info("Deleted old backup",
					zap.String("backup_id", backup.ID),
					zap.Time("timestamp", backup.Timestamp),
				)
			}
		}
	}
}

func (bm *BackupManager) deleteBackup(backupID string) error {
	// Delete local files
	archivePath := filepath.Join(bm.config.LocalPath, fmt.Sprintf("%s.tar.gz", backupID))
	metadataPath := filepath.Join(bm.config.LocalPath, fmt.Sprintf("%s.json", backupID))
	
	os.Remove(archivePath)
	os.Remove(metadataPath)
	
	// Delete from remote if configured
	if bm.remoteStorage != nil {
		remoteArchive := filepath.Join(bm.config.RemotePath, fmt.Sprintf("%s.tar.gz", backupID))
		remoteMetadata := filepath.Join(bm.config.RemotePath, fmt.Sprintf("%s.json", backupID))
		
		bm.remoteStorage.Delete(bm.ctx, remoteArchive)
		bm.remoteStorage.Delete(bm.ctx, remoteMetadata)
	}
	
	return nil
}

// Helper function to generate backup ID
func generateBackupID() string {
	return fmt.Sprintf("backup_%d", time.Now().Unix())
}