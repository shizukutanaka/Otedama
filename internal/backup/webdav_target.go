package backup

import (
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"time"

	"go.uber.org/zap"
)

// WebDAVBackupTarget implements WebDAV backup storage
type WebDAVBackupTarget struct {
	logger *zap.Logger
	config RemoteConfig
	client *http.Client
}

// NewWebDAVBackupTarget creates a new WebDAV backup target
func NewWebDAVBackupTarget(logger *zap.Logger, config RemoteConfig) (*WebDAVBackupTarget, error) {
	// Validate configuration
	if config.WebDAVURL == "" {
		return nil, fmt.Errorf("WebDAV URL not configured")
	}
	if config.WebDAVUser == "" || config.WebDAVPassword == "" {
		return nil, fmt.Errorf("WebDAV credentials not configured")
	}
	
	// Parse URL to ensure it's valid
	if _, err := url.Parse(config.WebDAVURL); err != nil {
		return nil, fmt.Errorf("invalid WebDAV URL: %w", err)
	}
	
	return &WebDAVBackupTarget{
		logger: logger,
		config: config,
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
	}, nil
}

// Name returns the target name
func (w *WebDAVBackupTarget) Name() string {
	u, _ := url.Parse(w.config.WebDAVURL)
	return fmt.Sprintf("webdav:%s", u.Host)
}

// Store saves a backup via WebDAV
func (w *WebDAVBackupTarget) Store(backup *Backup) error {
	ctx := context.Background()
	
	// Build full URL
	fullURL, err := url.Parse(w.config.WebDAVURL)
	if err != nil {
		return err
	}
	fullURL.Path = path.Join(fullURL.Path, backup.Name)
	
	// Create PUT request
	req, err := http.NewRequestWithContext(ctx, "PUT", fullURL.String(), bytes.NewReader(backup.Data))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	
	// Set authentication
	req.SetBasicAuth(w.config.WebDAVUser, w.config.WebDAVPassword)
	
	// Set headers
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("Content-Length", fmt.Sprintf("%d", len(backup.Data)))
	
	// Execute request
	resp, err := w.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to upload backup: %w", err)
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("WebDAV upload failed: %s - %s", resp.Status, string(body))
	}
	
	// Store metadata as properties
	if err := w.setProperties(fullURL.String(), backup); err != nil {
		w.logger.Warn("Failed to set WebDAV properties", zap.Error(err))
	}
	
	w.logger.Info("Backup stored via WebDAV",
		zap.String("url", fullURL.String()),
		zap.Int64("size", backup.Size),
	)
	
	return nil
}

// List returns all backups on WebDAV server
func (w *WebDAVBackupTarget) List() ([]*BackupInfo, error) {
	ctx := context.Background()
	
	// Create PROPFIND request
	propfind := `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:displayname/>
    <D:getcontentlength/>
    <D:getlastmodified/>
    <D:resourcetype/>
  </D:prop>
</D:propfind>`
	
	req, err := http.NewRequestWithContext(ctx, "PROPFIND", w.config.WebDAVURL, strings.NewReader(propfind))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	
	// Set authentication
	req.SetBasicAuth(w.config.WebDAVUser, w.config.WebDAVPassword)
	
	// Set headers
	req.Header.Set("Content-Type", "application/xml")
	req.Header.Set("Depth", "1")
	
	// Execute request
	resp, err := w.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to list backups: %w", err)
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusMultiStatus {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("WebDAV list failed: %s - %s", resp.Status, string(body))
	}
	
	// Parse response
	var multistatus Multistatus
	if err := xml.NewDecoder(resp.Body).Decode(&multistatus); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}
	
	// Convert to BackupInfo
	backups := make([]*BackupInfo, 0)
	for _, response := range multistatus.Response {
		// Skip collections (directories)
		if response.Propstat.Prop.ResourceType.Collection != nil {
			continue
		}
		
		// Skip non-backup files
		name := path.Base(response.Href)
		if !strings.HasPrefix(name, "backup_") {
			continue
		}
		
		info := &BackupInfo{
			Name: name,
			Size: response.Propstat.Prop.GetContentLength,
		}
		
		// Parse last modified time
		if response.Propstat.Prop.GetLastModified != "" {
			if t, err := time.Parse(time.RFC1123, response.Propstat.Prop.GetLastModified); err == nil {
				info.Timestamp = t
			}
		}
		
		backups = append(backups, info)
	}
	
	// Sort by timestamp (newest first)
	sort.Slice(backups, func(i, j int) bool {
		return backups[i].Timestamp.After(backups[j].Timestamp)
	})
	
	return backups, nil
}

// Retrieve loads a backup from WebDAV server
func (w *WebDAVBackupTarget) Retrieve(name string) (*Backup, error) {
	ctx := context.Background()
	
	// Build full URL
	fullURL, err := url.Parse(w.config.WebDAVURL)
	if err != nil {
		return nil, err
	}
	fullURL.Path = path.Join(fullURL.Path, name)
	
	// Create GET request
	req, err := http.NewRequestWithContext(ctx, "GET", fullURL.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	
	// Set authentication
	req.SetBasicAuth(w.config.WebDAVUser, w.config.WebDAVPassword)
	
	// Execute request
	resp, err := w.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to download backup: %w", err)
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("WebDAV download failed: %s - %s", resp.Status, string(body))
	}
	
	// Read data
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read backup data: %w", err)
	}
	
	backup := &Backup{
		Name: name,
		Data: data,
		Size: int64(len(data)),
	}
	
	// Get properties
	props, err := w.getProperties(fullURL.String())
	if err == nil && props != nil {
		// Parse custom properties if available
		backup.Timestamp = props.Timestamp
		backup.Checksum = props.Checksum
		backup.Encrypted = props.Encrypted
		backup.Compressed = props.Compressed
	}
	
	return backup, nil
}

// Delete removes a backup from WebDAV server
func (w *WebDAVBackupTarget) Delete(name string) error {
	ctx := context.Background()
	
	// Build full URL
	fullURL, err := url.Parse(w.config.WebDAVURL)
	if err != nil {
		return err
	}
	fullURL.Path = path.Join(fullURL.Path, name)
	
	// Create DELETE request
	req, err := http.NewRequestWithContext(ctx, "DELETE", fullURL.String(), nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	
	// Set authentication
	req.SetBasicAuth(w.config.WebDAVUser, w.config.WebDAVPassword)
	
	// Execute request
	resp, err := w.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to delete backup: %w", err)
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("WebDAV delete failed: %s - %s", resp.Status, string(body))
	}
	
	return nil
}

// Private methods

func (w *WebDAVBackupTarget) setProperties(url string, backup *Backup) error {
	// Simplified - would set custom WebDAV properties
	return nil
}

func (w *WebDAVBackupTarget) getProperties(url string) (*BackupProperties, error) {
	// Simplified - would get custom WebDAV properties
	return &BackupProperties{
		Timestamp: time.Now(),
	}, nil
}

// WebDAV XML structures

type Multistatus struct {
	XMLName  xml.Name   `xml:"multistatus"`
	Response []Response `xml:"response"`
}

type Response struct {
	Href     string   `xml:"href"`
	Propstat Propstat `xml:"propstat"`
}

type Propstat struct {
	Prop   Prop   `xml:"prop"`
	Status string `xml:"status"`
}

type Prop struct {
	DisplayName      string       `xml:"displayname"`
	GetContentLength int64        `xml:"getcontentlength"`
	GetLastModified  string       `xml:"getlastmodified"`
	ResourceType     ResourceType `xml:"resourcetype"`
}

type ResourceType struct {
	Collection *struct{} `xml:"collection"`
}

type BackupProperties struct {
	Timestamp  time.Time
	Checksum   string
	Encrypted  bool
	Compressed bool
}