package backup

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"time"

	"go.uber.org/zap"
)

// S3BackupTarget implements S3-compatible backup storage
type S3BackupTarget struct {
	logger   *zap.Logger
	config   RemoteConfig
	client   *http.Client
}

// NewS3BackupTarget creates a new S3 backup target
func NewS3BackupTarget(logger *zap.Logger, config RemoteConfig) (*S3BackupTarget, error) {
	// Validate configuration
	if config.S3Endpoint == "" {
		return nil, fmt.Errorf("S3 endpoint not configured")
	}
	if config.S3Bucket == "" {
		return nil, fmt.Errorf("S3 bucket not configured")
	}
	if config.S3AccessKey == "" || config.S3SecretKey == "" {
		return nil, fmt.Errorf("S3 credentials not configured")
	}
	
	return &S3BackupTarget{
		logger: logger,
		config: config,
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
	}, nil
}

// Name returns the target name
func (s *S3BackupTarget) Name() string {
	return fmt.Sprintf("s3:%s", s.config.S3Bucket)
}

// Store saves a backup to S3
func (s *S3BackupTarget) Store(backup *Backup) error {
	ctx := context.Background()
	
	// Build object key
	key := s.config.S3Prefix
	if key != "" && key[len(key)-1] != '/' {
		key += "/"
	}
	key += backup.Name
	
	// Create PUT request
	url := fmt.Sprintf("%s/%s/%s", s.config.S3Endpoint, s.config.S3Bucket, key)
	req, err := http.NewRequestWithContext(ctx, "PUT", url, bytes.NewReader(backup.Data))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	
	// Set headers
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("Content-Length", fmt.Sprintf("%d", len(backup.Data)))
	
	// Add metadata headers
	req.Header.Set("x-amz-meta-timestamp", backup.Timestamp.Format(time.RFC3339))
	req.Header.Set("x-amz-meta-checksum", backup.Checksum)
	req.Header.Set("x-amz-meta-encrypted", fmt.Sprintf("%t", backup.Encrypted))
	req.Header.Set("x-amz-meta-compressed", fmt.Sprintf("%t", backup.Compressed))
	
	// Sign request (simplified - real implementation would use proper AWS signature)
	s.signRequest(req)
	
	// Execute request
	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to upload backup: %w", err)
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("S3 upload failed: %s - %s", resp.Status, string(body))
	}
	
	s.logger.Info("Backup stored to S3",
		zap.String("bucket", s.config.S3Bucket),
		zap.String("key", key),
		zap.Int64("size", backup.Size),
	)
	
	return nil
}

// List returns all backups in S3 storage
func (s *S3BackupTarget) List() ([]*BackupInfo, error) {
	ctx := context.Background()
	
	// Build list request
	prefix := s.config.S3Prefix
	if prefix != "" && prefix[len(prefix)-1] != '/' {
		prefix += "/"
	}
	
	url := fmt.Sprintf("%s/%s?prefix=%s&max-keys=1000", 
		s.config.S3Endpoint, s.config.S3Bucket, prefix)
	
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	
	// Sign request
	s.signRequest(req)
	
	// Execute request
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to list backups: %w", err)
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("S3 list failed: %s - %s", resp.Status, string(body))
	}
	
	// Parse response (simplified - real implementation would parse XML)
	// For now, return empty list
	backups := make([]*BackupInfo, 0)
	
	// Sort by timestamp (newest first)
	sort.Slice(backups, func(i, j int) bool {
		return backups[i].Timestamp.After(backups[j].Timestamp)
	})
	
	return backups, nil
}

// Retrieve loads a backup from S3 storage
func (s *S3BackupTarget) Retrieve(name string) (*Backup, error) {
	ctx := context.Background()
	
	// Build object key
	key := s.config.S3Prefix
	if key != "" && key[len(key)-1] != '/' {
		key += "/"
	}
	key += name
	
	// Create GET request
	url := fmt.Sprintf("%s/%s/%s", s.config.S3Endpoint, s.config.S3Bucket, key)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	
	// Sign request
	s.signRequest(req)
	
	// Execute request
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to download backup: %w", err)
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("S3 download failed: %s - %s", resp.Status, string(body))
	}
	
	// Read data
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read backup data: %w", err)
	}
	
	// Parse metadata from headers
	backup := &Backup{
		Name: name,
		Data: data,
		Size: int64(len(data)),
	}
	
	if ts := resp.Header.Get("x-amz-meta-timestamp"); ts != "" {
		if t, err := time.Parse(time.RFC3339, ts); err == nil {
			backup.Timestamp = t
		}
	}
	
	backup.Checksum = resp.Header.Get("x-amz-meta-checksum")
	
	if enc := resp.Header.Get("x-amz-meta-encrypted"); enc == "true" {
		backup.Encrypted = true
	}
	
	if comp := resp.Header.Get("x-amz-meta-compressed"); comp == "true" {
		backup.Compressed = true
	}
	
	return backup, nil
}

// Delete removes a backup from S3 storage
func (s *S3BackupTarget) Delete(name string) error {
	ctx := context.Background()
	
	// Build object key
	key := s.config.S3Prefix
	if key != "" && key[len(key)-1] != '/' {
		key += "/"
	}
	key += name
	
	// Create DELETE request
	url := fmt.Sprintf("%s/%s/%s", s.config.S3Endpoint, s.config.S3Bucket, key)
	req, err := http.NewRequestWithContext(ctx, "DELETE", url, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	
	// Sign request
	s.signRequest(req)
	
	// Execute request
	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to delete backup: %w", err)
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("S3 delete failed: %s - %s", resp.Status, string(body))
	}
	
	return nil
}

// Private methods

func (s *S3BackupTarget) signRequest(req *http.Request) {
	// Simplified signing - real implementation would use proper AWS v4 signature
	req.Header.Set("Authorization", fmt.Sprintf("AWS %s:%s", 
		s.config.S3AccessKey, s.config.S3SecretKey))
	req.Header.Set("x-amz-date", time.Now().UTC().Format("20060102T150405Z"))
}

// S3ListResponse represents S3 list objects response
type S3ListResponse struct {
	Contents []S3Object `xml:"Contents"`
}

// S3Object represents an S3 object
type S3Object struct {
	Key          string    `xml:"Key"`
	LastModified time.Time `xml:"LastModified"`
	Size         int64     `xml:"Size"`
}