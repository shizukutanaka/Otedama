package backup

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"go.uber.org/zap"
)

// LocalBackupTarget implements local filesystem backup storage
type LocalBackupTarget struct {
	logger  *zap.Logger
	baseDir string
}

// NewLocalBackupTarget creates a new local backup target
func NewLocalBackupTarget(baseDir string) *LocalBackupTarget {
	return &LocalBackupTarget{
		baseDir: baseDir,
	}
}

// Name returns the target name
func (l *LocalBackupTarget) Name() string {
	return "local"
}

// Store saves a backup to the local filesystem
func (l *LocalBackupTarget) Store(backup *Backup) error {
	// Ensure directory exists
	if err := os.MkdirAll(l.baseDir, 0700); err != nil {
		return fmt.Errorf("failed to create backup directory: %w", err)
	}
	
	// Write backup file
	filePath := filepath.Join(l.baseDir, backup.Name)
	file, err := os.OpenFile(filePath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return fmt.Errorf("failed to create backup file: %w", err)
	}
	defer file.Close()
	
	// Write data
	n, err := file.Write(backup.Data)
	if err != nil {
		return fmt.Errorf("failed to write backup data: %w", err)
	}
	
	if int64(n) != backup.Size {
		return fmt.Errorf("incomplete write: wrote %d bytes, expected %d", n, backup.Size)
	}
	
	// Write metadata file
	metaPath := filePath + ".meta"
	if err := l.writeMetadata(metaPath, backup); err != nil {
		return fmt.Errorf("failed to write metadata: %w", err)
	}
	
	return nil
}

// List returns all backups in the local storage
func (l *LocalBackupTarget) List() ([]*BackupInfo, error) {
	entries, err := os.ReadDir(l.baseDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []*BackupInfo{}, nil
		}
		return nil, err
	}
	
	backups := make([]*BackupInfo, 0)
	for _, entry := range entries {
		if entry.IsDir() || strings.HasSuffix(entry.Name(), ".meta") {
			continue
		}
		
		// Read metadata
		metaPath := filepath.Join(l.baseDir, entry.Name()+".meta")
		if meta, err := l.readMetadata(metaPath); err == nil {
			backups = append(backups, meta)
		} else {
			// Fallback to file info
			info, err := entry.Info()
			if err != nil {
				continue
			}
			
			backups = append(backups, &BackupInfo{
				Name:      entry.Name(),
				Timestamp: info.ModTime(),
				Size:      info.Size(),
			})
		}
	}
	
	// Sort by timestamp (newest first)
	sort.Slice(backups, func(i, j int) bool {
		return backups[i].Timestamp.After(backups[j].Timestamp)
	})
	
	return backups, nil
}

// Retrieve loads a backup from local storage
func (l *LocalBackupTarget) Retrieve(name string) (*Backup, error) {
	filePath := filepath.Join(l.baseDir, name)
	
	// Read backup file
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read backup file: %w", err)
	}
	
	// Read metadata
	metaPath := filePath + ".meta"
	meta, err := l.readMetadata(metaPath)
	if err != nil {
		// Create basic backup info from file
		info, err := os.Stat(filePath)
		if err != nil {
			return nil, err
		}
		
		return &Backup{
			Name:      name,
			Timestamp: info.ModTime(),
			Size:      info.Size(),
			Data:      data,
		}, nil
	}
	
	return &Backup{
		Name:       meta.Name,
		Timestamp:  meta.Timestamp,
		Size:       meta.Size,
		Checksum:   meta.Checksum,
		Encrypted:  meta.Encrypted,
		Compressed: meta.Encrypted,
		Data:       data,
	}, nil
}

// Delete removes a backup from local storage
func (l *LocalBackupTarget) Delete(name string) error {
	filePath := filepath.Join(l.baseDir, name)
	metaPath := filePath + ".meta"
	
	// Remove backup file
	if err := os.Remove(filePath); err != nil && !os.IsNotExist(err) {
		return err
	}
	
	// Remove metadata file
	if err := os.Remove(metaPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	
	return nil
}

// Private methods

func (l *LocalBackupTarget) writeMetadata(path string, backup *Backup) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	
	// Write metadata in simple format
	fmt.Fprintf(file, "name=%s\n", backup.Name)
	fmt.Fprintf(file, "timestamp=%s\n", backup.Timestamp.Format(time.RFC3339))
	fmt.Fprintf(file, "size=%d\n", backup.Size)
	fmt.Fprintf(file, "checksum=%s\n", backup.Checksum)
	fmt.Fprintf(file, "encrypted=%t\n", backup.Encrypted)
	fmt.Fprintf(file, "compressed=%t\n", backup.Compressed)
	
	return nil
}

func (l *LocalBackupTarget) readMetadata(path string) (*BackupInfo, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	
	info := &BackupInfo{}
	
	// Read metadata lines
	var lines []string
	buf := make([]byte, 1024)
	for {
		n, err := file.Read(buf)
		if n > 0 {
			lines = append(lines, strings.Split(string(buf[:n]), "\n")...)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
	}
	
	// Parse metadata
	for _, line := range lines {
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		
		key, value := parts[0], parts[1]
		switch key {
		case "name":
			info.Name = value
		case "timestamp":
			if t, err := time.Parse(time.RFC3339, value); err == nil {
				info.Timestamp = t
			}
		case "size":
			fmt.Sscanf(value, "%d", &info.Size)
		case "checksum":
			info.Checksum = value
		case "encrypted":
			fmt.Sscanf(value, "%t", &info.Encrypted)
		}
	}
	
	return info, nil
}