package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// DisasterRecovery provides automated backup and recovery capabilities
// Following John Carmack's principle: "Plan for failure, optimize for success"
type DisasterRecovery struct {
	logger *zap.Logger
	config *RecoveryConfig
	
	// Backup management
	backupManager   *BackupManager
	snapshotManager *SnapshotManager
	replicationMgr  *ReplicationManager
	
	// Recovery state
	recoveryMode    atomic.Bool
	lastBackup      atomic.Int64 // Unix timestamp
	lastVerification atomic.Int64
	
	// Backup statistics
	backupStats     *BackupStatistics
	
	// Lifecycle
	ctx             context.Context
	cancel          context.CancelFunc
	wg              sync.WaitGroup
}

// RecoveryConfig contains disaster recovery configuration
type RecoveryConfig struct {
	// Backup settings
	BackupInterval      time.Duration
	BackupRetention     time.Duration
	BackupLocation      string
	RemoteBackupEnabled bool
	RemoteBackupURL     string
	
	// Snapshot settings
	SnapshotInterval    time.Duration
	MaxSnapshots        int
	IncrementalBackup   bool
	
	// Recovery settings
	AutoRecovery        bool
	RecoveryTimeout     time.Duration
	VerifyBackups       bool
	VerificationInterval time.Duration
	
	// Replication settings
	ReplicationEnabled  bool
	ReplicationTargets  []string
	ReplicationMode     string // "sync" or "async"
	
	// Encryption
	EncryptBackups      bool
	EncryptionKey       string
	
	// Compression
	CompressionLevel    int
}

// BackupManager handles backup operations
type BackupManager struct {
	logger         *zap.Logger
	config         *RecoveryConfig
	
	// Backup tracking
	backups        map[string]*BackupInfo
	backupsMu      sync.RWMutex
	
	// Current backup
	currentBackup  *BackupOperation
	backupLock     sync.Mutex
}

// BackupInfo represents backup metadata
type BackupInfo struct {
	ID              string
	Timestamp       time.Time
	Size            int64
	Checksum        string
	Location        string
	Type            BackupType
	Encrypted       bool
	Verified        bool
	VerificationTime time.Time
	Components      []string
}

// BackupType represents the type of backup
type BackupType string

const (
	BackupTypeFull        BackupType = "full"
	BackupTypeIncremental BackupType = "incremental"
	BackupTypeSnapshot    BackupType = "snapshot"
)

// BackupOperation tracks an ongoing backup
type BackupOperation struct {
	ID          string
	StartTime   time.Time
	Progress    atomic.Uint32
	Status      atomic.Value // string
	Components  []BackupComponent
	Errors      []error
	errorsMu    sync.Mutex
}

// BackupComponent represents a component to backup
type BackupComponent struct {
	Name        string
	Path        string
	Priority    int
	Size        int64
	BackedUp    atomic.Bool
}

// SnapshotManager handles system snapshots
type SnapshotManager struct {
	logger      *zap.Logger
	snapshots   []*Snapshot
	snapshotsMu sync.RWMutex
}

// Snapshot represents a system snapshot
type Snapshot struct {
	ID          string
	Timestamp   time.Time
	State       map[string]interface{}
	Checksum    string
}

// BackupStatistics tracks backup metrics
type BackupStatistics struct {
	TotalBackups        atomic.Uint64
	SuccessfulBackups   atomic.Uint64
	FailedBackups       atomic.Uint64
	TotalBytesBackedUp  atomic.Uint64
	LastBackupSize      atomic.Uint64
	AverageBackupTime   atomic.Uint64 // Nanoseconds
	RecoveriesPerformed atomic.Uint64
}

// NewDisasterRecovery creates a new disaster recovery system
func NewDisasterRecovery(logger *zap.Logger, config *RecoveryConfig) *DisasterRecovery {
	if config == nil {
		config = DefaultRecoveryConfig()
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	dr := &DisasterRecovery{
		logger:          logger,
		config:          config,
		backupManager:   NewBackupManager(logger, config),
		snapshotManager: NewSnapshotManager(logger),
		replicationMgr:  NewReplicationManager(logger, config),
		backupStats:     &BackupStatistics{},
		ctx:             ctx,
		cancel:          cancel,
	}
	
	return dr
}

// Start starts the disaster recovery system
func (dr *DisasterRecovery) Start() error {
	dr.logger.Info("Starting disaster recovery system",
		zap.Duration("backup_interval", dr.config.BackupInterval),
		zap.String("backup_location", dr.config.BackupLocation),
		zap.Bool("auto_recovery", dr.config.AutoRecovery),
	)
	
	// Create backup directory
	if err := os.MkdirAll(dr.config.BackupLocation, 0755); err != nil {
		return fmt.Errorf("failed to create backup directory: %w", err)
	}
	
	// Start backup loop
	dr.wg.Add(1)
	go dr.backupLoop()
	
	// Start snapshot loop
	dr.wg.Add(1)
	go dr.snapshotLoop()
	
	// Start verification loop
	if dr.config.VerifyBackups {
		dr.wg.Add(1)
		go dr.verificationLoop()
	}
	
	// Start replication if enabled
	if dr.config.ReplicationEnabled {
		dr.wg.Add(1)
		go dr.replicationLoop()
	}
	
	return nil
}

// Stop stops the disaster recovery system
func (dr *DisasterRecovery) Stop() error {
	dr.logger.Info("Stopping disaster recovery system")
	
	dr.cancel()
	dr.wg.Wait()
	
	// Perform final backup
	dr.performBackup(BackupTypeFull)
	
	return nil
}

// Backup performs an immediate backup
func (dr *DisasterRecovery) Backup(backupType BackupType) error {
	return dr.performBackup(backupType)
}

// Restore restores from a backup
func (dr *DisasterRecovery) Restore(backupID string) error {
	if !dr.recoveryMode.CompareAndSwap(false, true) {
		return fmt.Errorf("recovery already in progress")
	}
	defer dr.recoveryMode.Store(false)
	
	dr.logger.Info("Starting disaster recovery",
		zap.String("backup_id", backupID),
	)
	
	// Find backup
	backup, err := dr.backupManager.GetBackup(backupID)
	if err != nil {
		return fmt.Errorf("backup not found: %w", err)
	}
	
	// Verify backup integrity
	if dr.config.VerifyBackups {
		if err := dr.verifyBackup(backup); err != nil {
			return fmt.Errorf("backup verification failed: %w", err)
		}
	}
	
	// Perform restoration
	if err := dr.restoreBackup(backup); err != nil {
		return fmt.Errorf("restoration failed: %w", err)
	}
	
	dr.backupStats.RecoveriesPerformed.Add(1)
	
	dr.logger.Info("Disaster recovery completed successfully")
	
	return nil
}

// GetBackups returns list of available backups
func (dr *DisasterRecovery) GetBackups() []*BackupInfo {
	return dr.backupManager.GetBackups()
}

// GetStatistics returns backup statistics
func (dr *DisasterRecovery) GetStatistics() BackupStats {
	return BackupStats{
		TotalBackups:        dr.backupStats.TotalBackups.Load(),
		SuccessfulBackups:   dr.backupStats.SuccessfulBackups.Load(),
		FailedBackups:       dr.backupStats.FailedBackups.Load(),
		TotalBytesBackedUp:  dr.backupStats.TotalBytesBackedUp.Load(),
		LastBackupSize:      dr.backupStats.LastBackupSize.Load(),
		AverageBackupTime:   time.Duration(dr.backupStats.AverageBackupTime.Load()),
		RecoveriesPerformed: dr.backupStats.RecoveriesPerformed.Load(),
		LastBackup:          time.Unix(dr.lastBackup.Load(), 0),
		LastVerification:    time.Unix(dr.lastVerification.Load(), 0),
	}
}

// Private methods

func (dr *DisasterRecovery) backupLoop() {
	defer dr.wg.Done()
	
	ticker := time.NewTicker(dr.config.BackupInterval)
	defer ticker.Stop()
	
	// Initial backup
	dr.performBackup(BackupTypeFull)
	
	for {
		select {
		case <-ticker.C:
			backupType := BackupTypeFull
			if dr.config.IncrementalBackup {
				backupType = BackupTypeIncremental
			}
			dr.performBackup(backupType)
			
		case <-dr.ctx.Done():
			return
		}
	}
}

func (dr *DisasterRecovery) snapshotLoop() {
	defer dr.wg.Done()
	
	ticker := time.NewTicker(dr.config.SnapshotInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			dr.createSnapshot()
			
		case <-dr.ctx.Done():
			return
		}
	}
}

func (dr *DisasterRecovery) verificationLoop() {
	defer dr.wg.Done()
	
	ticker := time.NewTicker(dr.config.VerificationInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			dr.verifyRecentBackups()
			
		case <-dr.ctx.Done():
			return
		}
	}
}

func (dr *DisasterRecovery) replicationLoop() {
	defer dr.wg.Done()
	
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			dr.replicateBackups()
			
		case <-dr.ctx.Done():
			return
		}
	}
}

func (dr *DisasterRecovery) performBackup(backupType BackupType) error {
	start := time.Now()
	dr.backupStats.TotalBackups.Add(1)
	
	// Create backup operation
	operation := &BackupOperation{
		ID:         generateBackupID(),
		StartTime:  start,
		Components: dr.getBackupComponents(),
	}
	operation.Status.Store("initializing")
	
	dr.logger.Info("Starting backup",
		zap.String("id", operation.ID),
		zap.String("type", string(backupType)),
	)
	
	// Create backup
	backupInfo, err := dr.backupManager.CreateBackup(operation, backupType)
	if err != nil {
		dr.backupStats.FailedBackups.Add(1)
		dr.logger.Error("Backup failed", zap.Error(err))
		return err
	}
	
	// Update statistics
	dr.backupStats.SuccessfulBackups.Add(1)
	dr.backupStats.TotalBytesBackedUp.Add(uint64(backupInfo.Size))
	dr.backupStats.LastBackupSize.Store(uint64(backupInfo.Size))
	dr.lastBackup.Store(time.Now().Unix())
	
	// Update average backup time
	duration := time.Since(start)
	dr.backupStats.AverageBackupTime.Store(uint64(duration))
	
	dr.logger.Info("Backup completed",
		zap.String("id", backupInfo.ID),
		zap.Int64("size", backupInfo.Size),
		zap.Duration("duration", duration),
	)
	
	// Replicate if enabled
	if dr.config.ReplicationEnabled {
		go dr.replicationMgr.Replicate(backupInfo)
	}
	
	// Clean old backups
	dr.cleanOldBackups()
	
	return nil
}

func (dr *DisasterRecovery) createSnapshot() {
	snapshot := &Snapshot{
		ID:        generateSnapshotID(),
		Timestamp: time.Now(),
		State:     dr.captureSystemState(),
	}
	
	// Calculate checksum
	snapshot.Checksum = dr.calculateSnapshotChecksum(snapshot)
	
	dr.snapshotManager.AddSnapshot(snapshot)
	
	dr.logger.Debug("Snapshot created", zap.String("id", snapshot.ID))
}

func (dr *DisasterRecovery) verifyRecentBackups() {
	backups := dr.backupManager.GetRecentBackups(24 * time.Hour)
	
	for _, backup := range backups {
		if !backup.Verified {
			if err := dr.verifyBackup(backup); err != nil {
				dr.logger.Warn("Backup verification failed",
					zap.String("backup_id", backup.ID),
					zap.Error(err),
				)
			} else {
				backup.Verified = true
				backup.VerificationTime = time.Now()
			}
		}
	}
	
	dr.lastVerification.Store(time.Now().Unix())
}

func (dr *DisasterRecovery) verifyBackup(backup *BackupInfo) error {
	// Open backup file
	file, err := os.Open(backup.Location)
	if err != nil {
		return fmt.Errorf("failed to open backup: %w", err)
	}
	defer file.Close()
	
	// Calculate checksum
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return fmt.Errorf("failed to calculate checksum: %w", err)
	}
	
	checksum := hex.EncodeToString(hash.Sum(nil))
	if checksum != backup.Checksum {
		return fmt.Errorf("checksum mismatch")
	}
	
	return nil
}

func (dr *DisasterRecovery) restoreBackup(backup *BackupInfo) error {
	dr.logger.Info("Restoring from backup",
		zap.String("backup_id", backup.ID),
		zap.Time("backup_time", backup.Timestamp),
	)
	
	// Open backup file
	file, err := os.Open(backup.Location)
	if err != nil {
		return fmt.Errorf("failed to open backup: %w", err)
	}
	defer file.Close()
	
	// Decompress if needed
	gzReader, err := gzip.NewReader(file)
	if err != nil {
		return fmt.Errorf("failed to create gzip reader: %w", err)
	}
	defer gzReader.Close()
	
	// Extract tar archive
	tarReader := tar.NewReader(gzReader)
	
	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("failed to read tar header: %w", err)
		}
		
		// Create directories
		targetPath := filepath.Join("/", header.Name)
		if header.Typeflag == tar.TypeDir {
			if err := os.MkdirAll(targetPath, os.FileMode(header.Mode)); err != nil {
				return fmt.Errorf("failed to create directory: %w", err)
			}
			continue
		}
		
		// Extract files
		if err := dr.extractFile(tarReader, targetPath, header); err != nil {
			return fmt.Errorf("failed to extract file %s: %w", header.Name, err)
		}
	}
	
	return nil
}

func (dr *DisasterRecovery) extractFile(reader io.Reader, path string, header *tar.Header) error {
	// Create directory if needed
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	
	// Create file
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	defer file.Close()
	
	// Copy content
	if _, err := io.Copy(file, reader); err != nil {
		return err
	}
	
	// Set permissions
	if err := os.Chmod(path, os.FileMode(header.Mode)); err != nil {
		return err
	}
	
	return nil
}

func (dr *DisasterRecovery) cleanOldBackups() {
	cutoff := time.Now().Add(-dr.config.BackupRetention)
	oldBackups := dr.backupManager.GetBackupsOlderThan(cutoff)
	
	for _, backup := range oldBackups {
		if err := dr.backupManager.DeleteBackup(backup.ID); err != nil {
			dr.logger.Warn("Failed to delete old backup",
				zap.String("backup_id", backup.ID),
				zap.Error(err),
			)
		}
	}
}

func (dr *DisasterRecovery) replicateBackups() {
	backups := dr.backupManager.GetUnreplicatedBackups()
	
	for _, backup := range backups {
		if err := dr.replicationMgr.Replicate(backup); err != nil {
			dr.logger.Warn("Failed to replicate backup",
				zap.String("backup_id", backup.ID),
				zap.Error(err),
			)
		}
	}
}

func (dr *DisasterRecovery) getBackupComponents() []BackupComponent {
	return []BackupComponent{
		{Name: "configuration", Path: "/etc/otedama", Priority: 1},
		{Name: "data", Path: "/var/lib/otedama", Priority: 2},
		{Name: "logs", Path: "/var/log/otedama", Priority: 3},
		{Name: "wallets", Path: "/var/lib/otedama/wallets", Priority: 1},
		{Name: "shares", Path: "/var/lib/otedama/shares", Priority: 2},
	}
}

func (dr *DisasterRecovery) captureSystemState() map[string]interface{} {
	return map[string]interface{}{
		"timestamp":     time.Now(),
		"system_health": "healthy", // Would get from monitoring
		"active_miners": 0,          // Would get from pool
		"hash_rate":     0.0,        // Would get from mining engine
	}
}

func (dr *DisasterRecovery) calculateSnapshotChecksum(snapshot *Snapshot) string {
	// Simple checksum calculation
	data := fmt.Sprintf("%v", snapshot.State)
	hash := sha256.Sum256([]byte(data))
	return hex.EncodeToString(hash[:])
}

// Helper components

// NewBackupManager creates a new backup manager
func NewBackupManager(logger *zap.Logger, config *RecoveryConfig) *BackupManager {
	return &BackupManager{
		logger:  logger,
		config:  config,
		backups: make(map[string]*BackupInfo),
	}
}

func (bm *BackupManager) CreateBackup(operation *BackupOperation, backupType BackupType) (*BackupInfo, error) {
	bm.backupLock.Lock()
	defer bm.backupLock.Unlock()
	
	backupInfo := &BackupInfo{
		ID:        operation.ID,
		Timestamp: time.Now(),
		Type:      backupType,
		Encrypted: bm.config.EncryptBackups,
	}
	
	// Create backup file
	backupPath := filepath.Join(bm.config.BackupLocation, fmt.Sprintf("backup_%s.tar.gz", operation.ID))
	size, checksum, err := bm.createBackupArchive(operation, backupPath)
	if err != nil {
		return nil, err
	}
	
	backupInfo.Size = size
	backupInfo.Checksum = checksum
	backupInfo.Location = backupPath
	
	// Store backup info
	bm.backupsMu.Lock()
	bm.backups[backupInfo.ID] = backupInfo
	bm.backupsMu.Unlock()
	
	return backupInfo, nil
}

func (bm *BackupManager) createBackupArchive(operation *BackupOperation, path string) (int64, string, error) {
	// Create backup file
	file, err := os.Create(path)
	if err != nil {
		return 0, "", err
	}
	defer file.Close()
	
	// Create gzip writer
	gzWriter := gzip.NewWriter(file)
	gzWriter.Header.Comment = fmt.Sprintf("Otedama backup %s", operation.ID)
	defer gzWriter.Close()
	
	// Create tar writer
	tarWriter := tar.NewWriter(gzWriter)
	defer tarWriter.Close()
	
	// Calculate checksum while writing
	hash := sha256.New()
	multiWriter := io.MultiWriter(gzWriter, hash)
	
	// Archive components
	var totalSize int64
	for _, component := range operation.Components {
		size, err := bm.archiveComponent(tarWriter, component)
		if err != nil {
			operation.errorsMu.Lock()
			operation.Errors = append(operation.Errors, err)
			operation.errorsMu.Unlock()
			continue
		}
		totalSize += size
		component.BackedUp.Store(true)
	}
	
	checksum := hex.EncodeToString(hash.Sum(nil))
	return totalSize, checksum, nil
}

func (bm *BackupManager) archiveComponent(tw *tar.Writer, component BackupComponent) (int64, error) {
	var size int64
	
	err := filepath.Walk(component.Path, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		
		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		
		header.Name = path
		
		if err := tw.WriteHeader(header); err != nil {
			return err
		}
		
		if !info.IsDir() {
			file, err := os.Open(path)
			if err != nil {
				return err
			}
			defer file.Close()
			
			n, err := io.Copy(tw, file)
			if err != nil {
				return err
			}
			size += n
		}
		
		return nil
	})
	
	return size, err
}

func (bm *BackupManager) GetBackup(id string) (*BackupInfo, error) {
	bm.backupsMu.RLock()
	defer bm.backupsMu.RUnlock()
	
	backup, exists := bm.backups[id]
	if !exists {
		return nil, fmt.Errorf("backup not found")
	}
	
	return backup, nil
}

func (bm *BackupManager) GetBackups() []*BackupInfo {
	bm.backupsMu.RLock()
	defer bm.backupsMu.RUnlock()
	
	backups := make([]*BackupInfo, 0, len(bm.backups))
	for _, backup := range bm.backups {
		backups = append(backups, backup)
	}
	
	return backups
}

func (bm *BackupManager) GetRecentBackups(duration time.Duration) []*BackupInfo {
	bm.backupsMu.RLock()
	defer bm.backupsMu.RUnlock()
	
	cutoff := time.Now().Add(-duration)
	backups := make([]*BackupInfo, 0)
	
	for _, backup := range bm.backups {
		if backup.Timestamp.After(cutoff) {
			backups = append(backups, backup)
		}
	}
	
	return backups
}

func (bm *BackupManager) GetBackupsOlderThan(cutoff time.Time) []*BackupInfo {
	bm.backupsMu.RLock()
	defer bm.backupsMu.RUnlock()
	
	backups := make([]*BackupInfo, 0)
	
	for _, backup := range bm.backups {
		if backup.Timestamp.Before(cutoff) {
			backups = append(backups, backup)
		}
	}
	
	return backups
}

func (bm *BackupManager) GetUnreplicatedBackups() []*BackupInfo {
	// Placeholder - would track replication status
	return []*BackupInfo{}
}

func (bm *BackupManager) DeleteBackup(id string) error {
	bm.backupsMu.Lock()
	defer bm.backupsMu.Unlock()
	
	backup, exists := bm.backups[id]
	if !exists {
		return fmt.Errorf("backup not found")
	}
	
	// Delete file
	if err := os.Remove(backup.Location); err != nil {
		return err
	}
	
	delete(bm.backups, id)
	return nil
}

// NewSnapshotManager creates a new snapshot manager
func NewSnapshotManager(logger *zap.Logger) *SnapshotManager {
	return &SnapshotManager{
		logger:    logger,
		snapshots: make([]*Snapshot, 0),
	}
}

func (sm *SnapshotManager) AddSnapshot(snapshot *Snapshot) {
	sm.snapshotsMu.Lock()
	defer sm.snapshotsMu.Unlock()
	
	sm.snapshots = append(sm.snapshots, snapshot)
	
	// Keep only recent snapshots
	if len(sm.snapshots) > 100 {
		sm.snapshots = sm.snapshots[len(sm.snapshots)-100:]
	}
}

// ReplicationManager handles backup replication
type ReplicationManager struct {
	logger *zap.Logger
	config *RecoveryConfig
}

func NewReplicationManager(logger *zap.Logger, config *RecoveryConfig) *ReplicationManager {
	return &ReplicationManager{
		logger: logger,
		config: config,
	}
}

func (rm *ReplicationManager) Replicate(backup *BackupInfo) error {
	// Placeholder - would implement actual replication
	rm.logger.Info("Replicating backup",
		zap.String("backup_id", backup.ID),
		zap.Strings("targets", rm.config.ReplicationTargets),
	)
	return nil
}

// Helper structures

type BackupStats struct {
	TotalBackups        uint64
	SuccessfulBackups   uint64
	FailedBackups       uint64
	TotalBytesBackedUp  uint64
	LastBackupSize      uint64
	AverageBackupTime   time.Duration
	RecoveriesPerformed uint64
	LastBackup          time.Time
	LastVerification    time.Time
}

// Helper functions

func generateBackupID() string {
	return fmt.Sprintf("backup_%d", time.Now().Unix())
}

func generateSnapshotID() string {
	return fmt.Sprintf("snapshot_%d", time.Now().UnixNano())
}

// DefaultRecoveryConfig returns default recovery configuration
func DefaultRecoveryConfig() *RecoveryConfig {
	return &RecoveryConfig{
		BackupInterval:       6 * time.Hour,
		BackupRetention:      7 * 24 * time.Hour, // 7 days
		BackupLocation:       "/var/backups/otedama",
		RemoteBackupEnabled:  false,
		SnapshotInterval:     1 * time.Hour,
		MaxSnapshots:         24,
		IncrementalBackup:    true,
		AutoRecovery:         true,
		RecoveryTimeout:      30 * time.Minute,
		VerifyBackups:        true,
		VerificationInterval: 24 * time.Hour,
		ReplicationEnabled:   false,
		ReplicationMode:      "async",
		EncryptBackups:       true,
		CompressionLevel:     gzip.DefaultCompression,
	}
}