package backup

import (
	"archive/tar"
	"bytes"
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
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
	"golang.org/x/crypto/scrypt"
)

// AutoBackup manages automatic backup of configurations and wallets
type AutoBackup struct {
	logger *zap.Logger
	config Config
	
	// Backup targets
	targets     []BackupTarget
	
	// Encryption
	encryptKey  []byte
	
	// State
	lastBackup  atomic.Value // time.Time
	backupCount atomic.Uint64
	
	// Lifecycle
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// Config defines backup configuration
type Config struct {
	// Schedule
	Enabled         bool          `yaml:"enabled"`
	Interval        time.Duration `yaml:"interval"`
	RetentionDays   int           `yaml:"retention_days"`
	MaxBackups      int           `yaml:"max_backups"`
	
	// Paths
	BackupDir       string        `yaml:"backup_dir"`
	ConfigPaths     []string      `yaml:"config_paths"`
	WalletPaths     []string      `yaml:"wallet_paths"`
	DataPaths       []string      `yaml:"data_paths"`
	
	// Encryption
	EncryptBackups  bool          `yaml:"encrypt_backups"`
	PasswordFile    string        `yaml:"password_file"`
	
	// Compression
	CompressionLevel int          `yaml:"compression_level"` // 0-9
	
	// Remote backup
	RemoteEnabled   bool          `yaml:"remote_enabled"`
	RemoteType      string        `yaml:"remote_type"` // "s3", "sftp", "webdav"
	RemoteConfig    RemoteConfig  `yaml:"remote_config"`
	
	// Notifications
	NotifyOnSuccess bool          `yaml:"notify_on_success"`
	NotifyOnFailure bool          `yaml:"notify_on_failure"`
}

// RemoteConfig defines remote backup configuration
type RemoteConfig struct {
	// S3
	S3Endpoint      string `yaml:"s3_endpoint"`
	S3Bucket        string `yaml:"s3_bucket"`
	S3Prefix        string `yaml:"s3_prefix"`
	S3AccessKey     string `yaml:"s3_access_key"`
	S3SecretKey     string `yaml:"s3_secret_key"`
	
	// SFTP
	SFTPHost        string `yaml:"sftp_host"`
	SFTPPort        int    `yaml:"sftp_port"`
	SFTPUser        string `yaml:"sftp_user"`
	SFTPPassword    string `yaml:"sftp_password"`
	SFTPKeyFile     string `yaml:"sftp_key_file"`
	SFTPPath        string `yaml:"sftp_path"`
	
	// WebDAV
	WebDAVURL       string `yaml:"webdav_url"`
	WebDAVUser      string `yaml:"webdav_user"`
	WebDAVPassword  string `yaml:"webdav_password"`
}

// BackupTarget represents a backup destination
type BackupTarget interface {
	Name() string
	Store(backup *Backup) error
	List() ([]*BackupInfo, error)
	Retrieve(name string) (*Backup, error)
	Delete(name string) error
}

// Backup represents a backup archive
type Backup struct {
	Name        string    `json:"name"`
	Timestamp   time.Time `json:"timestamp"`
	Size        int64     `json:"size"`
	Checksum    string    `json:"checksum"`
	Encrypted   bool      `json:"encrypted"`
	Compressed  bool      `json:"compressed"`
	Files       []string  `json:"files"`
	Data        []byte    `json:"-"`
}

// BackupInfo represents backup metadata
type BackupInfo struct {
	Name        string    `json:"name"`
	Timestamp   time.Time `json:"timestamp"`
	Size        int64     `json:"size"`
	Checksum    string    `json:"checksum"`
	Encrypted   bool      `json:"encrypted"`
}

// BackupStats tracks backup statistics
type BackupStats struct {
	TotalBackups     uint64    `json:"total_backups"`
	SuccessfulBackups uint64   `json:"successful_backups"`
	FailedBackups    uint64    `json:"failed_backups"`
	LastBackup       time.Time `json:"last_backup"`
	LastSuccess      time.Time `json:"last_success"`
	LastFailure      time.Time `json:"last_failure"`
	TotalSize        int64     `json:"total_size"`
}

// NewAutoBackup creates a new automatic backup system
func NewAutoBackup(logger *zap.Logger, config Config) (*AutoBackup, error) {
	// Set defaults
	if config.Interval <= 0 {
		config.Interval = 24 * time.Hour
	}
	if config.RetentionDays <= 0 {
		config.RetentionDays = 30
	}
	if config.MaxBackups <= 0 {
		config.MaxBackups = 100
	}
	if config.BackupDir == "" {
		config.BackupDir = "./backups"
	}
	if config.CompressionLevel < 0 || config.CompressionLevel > 9 {
		config.CompressionLevel = gzip.DefaultCompression
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	ab := &AutoBackup{
		logger:  logger,
		config:  config,
		targets: make([]BackupTarget, 0),
		ctx:     ctx,
		cancel:  cancel,
	}
	
	// Create backup directory
	if err := os.MkdirAll(config.BackupDir, 0700); err != nil {
		return nil, fmt.Errorf("failed to create backup directory: %w", err)
	}
	
	// Initialize encryption if enabled
	if config.EncryptBackups {
		if err := ab.initializeEncryption(); err != nil {
			return nil, fmt.Errorf("failed to initialize encryption: %w", err)
		}
	}
	
	// Add local backup target
	ab.targets = append(ab.targets, NewLocalBackupTarget(config.BackupDir))
	
	// Add remote backup target if enabled
	if config.RemoteEnabled {
		remote, err := ab.createRemoteTarget()
		if err != nil {
			return nil, fmt.Errorf("failed to create remote backup target: %w", err)
		}
		ab.targets = append(ab.targets, remote)
	}
	
	return ab, nil
}

// Start begins automatic backup operations
func (ab *AutoBackup) Start() error {
	if !ab.config.Enabled {
		ab.logger.Info("Automatic backup disabled")
		return nil
	}
	
	ab.logger.Info("Starting automatic backup",
		zap.Duration("interval", ab.config.Interval),
		zap.Int("retention_days", ab.config.RetentionDays),
		zap.Bool("encryption", ab.config.EncryptBackups),
	)
	
	// Perform initial backup
	if err := ab.performBackup(); err != nil {
		ab.logger.Error("Initial backup failed", zap.Error(err))
	}
	
	// Start backup scheduler
	ab.wg.Add(1)
	go ab.backupScheduler()
	
	// Start cleanup scheduler
	ab.wg.Add(1)
	go ab.cleanupScheduler()
	
	return nil
}

// Stop halts automatic backup operations
func (ab *AutoBackup) Stop() error {
	ab.logger.Info("Stopping automatic backup")
	ab.cancel()
	ab.wg.Wait()
	return nil
}

// BackupNow performs an immediate backup
func (ab *AutoBackup) BackupNow() error {
	return ab.performBackup()
}

// RestoreBackup restores from a specific backup
func (ab *AutoBackup) RestoreBackup(backupName string) error {
	ab.logger.Info("Restoring backup", zap.String("backup", backupName))
	
	// Try each target until we find the backup
	var backup *Backup
	for _, target := range ab.targets {
		b, err := target.Retrieve(backupName)
		if err == nil {
			backup = b
			break
		}
	}
	
	if backup == nil {
		return fmt.Errorf("backup not found: %s", backupName)
	}
	
	// Decrypt if necessary
	data := backup.Data
	if backup.Encrypted {
		decrypted, err := ab.decrypt(data)
		if err != nil {
			return fmt.Errorf("failed to decrypt backup: %w", err)
		}
		data = decrypted
	}
	
	// Decompress if necessary
	if backup.Compressed {
		decompressed, err := ab.decompress(data)
		if err != nil {
			return fmt.Errorf("failed to decompress backup: %w", err)
		}
		data = decompressed
	}
	
	// Extract files
	if err := ab.extractBackup(data); err != nil {
		return fmt.Errorf("failed to extract backup: %w", err)
	}
	
	ab.logger.Info("Backup restored successfully", zap.String("backup", backupName))
	return nil
}

// ListBackups returns available backups
func (ab *AutoBackup) ListBackups() ([]*BackupInfo, error) {
	allBackups := make([]*BackupInfo, 0)
	
	for _, target := range ab.targets {
		backups, err := target.List()
		if err != nil {
			ab.logger.Warn("Failed to list backups from target",
				zap.String("target", target.Name()),
				zap.Error(err),
			)
			continue
		}
		allBackups = append(allBackups, backups...)
	}
	
	// Sort by timestamp (newest first)
	sort.Slice(allBackups, func(i, j int) bool {
		return allBackups[i].Timestamp.After(allBackups[j].Timestamp)
	})
	
	// Remove duplicates
	seen := make(map[string]bool)
	unique := make([]*BackupInfo, 0)
	for _, backup := range allBackups {
		if !seen[backup.Name] {
			seen[backup.Name] = true
			unique = append(unique, backup)
		}
	}
	
	return unique, nil
}

// GetStats returns backup statistics
func (ab *AutoBackup) GetStats() BackupStats {
	lastBackup := ab.lastBackup.Load()
	
	stats := BackupStats{
		TotalBackups: ab.backupCount.Load(),
	}
	
	if lastBackup != nil {
		stats.LastBackup = lastBackup.(time.Time)
	}
	
	// Calculate sizes from local backups
	if local, ok := ab.targets[0].(*LocalBackupTarget); ok {
		backups, _ := local.List()
		for _, backup := range backups {
			stats.TotalSize += backup.Size
		}
	}
	
	return stats
}

// Private methods

func (ab *AutoBackup) initializeEncryption() error {
	// Read password from file or generate
	var password []byte
	
	if ab.config.PasswordFile != "" {
		data, err := os.ReadFile(ab.config.PasswordFile)
		if err != nil {
			return fmt.Errorf("failed to read password file: %w", err)
		}
		password = data
	} else {
		// Generate random password and save it
		password = make([]byte, 32)
		if _, err := rand.Read(password); err != nil {
			return err
		}
		
		passwordFile := filepath.Join(ab.config.BackupDir, ".backup_password")
		if err := os.WriteFile(passwordFile, password, 0600); err != nil {
			return err
		}
		ab.config.PasswordFile = passwordFile
	}
	
	// Derive encryption key using scrypt
	salt := []byte("otedama-backup-salt")
	key, err := scrypt.Key(password, salt, 32768, 8, 1, 32)
	if err != nil {
		return err
	}
	
	ab.encryptKey = key
	return nil
}

func (ab *AutoBackup) createRemoteTarget() (BackupTarget, error) {
	switch ab.config.RemoteType {
	case "s3":
		return NewS3BackupTarget(ab.logger, ab.config.RemoteConfig)
	case "sftp":
		return NewSFTPBackupTarget(ab.logger, ab.config.RemoteConfig)
	case "webdav":
		return NewWebDAVBackupTarget(ab.logger, ab.config.RemoteConfig)
	default:
		return nil, fmt.Errorf("unknown remote type: %s", ab.config.RemoteType)
	}
}

func (ab *AutoBackup) backupScheduler() {
	defer ab.wg.Done()
	
	ticker := time.NewTicker(ab.config.Interval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ab.ctx.Done():
			return
		case <-ticker.C:
			if err := ab.performBackup(); err != nil {
				ab.logger.Error("Scheduled backup failed", zap.Error(err))
			}
		}
	}
}

func (ab *AutoBackup) cleanupScheduler() {
	defer ab.wg.Done()
	
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	
	for {
		select {
		case <-ab.ctx.Done():
			return
		case <-ticker.C:
			ab.cleanupOldBackups()
		}
	}
}

func (ab *AutoBackup) performBackup() error {
	startTime := time.Now()
	ab.logger.Info("Starting backup")
	
	// Collect files to backup
	files := make([]string, 0)
	files = append(files, ab.config.ConfigPaths...)
	files = append(files, ab.config.WalletPaths...)
	files = append(files, ab.config.DataPaths...)
	
	// Create backup archive
	archive, err := ab.createArchive(files)
	if err != nil {
		return fmt.Errorf("failed to create archive: %w", err)
	}
	
	// Compress
	if ab.config.CompressionLevel > 0 {
		compressed, err := ab.compress(archive)
		if err != nil {
			return fmt.Errorf("failed to compress: %w", err)
		}
		archive = compressed
	}
	
	// Encrypt
	if ab.config.EncryptBackups {
		encrypted, err := ab.encrypt(archive)
		if err != nil {
			return fmt.Errorf("failed to encrypt: %w", err)
		}
		archive = encrypted
	}
	
	// Calculate checksum
	checksum := fmt.Sprintf("%x", sha256.Sum256(archive))
	
	// Create backup object
	backup := &Backup{
		Name:       fmt.Sprintf("backup_%s.tar.gz", time.Now().Format("20060102_150405")),
		Timestamp:  startTime,
		Size:       int64(len(archive)),
		Checksum:   checksum,
		Encrypted:  ab.config.EncryptBackups,
		Compressed: ab.config.CompressionLevel > 0,
		Files:      files,
		Data:       archive,
	}
	
	// Store to all targets
	var lastErr error
	successCount := 0
	for _, target := range ab.targets {
		if err := target.Store(backup); err != nil {
			ab.logger.Error("Failed to store backup",
				zap.String("target", target.Name()),
				zap.Error(err),
			)
			lastErr = err
		} else {
			successCount++
		}
	}
	
	if successCount == 0 {
		return fmt.Errorf("failed to store backup to any target: %w", lastErr)
	}
	
	// Update stats
	ab.lastBackup.Store(time.Now())
	ab.backupCount.Add(1)
	
	duration := time.Since(startTime)
	ab.logger.Info("Backup completed",
		zap.String("name", backup.Name),
		zap.Int64("size", backup.Size),
		zap.Duration("duration", duration),
		zap.Int("targets", successCount),
	)
	
	return nil
}

func (ab *AutoBackup) createArchive(files []string) ([]byte, error) {
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	
	for _, file := range files {
		if err := ab.addFileToArchive(tw, file); err != nil {
			ab.logger.Warn("Failed to add file to archive",
				zap.String("file", file),
				zap.Error(err),
			)
		}
	}
	
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gw.Close(); err != nil {
		return nil, err
	}
	
	return buf.Bytes(), nil
}

func (ab *AutoBackup) addFileToArchive(tw *tar.Writer, path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	
	if info.IsDir() {
		// Add directory and its contents
		return filepath.Walk(path, func(file string, fi os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			return ab.addSingleFile(tw, file, fi)
		})
	}
	
	return ab.addSingleFile(tw, path, info)
}

func (ab *AutoBackup) addSingleFile(tw *tar.Writer, path string, info os.FileInfo) error {
	if info.IsDir() {
		return nil // Skip directories
	}
	
	header, err := tar.FileInfoHeader(info, "")
	if err != nil {
		return err
	}
	header.Name = path
	
	if err := tw.WriteHeader(header); err != nil {
		return err
	}
	
	if info.Mode().IsRegular() {
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		
		_, err = io.Copy(tw, file)
		return err
	}
	
	return nil
}

func (ab *AutoBackup) compress(data []byte) ([]byte, error) {
	var buf bytes.Buffer
	gw, err := gzip.NewWriterLevel(&buf, ab.config.CompressionLevel)
	if err != nil {
		return nil, err
	}
	
	if _, err := gw.Write(data); err != nil {
		return nil, err
	}
	
	if err := gw.Close(); err != nil {
		return nil, err
	}
	
	return buf.Bytes(), nil
}

func (ab *AutoBackup) decompress(data []byte) ([]byte, error) {
	gr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer gr.Close()
	
	return io.ReadAll(gr)
}

func (ab *AutoBackup) encrypt(data []byte) ([]byte, error) {
	block, err := aes.NewCipher(ab.encryptKey)
	if err != nil {
		return nil, err
	}
	
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	
	return gcm.Seal(nonce, nonce, data, nil), nil
}

func (ab *AutoBackup) decrypt(data []byte) ([]byte, error) {
	block, err := aes.NewCipher(ab.encryptKey)
	if err != nil {
		return nil, err
	}
	
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	
	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return nil, fmt.Errorf("ciphertext too short")
	}
	
	nonce, ciphertext := data[:nonceSize], data[nonceSize:]
	return gcm.Open(nil, nonce, ciphertext, nil)
}

func (ab *AutoBackup) extractBackup(data []byte) error {
	gr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return err
	}
	defer gr.Close()
	
	tr := tar.NewReader(gr)
	
	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		
		target := header.Name
		
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, os.FileMode(header.Mode)); err != nil {
				return err
			}
			
		case tar.TypeReg:
			// Create directory if needed
			dir := filepath.Dir(target)
			if err := os.MkdirAll(dir, 0755); err != nil {
				return err
			}
			
			// Create file
			file, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(header.Mode))
			if err != nil {
				return err
			}
			
			if _, err := io.Copy(file, tr); err != nil {
				file.Close()
				return err
			}
			
			file.Close()
		}
	}
	
	return nil
}

func (ab *AutoBackup) cleanupOldBackups() {
	cutoff := time.Now().AddDate(0, 0, -ab.config.RetentionDays)
	
	for _, target := range ab.targets {
		backups, err := target.List()
		if err != nil {
			continue
		}
		
		// Sort by timestamp (oldest first)
		sort.Slice(backups, func(i, j int) bool {
			return backups[i].Timestamp.Before(backups[j].Timestamp)
		})
		
		// Delete old backups, keeping at least MaxBackups
		toKeep := ab.config.MaxBackups
		for i, backup := range backups {
			if i < len(backups)-toKeep && backup.Timestamp.Before(cutoff) {
				if err := target.Delete(backup.Name); err != nil {
					ab.logger.Warn("Failed to delete old backup",
						zap.String("backup", backup.Name),
						zap.Error(err),
					)
				} else {
					ab.logger.Info("Deleted old backup",
						zap.String("backup", backup.Name),
						zap.Time("timestamp", backup.Timestamp),
					)
				}
			}
		}
	}
}