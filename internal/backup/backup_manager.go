package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// BackupManager handles automatic backups and recovery
type BackupManager struct {
	logger *zap.Logger
	config BackupConfig
	
	// State
	running      atomic.Bool
	lastBackup   atomic.Value // time.Time
	backupCount  atomic.Uint64
	
	// Backup storage
	storage      BackupStorage
	
	// Encryption
	encryptionKey []byte
	
	// Control
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// BackupConfig configures backup behavior
type BackupConfig struct {
	Enabled           bool          `yaml:"enabled"`
	Interval          time.Duration `yaml:"interval"`
	RetentionDays     int           `yaml:"retention_days"`
	BackupDir         string        `yaml:"backup_dir"`
	
	// Backup types
	BackupConfig      bool          `yaml:"backup_config"`
	BackupWallets     bool          `yaml:"backup_wallets"`
	BackupDatabase    bool          `yaml:"backup_database"`
	BackupLogs        bool          `yaml:"backup_logs"`
	BackupSharechain  bool          `yaml:"backup_sharechain"`
	
	// Encryption
	EncryptBackups    bool          `yaml:"encrypt_backups"`
	EncryptionKeyFile string        `yaml:"encryption_key_file"`
	
	// Remote backup
	RemoteEnabled     bool          `yaml:"remote_enabled"`
	RemoteType        string        `yaml:"remote_type"` // s3, ftp, sftp
	RemoteConfig      RemoteConfig  `yaml:"remote_config"`
	
	// Advanced
	Compression       string        `yaml:"compression"` // gzip, zstd, none
	MaxBackupSize     int64         `yaml:"max_backup_size"` // MB
	Incremental       bool          `yaml:"incremental"`
}

// RemoteConfig configures remote backup storage
type RemoteConfig struct {
	Host        string `yaml:"host"`
	Port        int    `yaml:"port"`
	Username    string `yaml:"username"`
	Password    string `yaml:"password"`
	Bucket      string `yaml:"bucket"`
	Path        string `yaml:"path"`
	Region      string `yaml:"region"`
}

// BackupStorage interface for backup storage backends
type BackupStorage interface {
	Store(backup *Backup) error
	Retrieve(id string) (*Backup, error)
	List() ([]BackupInfo, error)
	Delete(id string) error
	Cleanup(retentionDays int) error
}

// Backup represents a backup
type Backup struct {
	ID          string
	Timestamp   time.Time
	Type        string // full, incremental
	Size        int64
	Checksum    string
	Encrypted   bool
	Metadata    BackupMetadata
	Data        io.Reader
}

// BackupMetadata contains backup metadata
type BackupMetadata struct {
	Version     string
	Components  []string
	Config      map[string]interface{}
	Stats       BackupStats
}

// BackupStats contains backup statistics
type BackupStats struct {
	FilesCount      int
	UncompressedSize int64
	CompressedSize   int64
	Duration        time.Duration
}

// BackupInfo contains basic backup information
type BackupInfo struct {
	ID          string
	Timestamp   time.Time
	Type        string
	Size        int64
	Components  []string
}

// RestoreOptions configures restore behavior
type RestoreOptions struct {
	Components      []string // Specific components to restore
	OverwriteConfig bool
	RestorePoint    time.Time
	DryRun          bool
}

// NewBackupManager creates a new backup manager
func NewBackupManager(logger *zap.Logger, config BackupConfig) (*BackupManager, error) {
	ctx, cancel := context.WithCancel(context.Background())
	
	bm := &BackupManager{
		logger: logger,
		config: config,
		ctx:    ctx,
		cancel: cancel,
	}
	
	// Initialize storage
	storage, err := bm.initializeStorage()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("failed to initialize storage: %w", err)
	}
	bm.storage = storage
	
	// Load encryption key if enabled
	if config.EncryptBackups {
		key, err := bm.loadEncryptionKey()
		if err != nil {
			cancel()
			return nil, fmt.Errorf("failed to load encryption key: %w", err)
		}
		bm.encryptionKey = key
	}
	
	// Set initial state
	bm.lastBackup.Store(time.Time{})
	
	return bm, nil
}

// Start begins automatic backups
func (bm *BackupManager) Start() error {
	if !bm.running.CompareAndSwap(false, true) {
		return fmt.Errorf("backup manager already running")
	}
	
	bm.logger.Info("Starting backup manager",
		zap.Duration("interval", bm.config.Interval),
		zap.Int("retention_days", bm.config.RetentionDays),
		zap.Bool("encryption", bm.config.EncryptBackups),
		zap.Bool("remote", bm.config.RemoteEnabled),
	)
	
	// Start backup loop
	bm.wg.Add(1)
	go bm.backupLoop()
	
	// Start cleanup loop
	bm.wg.Add(1)
	go bm.cleanupLoop()
	
	return nil
}

// Stop stops the backup manager
func (bm *BackupManager) Stop() error {
	if !bm.running.CompareAndSwap(true, false) {
		return fmt.Errorf("backup manager not running")
	}
	
	bm.logger.Info("Stopping backup manager")
	
	bm.cancel()
	bm.wg.Wait()
	
	return nil
}

// BackupNow performs an immediate backup
func (bm *BackupManager) BackupNow() error {
	bm.logger.Info("Performing manual backup")
	return bm.performBackup("manual")
}

// Restore restores from a backup
func (bm *BackupManager) Restore(backupID string, options RestoreOptions) error {
	bm.logger.Info("Starting restore",
		zap.String("backup_id", backupID),
		zap.Strings("components", options.Components),
		zap.Bool("dry_run", options.DryRun),
	)
	
	// Retrieve backup
	backup, err := bm.storage.Retrieve(backupID)
	if err != nil {
		return fmt.Errorf("failed to retrieve backup: %w", err)
	}
	
	// Decrypt if needed
	if backup.Encrypted {
		if err := bm.decryptBackup(backup); err != nil {
			return fmt.Errorf("failed to decrypt backup: %w", err)
		}
	}
	
	// Perform restore
	return bm.performRestore(backup, options)
}

// ListBackups returns available backups
func (bm *BackupManager) ListBackups() ([]BackupInfo, error) {
	return bm.storage.List()
}

// GetBackupStatus returns current backup status
func (bm *BackupManager) GetBackupStatus() BackupStatus {
	lastBackup := time.Time{}
	if lb := bm.lastBackup.Load(); lb != nil {
		lastBackup = lb.(time.Time)
	}
	
	return BackupStatus{
		Running:      bm.running.Load(),
		LastBackup:   lastBackup,
		BackupCount:  bm.backupCount.Load(),
		NextBackup:   lastBackup.Add(bm.config.Interval),
		StorageUsed:  bm.calculateStorageUsed(),
	}
}

// BackupStatus represents backup system status
type BackupStatus struct {
	Running     bool
	LastBackup  time.Time
	BackupCount uint64
	NextBackup  time.Time
	StorageUsed int64
}

// backupLoop performs periodic backups
func (bm *BackupManager) backupLoop() {
	defer bm.wg.Done()
	
	// Perform initial backup
	if err := bm.performBackup("scheduled"); err != nil {
		bm.logger.Error("Initial backup failed", zap.Error(err))
	}
	
	ticker := time.NewTicker(bm.config.Interval)
	defer ticker.Stop()
	
	for {
		select {
		case <-bm.ctx.Done():
			return
		case <-ticker.C:
			if err := bm.performBackup("scheduled"); err != nil {
				bm.logger.Error("Scheduled backup failed", zap.Error(err))
			}
		}
	}
}

// cleanupLoop performs periodic cleanup
func (bm *BackupManager) cleanupLoop() {
	defer bm.wg.Done()
	
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	
	for {
		select {
		case <-bm.ctx.Done():
			return
		case <-ticker.C:
			if err := bm.storage.Cleanup(bm.config.RetentionDays); err != nil {
				bm.logger.Error("Backup cleanup failed", zap.Error(err))
			}
		}
	}
}

// performBackup performs a backup
func (bm *BackupManager) performBackup(backupType string) error {
	startTime := time.Now()
	
	// Create backup
	backup := &Backup{
		ID:        bm.generateBackupID(),
		Timestamp: startTime,
		Type:      backupType,
		Metadata: BackupMetadata{
			Version:    "2.1.1",
			Components: bm.getBackupComponents(),
			Config:     make(map[string]interface{}),
		},
	}
	
	// Create temporary file for backup data
	tempFile, err := bm.createTempFile()
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}
	defer os.Remove(tempFile.Name())
	
	// Create archive
	if err := bm.createArchive(tempFile, backup); err != nil {
		return fmt.Errorf("failed to create archive: %w", err)
	}
	
	// Get file info
	info, err := tempFile.Stat()
	if err != nil {
		return fmt.Errorf("failed to stat temp file: %w", err)
	}
	backup.Size = info.Size()
	
	// Calculate checksum
	checksum, err := bm.calculateChecksum(tempFile.Name())
	if err != nil {
		return fmt.Errorf("failed to calculate checksum: %w", err)
	}
	backup.Checksum = checksum
	
	// Encrypt if enabled
	if bm.config.EncryptBackups {
		encryptedFile, err := bm.encryptFile(tempFile.Name())
		if err != nil {
			return fmt.Errorf("failed to encrypt backup: %w", err)
		}
		defer os.Remove(encryptedFile)
		
		tempFile.Close()
		tempFile, err = os.Open(encryptedFile)
		if err != nil {
			return fmt.Errorf("failed to open encrypted file: %w", err)
		}
		backup.Encrypted = true
	}
	
	// Reset file position
	tempFile.Seek(0, 0)
	backup.Data = tempFile
	
	// Store backup
	if err := bm.storage.Store(backup); err != nil {
		return fmt.Errorf("failed to store backup: %w", err)
	}
	
	// Update stats
	backup.Metadata.Stats = BackupStats{
		Duration:       time.Since(startTime),
		CompressedSize: backup.Size,
	}
	
	// Update state
	bm.lastBackup.Store(startTime)
	bm.backupCount.Add(1)
	
	bm.logger.Info("Backup completed",
		zap.String("id", backup.ID),
		zap.String("type", backupType),
		zap.Int64("size", backup.Size),
		zap.Duration("duration", backup.Metadata.Stats.Duration),
	)
	
	return nil
}

// createArchive creates a compressed archive
func (bm *BackupManager) createArchive(output *os.File, backup *Backup) error {
	// Create gzip writer
	gzWriter := gzip.NewWriter(output)
	defer gzWriter.Close()
	
	// Create tar writer
	tarWriter := tar.NewWriter(gzWriter)
	defer tarWriter.Close()
	
	// Add metadata
	metadataJSON, err := json.Marshal(backup.Metadata)
	if err != nil {
		return err
	}
	
	if err := bm.addToArchive(tarWriter, "metadata.json", metadataJSON); err != nil {
		return err
	}
	
	// Backup components
	if bm.config.BackupConfig {
		if err := bm.backupConfigFiles(tarWriter); err != nil {
			return fmt.Errorf("failed to backup config: %w", err)
		}
	}
	
	if bm.config.BackupWallets {
		if err := bm.backupWallets(tarWriter); err != nil {
			return fmt.Errorf("failed to backup wallets: %w", err)
		}
	}
	
	if bm.config.BackupDatabase {
		if err := bm.backupDatabase(tarWriter); err != nil {
			return fmt.Errorf("failed to backup database: %w", err)
		}
	}
	
	if bm.config.BackupSharechain {
		if err := bm.backupSharechain(tarWriter); err != nil {
			return fmt.Errorf("failed to backup sharechain: %w", err)
		}
	}
	
	return nil
}

// backupConfigFiles backs up configuration files
func (bm *BackupManager) backupConfigFiles(tw *tar.Writer) error {
	configFiles := []string{
		"config.yaml",
		"config.sample.yaml",
		"peers.json",
	}
	
	for _, file := range configFiles {
		if err := bm.addFileToArchive(tw, file, "config/"+file); err != nil {
			bm.logger.Warn("Failed to backup config file",
				zap.String("file", file),
				zap.Error(err),
			)
		}
	}
	
	return nil
}

// backupWallets backs up wallet files
func (bm *BackupManager) backupWallets(tw *tar.Writer) error {
	walletDir := "./wallets"
	
	return filepath.Walk(walletDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		
		if !info.IsDir() && filepath.Ext(path) == ".key" {
			relPath, _ := filepath.Rel(".", path)
			return bm.addFileToArchive(tw, path, relPath)
		}
		
		return nil
	})
}

// backupDatabase backs up the database
func (bm *BackupManager) backupDatabase(tw *tar.Writer) error {
	dbPath := "./data/otedama.db"
	
	// Create database snapshot
	// In production, this would use proper database backup methods
	return bm.addFileToArchive(tw, dbPath, "database/otedama.db")
}

// backupSharechain backs up sharechain data
func (bm *BackupManager) backupSharechain(tw *tar.Writer) error {
	sharechainDir := "./data/sharechain"
	
	return filepath.Walk(sharechainDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		
		if !info.IsDir() {
			relPath, _ := filepath.Rel(".", path)
			return bm.addFileToArchive(tw, path, relPath)
		}
		
		return nil
	})
}

// addFileToArchive adds a file to the tar archive
func (bm *BackupManager) addFileToArchive(tw *tar.Writer, sourcePath, archivePath string) error {
	file, err := os.Open(sourcePath)
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
	header.Name = archivePath
	
	if err := tw.WriteHeader(header); err != nil {
		return err
	}
	
	_, err = io.Copy(tw, file)
	return err
}

// addToArchive adds data to the archive
func (bm *BackupManager) addToArchive(tw *tar.Writer, name string, data []byte) error {
	header := &tar.Header{
		Name:    name,
		Size:    int64(len(data)),
		Mode:    0644,
		ModTime: time.Now(),
	}
	
	if err := tw.WriteHeader(header); err != nil {
		return err
	}
	
	_, err := tw.Write(data)
	return err
}

// performRestore performs a restore operation
func (bm *BackupManager) performRestore(backup *Backup, options RestoreOptions) error {
	// Create temporary directory for extraction
	tempDir, err := os.MkdirTemp("", "otedama-restore-*")
	if err != nil {
		return fmt.Errorf("failed to create temp dir: %w", err)
	}
	defer os.RemoveAll(tempDir)
	
	// Extract archive
	if err := bm.extractArchive(backup.Data, tempDir); err != nil {
		return fmt.Errorf("failed to extract archive: %w", err)
	}
	
	// Verify metadata
	metadata, err := bm.readMetadata(tempDir)
	if err != nil {
		return fmt.Errorf("failed to read metadata: %w", err)
	}
	
	// Dry run check
	if options.DryRun {
		bm.logger.Info("Dry run complete",
			zap.Strings("components", metadata.Components),
			zap.String("version", metadata.Version),
		)
		return nil
	}
	
	// Restore components
	components := options.Components
	if len(components) == 0 {
		components = metadata.Components
	}
	
	for _, component := range components {
		if err := bm.restoreComponent(tempDir, component, options); err != nil {
			bm.logger.Error("Failed to restore component",
				zap.String("component", component),
				zap.Error(err),
			)
			// Continue with other components
		}
	}
	
	bm.logger.Info("Restore completed",
		zap.String("backup_id", backup.ID),
		zap.Strings("components", components),
	)
	
	return nil
}

// extractArchive extracts a backup archive
func (bm *BackupManager) extractArchive(data io.Reader, destDir string) error {
	// Create gzip reader
	gzReader, err := gzip.NewReader(data)
	if err != nil {
		return err
	}
	defer gzReader.Close()
	
	// Create tar reader
	tarReader := tar.NewReader(gzReader)
	
	// Extract files
	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		
		path := filepath.Join(destDir, header.Name)
		
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(path, 0755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := bm.extractFile(tarReader, path); err != nil {
				return err
			}
		}
	}
	
	return nil
}

// extractFile extracts a single file from the archive
func (bm *BackupManager) extractFile(tr *tar.Reader, destPath string) error {
	// Create directory if needed
	dir := filepath.Dir(destPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	
	// Create file
	file, err := os.Create(destPath)
	if err != nil {
		return err
	}
	defer file.Close()
	
	// Copy data
	_, err = io.Copy(file, tr)
	return err
}

// restoreComponent restores a specific component
func (bm *BackupManager) restoreComponent(sourceDir string, component string, options RestoreOptions) error {
	switch component {
	case "config":
		return bm.restoreConfig(sourceDir, options)
	case "wallets":
		return bm.restoreWallets(sourceDir, options)
	case "database":
		return bm.restoreDatabase(sourceDir, options)
	case "sharechain":
		return bm.restoreSharechain(sourceDir, options)
	default:
		return fmt.Errorf("unknown component: %s", component)
	}
}

// Helper methods

func (bm *BackupManager) initializeStorage() (BackupStorage, error) {
	// Initialize appropriate storage backend
	if bm.config.RemoteEnabled {
		return NewRemoteStorage(bm.config.RemoteConfig)
	}
	return NewLocalStorage(bm.config.BackupDir)
}

func (bm *BackupManager) loadEncryptionKey() ([]byte, error) {
	if bm.config.EncryptionKeyFile == "" {
		// Generate new key
		key := make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			return nil, err
		}
		return key, nil
	}
	
	// Load from file
	return os.ReadFile(bm.config.EncryptionKeyFile)
}

func (bm *BackupManager) generateBackupID() string {
	return fmt.Sprintf("backup_%d_%s", time.Now().Unix(), generateRandomString(8))
}

func (bm *BackupManager) createTempFile() (*os.File, error) {
	return os.CreateTemp("", "otedama-backup-*.tmp")
}

func (bm *BackupManager) calculateChecksum(filename string) (string, error) {
	file, err := os.Open(filename)
	if err != nil {
		return "", err
	}
	defer file.Close()
	
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	
	return fmt.Sprintf("%x", hash.Sum(nil)), nil
}

func (bm *BackupManager) encryptFile(filename string) (string, error) {
	// Read file
	plaintext, err := os.ReadFile(filename)
	if err != nil {
		return "", err
	}
	
	// Create cipher
	block, err := aes.NewCipher(bm.encryptionKey)
	if err != nil {
		return "", err
	}
	
	// Create GCM
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	
	// Create nonce
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	
	// Encrypt
	ciphertext := gcm.Seal(nonce, nonce, plaintext, nil)
	
	// Write to new file
	encryptedFile := filename + ".enc"
	if err := os.WriteFile(encryptedFile, ciphertext, 0600); err != nil {
		return "", err
	}
	
	return encryptedFile, nil
}

func (bm *BackupManager) decryptBackup(backup *Backup) error {
	// Implementation depends on backup data structure
	// This is a placeholder
	return nil
}

func (bm *BackupManager) getBackupComponents() []string {
	var components []string
	
	if bm.config.BackupConfig {
		components = append(components, "config")
	}
	if bm.config.BackupWallets {
		components = append(components, "wallets")
	}
	if bm.config.BackupDatabase {
		components = append(components, "database")
	}
	if bm.config.BackupSharechain {
		components = append(components, "sharechain")
	}
	
	return components
}

func (bm *BackupManager) calculateStorageUsed() int64 {
	// Calculate total storage used by backups
	backups, err := bm.storage.List()
	if err != nil {
		return 0
	}
	
	var total int64
	for _, backup := range backups {
		total += backup.Size
	}
	
	return total
}

func (bm *BackupManager) readMetadata(dir string) (*BackupMetadata, error) {
	data, err := os.ReadFile(filepath.Join(dir, "metadata.json"))
	if err != nil {
		return nil, err
	}
	
	var metadata BackupMetadata
	if err := json.Unmarshal(data, &metadata); err != nil {
		return nil, err
	}
	
	return &metadata, nil
}

// Restore methods

func (bm *BackupManager) restoreConfig(sourceDir string, options RestoreOptions) error {
	if !options.OverwriteConfig {
		// Backup existing config
		if err := os.Rename("config.yaml", "config.yaml.bak"); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	
	// Copy config files
	return copyDir(filepath.Join(sourceDir, "config"), ".")
}

func (bm *BackupManager) restoreWallets(sourceDir string, options RestoreOptions) error {
	return copyDir(filepath.Join(sourceDir, "wallets"), "./wallets")
}

func (bm *BackupManager) restoreDatabase(sourceDir string, options RestoreOptions) error {
	// Stop database operations first
	// This is application-specific
	
	return copyFile(
		filepath.Join(sourceDir, "database/otedama.db"),
		"./data/otedama.db",
	)
}

func (bm *BackupManager) restoreSharechain(sourceDir string, options RestoreOptions) error {
	return copyDir(filepath.Join(sourceDir, "sharechain"), "./data/sharechain")
}

// Storage implementations

// LocalStorage implements local file storage
type LocalStorage struct {
	baseDir string
}

func NewLocalStorage(baseDir string) (*LocalStorage, error) {
	if err := os.MkdirAll(baseDir, 0755); err != nil {
		return nil, err
	}
	
	return &LocalStorage{baseDir: baseDir}, nil
}

func (ls *LocalStorage) Store(backup *Backup) error {
	filename := filepath.Join(ls.baseDir, backup.ID+".backup")
	
	file, err := os.Create(filename)
	if err != nil {
		return err
	}
	defer file.Close()
	
	_, err = io.Copy(file, backup.Data)
	return err
}

func (ls *LocalStorage) Retrieve(id string) (*Backup, error) {
	filename := filepath.Join(ls.baseDir, id+".backup")
	
	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	
	return &Backup{
		ID:   id,
		Size: info.Size(),
		Data: file,
	}, nil
}

func (ls *LocalStorage) List() ([]BackupInfo, error) {
	entries, err := os.ReadDir(ls.baseDir)
	if err != nil {
		return nil, err
	}
	
	var backups []BackupInfo
	for _, entry := range entries {
		if entry.IsDir() || !hasBackupExtension(entry.Name()) {
			continue
		}
		
		info, err := entry.Info()
		if err != nil {
			continue
		}
		
		backups = append(backups, BackupInfo{
			ID:        removeBackupExtension(entry.Name()),
			Timestamp: info.ModTime(),
			Size:      info.Size(),
		})
	}
	
	return backups, nil
}

func (ls *LocalStorage) Delete(id string) error {
	filename := filepath.Join(ls.baseDir, id+".backup")
	return os.Remove(filename)
}

func (ls *LocalStorage) Cleanup(retentionDays int) error {
	cutoff := time.Now().AddDate(0, 0, -retentionDays)
	
	backups, err := ls.List()
	if err != nil {
		return err
	}
	
	for _, backup := range backups {
		if backup.Timestamp.Before(cutoff) {
			if err := ls.Delete(backup.ID); err != nil {
				// Log but continue
				continue
			}
		}
	}
	
	return nil
}

// RemoteStorage implements remote storage (placeholder)
type RemoteStorage struct {
	config RemoteConfig
}

func NewRemoteStorage(config RemoteConfig) (*RemoteStorage, error) {
	// Initialize remote storage connection
	return &RemoteStorage{config: config}, nil
}

func (rs *RemoteStorage) Store(backup *Backup) error {
	// Implement remote storage
	return fmt.Errorf("remote storage not implemented")
}

func (rs *RemoteStorage) Retrieve(id string) (*Backup, error) {
	// Implement remote retrieval
	return nil, fmt.Errorf("remote storage not implemented")
}

func (rs *RemoteStorage) List() ([]BackupInfo, error) {
	// Implement remote listing
	return nil, fmt.Errorf("remote storage not implemented")
}

func (rs *RemoteStorage) Delete(id string) error {
	// Implement remote deletion
	return fmt.Errorf("remote storage not implemented")
}

func (rs *RemoteStorage) Cleanup(retentionDays int) error {
	// Implement remote cleanup
	return fmt.Errorf("remote storage not implemented")
}

// Helper functions

func generateRandomString(length int) string {
	const charset = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, length)
	for i := range b {
		b[i] = charset[randInt(len(charset))]
	}
	return string(b)
}

func randInt(max int) int {
	b := make([]byte, 1)
	rand.Read(b)
	return int(b[0]) % max
}

func hasBackupExtension(filename string) bool {
	return filepath.Ext(filename) == ".backup"
}

func removeBackupExtension(filename string) string {
	return filename[:len(filename)-7]
}

func copyFile(src, dst string) error {
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

func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		
		relPath, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		
		dstPath := filepath.Join(dst, relPath)
		
		if info.IsDir() {
			return os.MkdirAll(dstPath, info.Mode())
		}
		
		return copyFile(path, dstPath)
	})
}