package backup

import (
	"compress/gzip"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// RedundantBackup implements a redundant data backup system
type RedundantBackup struct {
	logger         *zap.Logger
	config         BackupConfig
	storages       []BackupStorage
	scheduler      *BackupScheduler
	validator      *BackupValidator
	replicator     *DataReplicator
	encryptor      *BackupEncryptor
	stats          *BackupStats
	activeBackups  sync.Map // backupID -> *BackupJob
	mu             sync.RWMutex
}

// Import BackupConfig from types.go

// StorageLocation represents a backup storage location
type StorageLocation struct {
	ID         string
	Type       StorageType
	Path       string
	Endpoint   string
	Credential StorageCredential
	Priority   int
	Available  bool
}

// StorageType represents the type of storage
type StorageType string

const (
	StorageTypeLocal  StorageType = "local"
	StorageTypeS3     StorageType = "s3"
	StorageTypeIPFS   StorageType = "ipfs"
	StorageTypeFTP    StorageType = "ftp"
	StorageTypeCloud  StorageType = "cloud"
)

// StorageCredential contains storage credentials
type StorageCredential struct {
	AccessKey string
	SecretKey string
	Token     string
}

// BackupStorage interface for different storage backends
type BackupStorage interface {
	Store(ctx context.Context, data *BackupData) error
	Retrieve(ctx context.Context, id string) (*BackupData, error)
	Delete(ctx context.Context, id string) error
	List(ctx context.Context) ([]*BackupMetadata, error)
	Verify(ctx context.Context, id string) error
	GetInfo() StorageInfo
}

// BackupData represents data to be backed up
type BackupData struct {
	ID          string
	Type        string
	Data        []byte
	Checksum    string
	Compressed  bool
	Encrypted   bool
	Timestamp   time.Time
	Metadata    map[string]string
}

// BackupMetadata represents backup metadata
type BackupMetadata struct {
	ID           string
	Type         string
	Size         int64
	Checksum     string
	Timestamp    time.Time
	StorageIDs   []string
	Status       BackupStatus
	VerifyStatus VerifyStatus
}

// BackupStatus represents backup status
type BackupStatus string

const (
	BackupStatusPending   BackupStatus = "pending"
	BackupStatusInProgress BackupStatus = "in_progress"
	BackupStatusCompleted BackupStatus = "completed"
	BackupStatusFailed    BackupStatus = "failed"
)

// VerifyStatus represents verification status
type VerifyStatus string

const (
	VerifyStatusPending  VerifyStatus = "pending"
	VerifyStatusVerified VerifyStatus = "verified"
	VerifyStatusFailed   VerifyStatus = "failed"
)

// BackupJob represents an active backup job
type BackupJob struct {
	ID            string
	Type          string
	Status        BackupStatus
	Progress      atomic.Int64
	TotalSize     int64
	StartTime     time.Time
	EndTime       time.Time
	Errors        []error
	StorageStatus map[string]bool
	mu            sync.RWMutex
}

// BackupScheduler schedules automatic backups
type BackupScheduler struct {
	schedules   []*BackupSchedule
	activeTasks sync.Map
	mu          sync.RWMutex
}

// BackupSchedule represents a backup schedule
type BackupSchedule struct {
	ID         string
	DataType   string
	Interval   time.Duration
	NextRun    time.Time
	LastRun    time.Time
	Enabled    bool
}

// BackupValidator validates backup integrity
type BackupValidator struct {
	checksums sync.Map // backupID -> checksum
}

// DataReplicator handles data replication across storages
type DataReplicator struct {
	logger         *zap.Logger
	redundancy     int
	activeReplicas sync.Map
}

// BackupEncryptor handles backup encryption
type BackupEncryptor struct {
	key    []byte
	cipher cipher.AEAD
}

// StorageInfo contains storage information
type StorageInfo struct {
	ID          string
	Type        StorageType
	Available   bool
	TotalSpace  int64
	UsedSpace   int64
	FreeSpace   int64
	Latency     time.Duration
}

// BackupStats tracks backup statistics
type BackupStats struct {
	TotalBackups       atomic.Uint64
	SuccessfulBackups  atomic.Uint64
	FailedBackups      atomic.Uint64
	TotalDataBacked    atomic.Uint64 // bytes
	TotalDataRestored  atomic.Uint64 // bytes
	CompressionRatio   atomic.Uint64 // percentage * 100
	AverageBackupTime  atomic.Int64  // microseconds
	LastBackupTime     atomic.Value  // time.Time
	StorageUtilization sync.Map      // storageID -> percentage
}

// NewRedundantBackup creates a new redundant backup system
func NewRedundantBackup(config BackupConfig, logger *zap.Logger) (*RedundantBackup, error) {
	if config.RedundancyLevel == 0 {
		config.RedundancyLevel = 3
	}
	if config.BackupInterval == 0 {
		config.BackupInterval = 24 * time.Hour
	}
	if config.RetentionPeriod == 0 {
		config.RetentionPeriod = 30 * 24 * time.Hour
	}
	if config.ChunkSize == 0 {
		config.ChunkSize = 64 * 1024 * 1024 // 64MB
	}
	if config.ConcurrentBackups == 0 {
		config.ConcurrentBackups = 3
	}

	rb := &RedundantBackup{
		logger:     logger,
		config:     config,
		storages:   make([]BackupStorage, 0),
		scheduler:  NewBackupScheduler(),
		validator:  NewBackupValidator(),
		replicator: NewDataReplicator(logger, config.RedundancyLevel),
		stats:      &BackupStats{},
	}

	// Initialize encryptor if enabled
	if config.EncryptionEnabled {
		encryptor, err := NewBackupEncryptor(config.EncryptionKey)
		if err != nil {
			return nil, fmt.Errorf("failed to initialize encryptor: %w", err)
		}
		rb.encryptor = encryptor
	}

	// Initialize storage backends
	for _, location := range config.StorageLocations {
		storage, err := rb.createStorage(location)
		if err != nil {
			logger.Warn("Failed to initialize storage",
				zap.String("id", location.ID),
				zap.Error(err))
			continue
		}
		rb.storages = append(rb.storages, storage)
	}

	if len(rb.storages) == 0 {
		return nil, fmt.Errorf("no storage backends available")
	}

	return rb, nil
}

// createStorage creates a storage backend
func (rb *RedundantBackup) createStorage(location StorageLocation) (BackupStorage, error) {
	switch location.Type {
	case StorageTypeLocal:
		return NewLocalStorage(location)
	case StorageTypeS3:
		return NewS3Storage(location)
	case StorageTypeIPFS:
		return NewIPFSStorage(location)
	default:
		return nil, fmt.Errorf("unsupported storage type: %s", location.Type)
	}
}

// Start starts the backup system
func (rb *RedundantBackup) Start(ctx context.Context) error {
	rb.logger.Info("Starting redundant backup system",
		zap.Int("storages", len(rb.storages)),
		zap.Int("redundancy", rb.config.RedundancyLevel))

	// Start scheduler
	go rb.scheduler.Start(ctx, rb.performScheduledBackup)

	// Start cleanup routine
	go rb.cleanupRoutine(ctx)

	// Start verification routine
	go rb.verificationRoutine(ctx)

	return nil
}

// Backup performs a backup of data
func (rb *RedundantBackup) Backup(ctx context.Context, dataType string, data []byte) (*BackupMetadata, error) {
	job := &BackupJob{
		ID:            rb.generateBackupID(),
		Type:          dataType,
		Status:        BackupStatusInProgress,
		TotalSize:     int64(len(data)),
		StartTime:     time.Now(),
		StorageStatus: make(map[string]bool),
	}

	// Store active job
	rb.activeBackups.Store(job.ID, job)
	defer rb.activeBackups.Delete(job.ID)

	// Prepare backup data
	backupData := &BackupData{
		ID:        job.ID,
		Type:      dataType,
		Data:      data,
		Timestamp: time.Now(),
		Metadata:  make(map[string]string),
	}

	// Calculate checksum
	backupData.Checksum = rb.calculateChecksum(data)

	// Compress if enabled
	if rb.config.CompressionEnabled {
		compressed, err := rb.compressData(data)
		if err != nil {
			rb.logger.Warn("Compression failed", zap.Error(err))
		} else {
			backupData.Data = compressed
			backupData.Compressed = true
			
			// Update compression ratio
			ratio := uint64(float64(len(compressed)) / float64(len(data)) * 100)
			rb.stats.CompressionRatio.Store(ratio)
		}
	}

	// Encrypt if enabled
	if rb.config.EncryptionEnabled && rb.encryptor != nil {
		encrypted, err := rb.encryptor.Encrypt(backupData.Data)
		if err != nil {
			return nil, fmt.Errorf("encryption failed: %w", err)
		}
		backupData.Data = encrypted
		backupData.Encrypted = true
	}

	// Replicate to multiple storages
	results := rb.replicator.Replicate(ctx, backupData, rb.storages)
	
	// Check results
	successCount := 0
	var storageIDs []string
	for storageID, result := range results {
		if result.Success {
			successCount++
			storageIDs = append(storageIDs, storageID)
			job.StorageStatus[storageID] = true
		} else {
			job.Errors = append(job.Errors, result.Error)
			rb.logger.Error("Backup to storage failed",
				zap.String("storage", storageID),
				zap.Error(result.Error))
		}
	}

	// Check if minimum redundancy achieved
	if successCount < rb.config.RedundancyLevel {
		job.Status = BackupStatusFailed
		rb.stats.FailedBackups.Add(1)
		return nil, fmt.Errorf("insufficient redundancy: %d/%d storages succeeded",
			successCount, rb.config.RedundancyLevel)
	}

	// Create metadata
	metadata := &BackupMetadata{
		ID:         job.ID,
		Type:       dataType,
		Size:       int64(len(backupData.Data)),
		Checksum:   backupData.Checksum,
		Timestamp:  backupData.Timestamp,
		StorageIDs: storageIDs,
		Status:     BackupStatusCompleted,
	}

	// Verify if configured
	if rb.config.VerifyAfterBackup {
		if err := rb.verifyBackup(ctx, metadata); err != nil {
			rb.logger.Warn("Backup verification failed", zap.Error(err))
			metadata.VerifyStatus = VerifyStatusFailed
		} else {
			metadata.VerifyStatus = VerifyStatusVerified
		}
	}

	// Update statistics
	job.Status = BackupStatusCompleted
	job.EndTime = time.Now()
	rb.stats.SuccessfulBackups.Add(1)
	rb.stats.TotalBackups.Add(1)
	rb.stats.TotalDataBacked.Add(uint64(len(data)))
	rb.stats.LastBackupTime.Store(time.Now())
	
	backupTime := job.EndTime.Sub(job.StartTime).Microseconds()
	rb.stats.AverageBackupTime.Store(backupTime)

	rb.logger.Info("Backup completed successfully",
		zap.String("id", job.ID),
		zap.String("type", dataType),
		zap.Int64("size", metadata.Size),
		zap.Int("storages", successCount),
		zap.Duration("duration", job.EndTime.Sub(job.StartTime)))

	return metadata, nil
}

// Restore restores data from backup
func (rb *RedundantBackup) Restore(ctx context.Context, backupID string) ([]byte, error) {
	rb.logger.Info("Starting restore",
		zap.String("backup_id", backupID))

	startTime := time.Now()

	// Try storages in priority order
	var lastErr error
	for _, storage := range rb.getStoragesByPriority() {
		// Retrieve backup data
		backupData, err := storage.Retrieve(ctx, backupID)
		if err != nil {
			lastErr = err
			rb.logger.Warn("Restore from storage failed",
				zap.String("storage", storage.GetInfo().ID),
				zap.Error(err))
			continue
		}

		// Decrypt if needed
		data := backupData.Data
		if backupData.Encrypted && rb.encryptor != nil {
			decrypted, err := rb.encryptor.Decrypt(data)
			if err != nil {
				lastErr = fmt.Errorf("decryption failed: %w", err)
				continue
			}
			data = decrypted
		}

		// Decompress if needed
		if backupData.Compressed {
			decompressed, err := rb.decompressData(data)
			if err != nil {
				lastErr = fmt.Errorf("decompression failed: %w", err)
				continue
			}
			data = decompressed
		}

		// Verify checksum
		checksum := rb.calculateChecksum(data)
		if checksum != backupData.Checksum {
			lastErr = fmt.Errorf("checksum mismatch")
			continue
		}

		// Update statistics
		rb.stats.TotalDataRestored.Add(uint64(len(data)))

		rb.logger.Info("Restore completed successfully",
			zap.String("backup_id", backupID),
			zap.Int("size", len(data)),
			zap.Duration("duration", time.Since(startTime)))

		return data, nil
	}

	return nil, fmt.Errorf("restore failed from all storages: %v", lastErr)
}

// List lists all backups
func (rb *RedundantBackup) List(ctx context.Context) ([]*BackupMetadata, error) {
	metadataMap := make(map[string]*BackupMetadata)

	// Collect from all storages
	for _, storage := range rb.storages {
		list, err := storage.List(ctx)
		if err != nil {
			rb.logger.Warn("Failed to list from storage",
				zap.String("storage", storage.GetInfo().ID),
				zap.Error(err))
			continue
		}

		for _, metadata := range list {
			if existing, ok := metadataMap[metadata.ID]; ok {
				// Merge storage IDs
				existing.StorageIDs = append(existing.StorageIDs, metadata.StorageIDs...)
			} else {
				metadataMap[metadata.ID] = metadata
			}
		}
	}

	// Convert to slice
	var result []*BackupMetadata
	for _, metadata := range metadataMap {
		result = append(result, metadata)
	}

	// Sort by timestamp
	sort.Slice(result, func(i, j int) bool {
		return result[i].Timestamp.After(result[j].Timestamp)
	})

	return result, nil
}

// verifyBackup verifies backup integrity
func (rb *RedundantBackup) verifyBackup(ctx context.Context, metadata *BackupMetadata) error {
	verified := 0
	
	for _, storageID := range metadata.StorageIDs {
		storage := rb.getStorageByID(storageID)
		if storage == nil {
			continue
		}

		if err := storage.Verify(ctx, metadata.ID); err != nil {
			rb.logger.Warn("Verification failed",
				zap.String("storage", storageID),
				zap.Error(err))
		} else {
			verified++
		}
	}

	if verified < rb.config.RedundancyLevel {
		return fmt.Errorf("insufficient verified copies: %d/%d",
			verified, rb.config.RedundancyLevel)
	}

	return nil
}

// performScheduledBackup performs a scheduled backup
func (rb *RedundantBackup) performScheduledBackup(schedule *BackupSchedule) error {
	// This would be implemented based on specific data types
	rb.logger.Info("Performing scheduled backup",
		zap.String("type", schedule.DataType))
	
	// Example: backup configuration
	if schedule.DataType == "config" {
		// Read configuration data
		// data := readConfigData()
		// _, err := rb.Backup(context.Background(), "config", data)
		// return err
	}
	
	return nil
}

// cleanupRoutine periodically cleans up old backups
func (rb *RedundantBackup) cleanupRoutine(ctx context.Context) {
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			rb.cleanupOldBackups(ctx)
		}
	}
}

// cleanupOldBackups removes backups older than retention period
func (rb *RedundantBackup) cleanupOldBackups(ctx context.Context) {
	cutoff := time.Now().Add(-rb.config.RetentionPeriod)
	
	list, err := rb.List(ctx)
	if err != nil {
		rb.logger.Error("Failed to list backups for cleanup", zap.Error(err))
		return
	}

	deleted := 0
	for _, metadata := range list {
		if metadata.Timestamp.Before(cutoff) {
			for _, storage := range rb.storages {
				if err := storage.Delete(ctx, metadata.ID); err != nil {
					rb.logger.Warn("Failed to delete old backup",
						zap.String("id", metadata.ID),
						zap.Error(err))
				}
			}
			deleted++
		}
	}

	if deleted > 0 {
		rb.logger.Info("Cleaned up old backups",
			zap.Int("deleted", deleted))
	}
}

// verificationRoutine periodically verifies backup integrity
func (rb *RedundantBackup) verificationRoutine(ctx context.Context) {
	ticker := time.NewTicker(7 * 24 * time.Hour) // Weekly
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			rb.verifyAllBackups(ctx)
		}
	}
}

// verifyAllBackups verifies all backups
func (rb *RedundantBackup) verifyAllBackups(ctx context.Context) {
	list, err := rb.List(ctx)
	if err != nil {
		rb.logger.Error("Failed to list backups for verification", zap.Error(err))
		return
	}

	verified := 0
	failed := 0

	for _, metadata := range list {
		if err := rb.verifyBackup(ctx, metadata); err != nil {
			failed++
			rb.logger.Error("Backup verification failed",
				zap.String("id", metadata.ID),
				zap.Error(err))
		} else {
			verified++
		}
	}

	rb.logger.Info("Backup verification completed",
		zap.Int("verified", verified),
		zap.Int("failed", failed))
}

// Helper methods

func (rb *RedundantBackup) generateBackupID() string {
	return fmt.Sprintf("backup_%d", time.Now().UnixNano())
}

func (rb *RedundantBackup) calculateChecksum(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func (rb *RedundantBackup) compressData(data []byte) ([]byte, error) {
	var buf []byte
	writer := gzip.NewWriter(&simpleBuffer{data: &buf})
	_, err := writer.Write(data)
	if err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buf, nil
}

func (rb *RedundantBackup) decompressData(data []byte) ([]byte, error) {
	reader, err := gzip.NewReader(&simpleBuffer{data: &data, offset: 0})
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	
	return io.ReadAll(reader)
}

func (rb *RedundantBackup) getStorageByID(id string) BackupStorage {
	for _, storage := range rb.storages {
		if storage.GetInfo().ID == id {
			return storage
		}
	}
	return nil
}

func (rb *RedundantBackup) getStoragesByPriority() []BackupStorage {
	// Sort by priority if configured
	sorted := make([]BackupStorage, len(rb.storages))
	copy(sorted, rb.storages)
	
	// Simple priority sorting (would be more sophisticated in production)
	return sorted
}

// GetStats returns backup statistics
func (rb *RedundantBackup) GetStats() map[string]interface{} {
	stats := map[string]interface{}{
		"total_backups":       rb.stats.TotalBackups.Load(),
		"successful_backups":  rb.stats.SuccessfulBackups.Load(),
		"failed_backups":      rb.stats.FailedBackups.Load(),
		"total_data_backed":   rb.stats.TotalDataBacked.Load(),
		"total_data_restored": rb.stats.TotalDataRestored.Load(),
		"compression_ratio":   rb.stats.CompressionRatio.Load(),
		"average_backup_time": rb.stats.AverageBackupTime.Load(),
		"storage_count":       len(rb.storages),
		"redundancy_level":    rb.config.RedundancyLevel,
	}

	// Add storage utilization
	utilization := make(map[string]interface{})
	rb.stats.StorageUtilization.Range(func(key, value interface{}) bool {
		utilization[key.(string)] = value
		return true
	})
	stats["storage_utilization"] = utilization

	// Add last backup time
	if lastBackup := rb.stats.LastBackupTime.Load(); lastBackup != nil {
		stats["last_backup_time"] = lastBackup.(time.Time)
	}

	return stats
}

// Component implementations

// NewBackupScheduler creates a new backup scheduler
func NewBackupScheduler() *BackupScheduler {
	return &BackupScheduler{
		schedules: make([]*BackupSchedule, 0),
	}
}

func (bs *BackupScheduler) Start(ctx context.Context, handler func(*BackupSchedule) error) {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			bs.checkSchedules(handler)
		}
	}
}

func (bs *BackupScheduler) checkSchedules(handler func(*BackupSchedule) error) {
	bs.mu.RLock()
	defer bs.mu.RUnlock()

	now := time.Now()
	for _, schedule := range bs.schedules {
		if schedule.Enabled && now.After(schedule.NextRun) {
			go func(s *BackupSchedule) {
				if err := handler(s); err == nil {
					s.LastRun = now
					s.NextRun = now.Add(s.Interval)
				}
			}(schedule)
		}
	}
}

// NewBackupValidator creates a new backup validator
func NewBackupValidator() *BackupValidator {
	return &BackupValidator{}
}

// NewDataReplicator creates a new data replicator
func NewDataReplicator(logger *zap.Logger, redundancy int) *DataReplicator {
	return &DataReplicator{
		logger:     logger,
		redundancy: redundancy,
	}
}

// ReplicationResult represents replication result
type ReplicationResult struct {
	StorageID string
	Success   bool
	Error     error
}

func (dr *DataReplicator) Replicate(ctx context.Context, data *BackupData, storages []BackupStorage) map[string]ReplicationResult {
	results := make(map[string]ReplicationResult)
	var wg sync.WaitGroup

	for _, storage := range storages {
		wg.Add(1)
		go func(s BackupStorage) {
			defer wg.Done()
			
			info := s.GetInfo()
			err := s.Store(ctx, data)
			results[info.ID] = ReplicationResult{
				StorageID: info.ID,
				Success:   err == nil,
				Error:     err,
			}
		}(storage)
	}

	wg.Wait()
	return results
}

// NewBackupEncryptor creates a new backup encryptor
func NewBackupEncryptor(key []byte) (*BackupEncryptor, error) {
	if len(key) != 32 {
		// Generate key from provided key
		hash := sha256.Sum256(key)
		key = hash[:]
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	return &BackupEncryptor{
		key:    key,
		cipher: gcm,
	}, nil
}

func (be *BackupEncryptor) Encrypt(data []byte) ([]byte, error) {
	nonce := make([]byte, be.cipher.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}

	return be.cipher.Seal(nonce, nonce, data, nil), nil
}

func (be *BackupEncryptor) Decrypt(data []byte) ([]byte, error) {
	if len(data) < be.cipher.NonceSize() {
		return nil, fmt.Errorf("ciphertext too short")
	}

	nonce, ciphertext := data[:be.cipher.NonceSize()], data[be.cipher.NonceSize():]
	return be.cipher.Open(nil, nonce, ciphertext, nil)
}

// Storage implementations

// LocalStorage implements local file storage
type LocalStorage struct {
	location StorageLocation
	basePath string
}

func NewLocalStorage(location StorageLocation) (*LocalStorage, error) {
	// Create directory if not exists
	if err := os.MkdirAll(location.Path, 0755); err != nil {
		return nil, err
	}

	return &LocalStorage{
		location: location,
		basePath: location.Path,
	}, nil
}

func (ls *LocalStorage) Store(ctx context.Context, data *BackupData) error {
	path := filepath.Join(ls.basePath, data.ID)
	
	// Marshal backup data
	encoded, err := json.Marshal(data)
	if err != nil {
		return err
	}

	return os.WriteFile(path, encoded, 0644)
}

func (ls *LocalStorage) Retrieve(ctx context.Context, id string) (*BackupData, error) {
	path := filepath.Join(ls.basePath, id)
	
	encoded, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var data BackupData
	if err := json.Unmarshal(encoded, &data); err != nil {
		return nil, err
	}

	return &data, nil
}

func (ls *LocalStorage) Delete(ctx context.Context, id string) error {
	path := filepath.Join(ls.basePath, id)
	return os.Remove(path)
}

func (ls *LocalStorage) List(ctx context.Context) ([]*BackupMetadata, error) {
	entries, err := os.ReadDir(ls.basePath)
	if err != nil {
		return nil, err
	}

	var result []*BackupMetadata
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}

		data, err := ls.Retrieve(ctx, entry.Name())
		if err != nil {
			continue
		}

		metadata := &BackupMetadata{
			ID:         data.ID,
			Type:       data.Type,
			Size:       int64(len(data.Data)),
			Checksum:   data.Checksum,
			Timestamp:  data.Timestamp,
			StorageIDs: []string{ls.location.ID},
			Status:     BackupStatusCompleted,
		}
		result = append(result, metadata)
	}

	return result, nil
}

func (ls *LocalStorage) Verify(ctx context.Context, id string) error {
	_, err := ls.Retrieve(ctx, id)
	return err
}

func (ls *LocalStorage) GetInfo() StorageInfo {
	// Get filesystem stats
	var stat os.FileInfo
	var totalSpace, freeSpace int64
	
	if info, err := os.Stat(ls.basePath); err == nil {
		stat = info
	}

	return StorageInfo{
		ID:         ls.location.ID,
		Type:       ls.location.Type,
		Available:  stat != nil,
		TotalSpace: totalSpace,
		FreeSpace:  freeSpace,
		UsedSpace:  totalSpace - freeSpace,
	}
}

// S3Storage implements S3 storage (placeholder)
type S3Storage struct {
	location StorageLocation
}

func NewS3Storage(location StorageLocation) (*S3Storage, error) {
	// Would initialize S3 client here
	return &S3Storage{location: location}, nil
}

func (s3 *S3Storage) Store(ctx context.Context, data *BackupData) error {
	// S3 implementation
	return fmt.Errorf("S3 storage not implemented")
}

func (s3 *S3Storage) Retrieve(ctx context.Context, id string) (*BackupData, error) {
	return nil, fmt.Errorf("S3 storage not implemented")
}

func (s3 *S3Storage) Delete(ctx context.Context, id string) error {
	return fmt.Errorf("S3 storage not implemented")
}

func (s3 *S3Storage) List(ctx context.Context) ([]*BackupMetadata, error) {
	return nil, fmt.Errorf("S3 storage not implemented")
}

func (s3 *S3Storage) Verify(ctx context.Context, id string) error {
	return fmt.Errorf("S3 storage not implemented")
}

func (s3 *S3Storage) GetInfo() StorageInfo {
	return StorageInfo{
		ID:        s3.location.ID,
		Type:      s3.location.Type,
		Available: false,
	}
}

// IPFSStorage implements IPFS storage (placeholder)
type IPFSStorage struct {
	location StorageLocation
}

func NewIPFSStorage(location StorageLocation) (*IPFSStorage, error) {
	// Would initialize IPFS client here
	return &IPFSStorage{location: location}, nil
}

func (ipfs *IPFSStorage) Store(ctx context.Context, data *BackupData) error {
	return fmt.Errorf("IPFS storage not implemented")
}

func (ipfs *IPFSStorage) Retrieve(ctx context.Context, id string) (*BackupData, error) {
	return nil, fmt.Errorf("IPFS storage not implemented")
}

func (ipfs *IPFSStorage) Delete(ctx context.Context, id string) error {
	return fmt.Errorf("IPFS storage not implemented")
}

func (ipfs *IPFSStorage) List(ctx context.Context) ([]*BackupMetadata, error) {
	return nil, fmt.Errorf("IPFS storage not implemented")
}

func (ipfs *IPFSStorage) Verify(ctx context.Context, id string) error {
	return fmt.Errorf("IPFS storage not implemented")
}

func (ipfs *IPFSStorage) GetInfo() StorageInfo {
	return StorageInfo{
		ID:        ipfs.location.ID,
		Type:      ipfs.location.Type,
		Available: false,
	}
}

// Helper types

type simpleBuffer struct {
	data   *[]byte
	offset int
}

func (b *simpleBuffer) Write(p []byte) (n int, err error) {
	*b.data = append(*b.data, p...)
	return len(p), nil
}

func (b *simpleBuffer) Read(p []byte) (n int, err error) {
	if b.offset >= len(*b.data) {
		return 0, io.EOF
	}
	n = copy(p, (*b.data)[b.offset:])
	b.offset += n
	return n, nil
}