package deployment

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
)

// AutoUpdater handles automated software updates
// Following Rob Pike's principle: "Simplicity is the ultimate sophistication"
type AutoUpdater struct {
	logger *zap.Logger
	
	// Configuration
	config         UpdateConfig
	
	// Current version
	currentVersion Version
	
	// Update state
	updateState    UpdateState
	stateMu        sync.RWMutex
	
	// Download management
	downloadPath   string
	backupPath     string
	
	// Update channels
	updateChannel  string
	
	// Metrics
	metrics        struct {
		checksPerformed   uint64
		updatesAvailable  uint64
		updatesApplied    uint64
		updatesFailed     uint64
		avgDownloadTime   uint64 // milliseconds
		avgInstallTime    uint64 // milliseconds
	}
}

// UpdateConfig configures the auto-updater
type UpdateConfig struct {
	// Update sources
	UpdateURL         string
	MirrorURLs        []string
	
	// Update behavior
	AutoCheck         bool
	AutoDownload      bool
	AutoInstall       bool
	CheckInterval     time.Duration
	
	// Channels
	Channel           string // stable, beta, nightly
	
	// Security
	VerifySignature   bool
	PublicKeyPath     string
	
	// Rollback
	EnableRollback    bool
	KeepBackups       int
	
	// Network
	DownloadTimeout   time.Duration
	RetryAttempts     int
	RetryDelay        time.Duration
}

// Version represents software version information
type Version struct {
	Major       int
	Minor       int
	Patch       int
	Build       string
	Channel     string
	ReleaseDate time.Time
}

// UpdateState represents the current update state
type UpdateState struct {
	State           string // idle, checking, downloading, installing, failed
	Progress        float64
	CurrentVersion  Version
	AvailableUpdate *UpdateInfo
	LastCheck       time.Time
	LastUpdate      time.Time
	Error           error
}

// UpdateInfo contains information about an available update
type UpdateInfo struct {
	Version         Version
	ReleaseNotes    string
	Size            int64
	Checksum        string
	DownloadURL     string
	Signature       string
	Critical        bool
	MinVersion      Version // Minimum version required for update
	Requirements    []string
}

// UpdateManifest represents the update manifest from server
type UpdateManifest struct {
	Updates         []UpdateInfo `json:"updates"`
	LatestStable    Version      `json:"latest_stable"`
	LatestBeta      Version      `json:"latest_beta"`
	LatestNightly   Version      `json:"latest_nightly"`
	Timestamp       time.Time    `json:"timestamp"`
}

// NewAutoUpdater creates a new auto-updater instance
func NewAutoUpdater(logger *zap.Logger, config UpdateConfig, currentVersion Version) (*AutoUpdater, error) {
	au := &AutoUpdater{
		logger:         logger,
		config:         config,
		currentVersion: currentVersion,
		updateChannel:  config.Channel,
		downloadPath:   filepath.Join(os.TempDir(), "otedama_updates"),
		backupPath:     filepath.Join(os.TempDir(), "otedama_backups"),
		updateState: UpdateState{
			State:          "idle",
			CurrentVersion: currentVersion,
			LastCheck:      time.Time{},
		},
	}
	
	// Create directories
	if err := os.MkdirAll(au.downloadPath, 0755); err != nil {
		return nil, fmt.Errorf("failed to create download directory: %w", err)
	}
	
	if config.EnableRollback {
		if err := os.MkdirAll(au.backupPath, 0755); err != nil {
			return nil, fmt.Errorf("failed to create backup directory: %w", err)
		}
	}
	
	// Start auto-check if enabled
	if config.AutoCheck {
		go au.autoCheckLoop()
	}
	
	logger.Info("Initialized auto-updater",
		zap.String("version", au.currentVersion.String()),
		zap.String("channel", config.Channel),
		zap.Bool("auto_check", config.AutoCheck))
	
	return au, nil
}

// CheckForUpdates checks for available updates
func (au *AutoUpdater) CheckForUpdates() (*UpdateInfo, error) {
	au.setState("checking", 0)
	defer func() {
		if au.getState().State == "checking" {
			au.setState("idle", 0)
		}
	}()
	
	au.metrics.checksPerformed++
	
	// Fetch update manifest
	manifest, err := au.fetchUpdateManifest()
	if err != nil {
		au.setError(fmt.Errorf("failed to fetch manifest: %w", err))
		return nil, err
	}
	
	// Find applicable update
	update := au.findApplicableUpdate(manifest)
	if update == nil {
		au.logger.Info("No updates available",
			zap.String("current_version", au.currentVersion.String()))
		return nil, nil
	}
	
	au.metrics.updatesAvailable++
	
	// Update state
	au.stateMu.Lock()
	au.updateState.AvailableUpdate = update
	au.updateState.LastCheck = time.Now()
	au.stateMu.Unlock()
	
	au.logger.Info("Update available",
		zap.String("current_version", au.currentVersion.String()),
		zap.String("new_version", update.Version.String()),
		zap.Bool("critical", update.Critical))
	
	// Auto-download if configured
	if au.config.AutoDownload {
		go au.DownloadUpdate(update)
	}
	
	return update, nil
}

// DownloadUpdate downloads the specified update
func (au *AutoUpdater) DownloadUpdate(update *UpdateInfo) error {
	au.setState("downloading", 0)
	defer func() {
		if au.getState().State == "downloading" {
			au.setState("idle", 100)
		}
	}()
	
	start := time.Now()
	
	// Determine download path
	filename := fmt.Sprintf("otedama-%s-%s-%s.%s",
		update.Version.String(),
		runtime.GOOS,
		runtime.GOARCH,
		au.getPackageExtension())
	
	downloadPath := filepath.Join(au.downloadPath, filename)
	
	// Try primary URL first, then mirrors
	urls := append([]string{update.DownloadURL}, au.config.MirrorURLs...)
	
	var lastErr error
	for _, url := range urls {
		err := au.downloadFile(url, downloadPath, update.Size)
		if err == nil {
			// Verify checksum
			if err := au.verifyChecksum(downloadPath, update.Checksum); err != nil {
				os.Remove(downloadPath)
				lastErr = err
				continue
			}
			
			// Verify signature if configured
			if au.config.VerifySignature {
				if err := au.verifySignature(downloadPath, update.Signature); err != nil {
					os.Remove(downloadPath)
					lastErr = err
					continue
				}
			}
			
			// Success
			duration := time.Since(start).Milliseconds()
			au.updateDownloadMetrics(duration)
			
			au.logger.Info("Update downloaded successfully",
				zap.String("version", update.Version.String()),
				zap.String("path", downloadPath),
				zap.Duration("duration", time.Since(start)))
			
			// Auto-install if configured
			if au.config.AutoInstall {
				return au.InstallUpdate(update, downloadPath)
			}
			
			return nil
		}
		lastErr = err
	}
	
	au.setError(fmt.Errorf("download failed: %w", lastErr))
	au.metrics.updatesFailed++
	return lastErr
}

// InstallUpdate installs the downloaded update
func (au *AutoUpdater) InstallUpdate(update *UpdateInfo, packagePath string) error {
	au.setState("installing", 0)
	defer func() {
		if au.getState().State == "installing" {
			au.setState("idle", 100)
		}
	}()
	
	start := time.Now()
	
	// Create backup if rollback is enabled
	if au.config.EnableRollback {
		if err := au.createBackup(); err != nil {
			au.logger.Warn("Failed to create backup", zap.Error(err))
			// Continue with update anyway
		}
	}
	
	// Stop the current instance
	au.logger.Info("Preparing to install update...")
	
	// Extract and install based on platform
	var err error
	switch runtime.GOOS {
	case "windows":
		err = au.installWindows(packagePath)
	case "darwin":
		err = au.installDarwin(packagePath)
	case "linux":
		err = au.installLinux(packagePath)
	default:
		err = fmt.Errorf("unsupported platform: %s", runtime.GOOS)
	}
	
	if err != nil {
		au.setError(fmt.Errorf("installation failed: %w", err))
		au.metrics.updatesFailed++
		
		// Attempt rollback
		if au.config.EnableRollback {
			au.logger.Warn("Installation failed, attempting rollback", zap.Error(err))
			if rollbackErr := au.rollback(); rollbackErr != nil {
				au.logger.Error("Rollback failed", zap.Error(rollbackErr))
			}
		}
		
		return err
	}
	
	// Update metrics
	duration := time.Since(start).Milliseconds()
	au.updateInstallMetrics(duration)
	au.metrics.updatesApplied++
	
	// Update version
	au.currentVersion = update.Version
	au.stateMu.Lock()
	au.updateState.CurrentVersion = update.Version
	au.updateState.LastUpdate = time.Now()
	au.updateState.AvailableUpdate = nil
	au.stateMu.Unlock()
	
	au.logger.Info("Update installed successfully",
		zap.String("version", update.Version.String()),
		zap.Duration("duration", time.Since(start)))
	
	// Schedule restart
	au.scheduleRestart()
	
	return nil
}

// Rollback reverts to the previous version
func (au *AutoUpdater) Rollback() error {
	return au.rollback()
}

// GetState returns the current update state
func (au *AutoUpdater) GetState() UpdateState {
	return au.getState()
}

// Implementation methods

func (au *AutoUpdater) fetchUpdateManifest() (*UpdateManifest, error) {
	client := &http.Client{
		Timeout: au.config.DownloadTimeout,
	}
	
	resp, err := client.Get(au.config.UpdateURL + "/manifest.json")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("server returned %d", resp.StatusCode)
	}
	
	var manifest UpdateManifest
	if err := json.NewDecoder(resp.Body).Decode(&manifest); err != nil {
		return nil, err
	}
	
	return &manifest, nil
}

func (au *AutoUpdater) findApplicableUpdate(manifest *UpdateManifest) *UpdateInfo {
	for _, update := range manifest.Updates {
		// Check channel
		if update.Version.Channel != au.updateChannel && au.updateChannel != "any" {
			continue
		}
		
		// Check if newer
		if !update.Version.IsNewer(au.currentVersion) {
			continue
		}
		
		// Check minimum version requirement
		if au.currentVersion.IsOlder(update.MinVersion) {
			continue
		}
		
		// Check platform requirements
		if !au.checkRequirements(update.Requirements) {
			continue
		}
		
		return &update
	}
	
	return nil
}

func (au *AutoUpdater) downloadFile(url, dest string, expectedSize int64) error {
	client := &http.Client{
		Timeout: au.config.DownloadTimeout,
	}
	
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("server returned %d", resp.StatusCode)
	}
	
	// Create temporary file
	tmpFile := dest + ".tmp"
	out, err := os.Create(tmpFile)
	if err != nil {
		return err
	}
	defer out.Close()
	
	// Download with progress
	var written int64
	buf := make([]byte, 32*1024)
	
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := out.Write(buf[:n]); writeErr != nil {
				os.Remove(tmpFile)
				return writeErr
			}
			written += int64(n)
			
			// Update progress
			if expectedSize > 0 {
				progress := float64(written) / float64(expectedSize) * 100
				au.setState("downloading", progress)
			}
		}
		
		if err == io.EOF {
			break
		}
		if err != nil {
			os.Remove(tmpFile)
			return err
		}
	}
	
	// Rename to final destination
	return os.Rename(tmpFile, dest)
}

func (au *AutoUpdater) verifyChecksum(file, expectedChecksum string) error {
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	
	actualChecksum := hex.EncodeToString(h.Sum(nil))
	if actualChecksum != expectedChecksum {
		return fmt.Errorf("checksum mismatch: expected %s, got %s", expectedChecksum, actualChecksum)
	}
	
	return nil
}

func (au *AutoUpdater) verifySignature(file, signature string) error {
	// TODO: Implement proper signature verification
	// This would use the public key to verify the signature
	return nil
}

func (au *AutoUpdater) installWindows(packagePath string) error {
	// Windows installation logic
	// 1. Extract package
	// 2. Stop service
	// 3. Replace executable
	// 4. Start service
	
	// For now, use simple file replacement
	exePath, err := os.Executable()
	if err != nil {
		return err
	}
	
	// Rename current executable
	backupPath := exePath + ".old"
	if err := os.Rename(exePath, backupPath); err != nil {
		return err
	}
	
	// Extract new executable
	if err := au.extractPackage(packagePath, filepath.Dir(exePath)); err != nil {
		// Restore backup
		os.Rename(backupPath, exePath)
		return err
	}
	
	return nil
}

func (au *AutoUpdater) installLinux(packagePath string) error {
	// Linux installation logic
	exePath, err := os.Executable()
	if err != nil {
		return err
	}
	
	// Extract package
	if err := au.extractPackage(packagePath, filepath.Dir(exePath)); err != nil {
		return err
	}
	
	// Set executable permissions
	newExePath := filepath.Join(filepath.Dir(exePath), "otedama")
	if err := os.Chmod(newExePath, 0755); err != nil {
		return err
	}
	
	return nil
}

func (au *AutoUpdater) installDarwin(packagePath string) error {
	// macOS installation logic
	return au.installLinux(packagePath) // Similar to Linux
}

func (au *AutoUpdater) extractPackage(packagePath, destDir string) error {
	ext := filepath.Ext(packagePath)
	
	switch ext {
	case ".zip":
		return au.extractZip(packagePath, destDir)
	case ".gz", ".tar":
		return au.extractTarGz(packagePath, destDir)
	default:
		// Assume it's a binary file
		return au.copyBinary(packagePath, destDir)
	}
}

func (au *AutoUpdater) extractZip(zipPath, destDir string) error {
	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer reader.Close()
	
	for _, file := range reader.File {
		path := filepath.Join(destDir, file.Name)
		
		if file.FileInfo().IsDir() {
			os.MkdirAll(path, file.Mode())
			continue
		}
		
		fileReader, err := file.Open()
		if err != nil {
			return err
		}
		defer fileReader.Close()
		
		targetFile, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, file.Mode())
		if err != nil {
			return err
		}
		defer targetFile.Close()
		
		_, err = io.Copy(targetFile, fileReader)
		if err != nil {
			return err
		}
	}
	
	return nil
}

func (au *AutoUpdater) extractTarGz(tarPath, destDir string) error {
	file, err := os.Open(tarPath)
	if err != nil {
		return err
	}
	defer file.Close()
	
	var tarReader *tar.Reader
	
	if strings.HasSuffix(tarPath, ".gz") {
		gzReader, err := gzip.NewReader(file)
		if err != nil {
			return err
		}
		defer gzReader.Close()
		tarReader = tar.NewReader(gzReader)
	} else {
		tarReader = tar.NewReader(file)
	}
	
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
			outFile, err := os.Create(path)
			if err != nil {
				return err
			}
			if _, err := io.Copy(outFile, tarReader); err != nil {
				outFile.Close()
				return err
			}
			outFile.Close()
			
			// Set permissions
			if err := os.Chmod(path, os.FileMode(header.Mode)); err != nil {
				return err
			}
		}
	}
	
	return nil
}

func (au *AutoUpdater) copyBinary(src, destDir string) error {
	source, err := os.Open(src)
	if err != nil {
		return err
	}
	defer source.Close()
	
	destPath := filepath.Join(destDir, "otedama")
	if runtime.GOOS == "windows" {
		destPath += ".exe"
	}
	
	dest, err := os.Create(destPath)
	if err != nil {
		return err
	}
	defer dest.Close()
	
	_, err = io.Copy(dest, source)
	return err
}

func (au *AutoUpdater) createBackup() error {
	exePath, err := os.Executable()
	if err != nil {
		return err
	}
	
	backupName := fmt.Sprintf("otedama-%s-%d.bak",
		au.currentVersion.String(),
		time.Now().Unix())
	
	backupPath := filepath.Join(au.backupPath, backupName)
	
	// Copy executable to backup
	return au.copyFile(exePath, backupPath)
}

func (au *AutoUpdater) rollback() error {
	// Find most recent backup
	files, err := os.ReadDir(au.backupPath)
	if err != nil {
		return err
	}
	
	if len(files) == 0 {
		return errors.New("no backups available")
	}
	
	// Sort by modification time
	var latestBackup string
	var latestTime time.Time
	
	for _, file := range files {
		if strings.HasSuffix(file.Name(), ".bak") {
			info, err := file.Info()
			if err != nil {
				continue
			}
			if info.ModTime().After(latestTime) {
				latestTime = info.ModTime()
				latestBackup = filepath.Join(au.backupPath, file.Name())
			}
		}
	}
	
	if latestBackup == "" {
		return errors.New("no valid backup found")
	}
	
	// Restore backup
	exePath, err := os.Executable()
	if err != nil {
		return err
	}
	
	return au.copyFile(latestBackup, exePath)
}

func (au *AutoUpdater) copyFile(src, dst string) error {
	source, err := os.Open(src)
	if err != nil {
		return err
	}
	defer source.Close()
	
	destination, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer destination.Close()
	
	_, err = io.Copy(destination, source)
	return err
}

func (au *AutoUpdater) scheduleRestart() {
	// Schedule restart in 5 seconds
	time.AfterFunc(5*time.Second, func() {
		au.logger.Info("Restarting application...")
		
		// Get executable path
		exePath, err := os.Executable()
		if err != nil {
			au.logger.Error("Failed to get executable path", zap.Error(err))
			return
		}
		
		// Start new instance
		cmd := exec.Command(exePath, os.Args[1:]...)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		
		if err := cmd.Start(); err != nil {
			au.logger.Error("Failed to start new instance", zap.Error(err))
			return
		}
		
		// Exit current instance
		os.Exit(0)
	})
}

func (au *AutoUpdater) autoCheckLoop() {
	ticker := time.NewTicker(au.config.CheckInterval)
	defer ticker.Stop()
	
	// Initial check
	au.CheckForUpdates()
	
	for range ticker.C {
		au.CheckForUpdates()
	}
}

func (au *AutoUpdater) checkRequirements(requirements []string) bool {
	for _, req := range requirements {
		parts := strings.Split(req, ":")
		if len(parts) != 2 {
			continue
		}
		
		switch parts[0] {
		case "os":
			if parts[1] != runtime.GOOS {
				return false
			}
		case "arch":
			if parts[1] != runtime.GOARCH {
				return false
			}
		case "min_ram":
			// Check available RAM
			// Implementation depends on platform
		case "min_disk":
			// Check available disk space
		}
	}
	
	return true
}

func (au *AutoUpdater) getPackageExtension() string {
	switch runtime.GOOS {
	case "windows":
		return "zip"
	case "darwin":
		return "tar.gz"
	case "linux":
		return "tar.gz"
	default:
		return "tar.gz"
	}
}

func (au *AutoUpdater) setState(state string, progress float64) {
	au.stateMu.Lock()
	defer au.stateMu.Unlock()
	
	au.updateState.State = state
	au.updateState.Progress = progress
	au.updateState.Error = nil
}

func (au *AutoUpdater) setError(err error) {
	au.stateMu.Lock()
	defer au.stateMu.Unlock()
	
	au.updateState.State = "failed"
	au.updateState.Error = err
}

func (au *AutoUpdater) getState() UpdateState {
	au.stateMu.RLock()
	defer au.stateMu.RUnlock()
	
	return au.updateState
}

func (au *AutoUpdater) updateDownloadMetrics(duration int64) {
	downloads := au.metrics.updatesApplied + au.metrics.updatesFailed
	if downloads > 0 {
		au.metrics.avgDownloadTime = (au.metrics.avgDownloadTime*downloads + uint64(duration)) / (downloads + 1)
	} else {
		au.metrics.avgDownloadTime = uint64(duration)
	}
}

func (au *AutoUpdater) updateInstallMetrics(duration int64) {
	installs := au.metrics.updatesApplied
	if installs > 0 {
		au.metrics.avgInstallTime = (au.metrics.avgInstallTime*(installs-1) + uint64(duration)) / installs
	} else {
		au.metrics.avgInstallTime = uint64(duration)
	}
}

// GetMetrics returns update metrics
func (au *AutoUpdater) GetMetrics() map[string]interface{} {
	return map[string]interface{}{
		"checks_performed":    au.metrics.checksPerformed,
		"updates_available":   au.metrics.updatesAvailable,
		"updates_applied":     au.metrics.updatesApplied,
		"updates_failed":      au.metrics.updatesFailed,
		"avg_download_time":   au.metrics.avgDownloadTime,
		"avg_install_time":    au.metrics.avgInstallTime,
		"current_version":     au.currentVersion.String(),
		"update_channel":      au.updateChannel,
		"auto_check_enabled":  au.config.AutoCheck,
		"auto_install_enabled": au.config.AutoInstall,
	}
}

// Version comparison methods

func (v Version) String() string {
	return fmt.Sprintf("%d.%d.%d-%s", v.Major, v.Minor, v.Patch, v.Build)
}

func (v Version) IsNewer(other Version) bool {
	if v.Major > other.Major {
		return true
	}
	if v.Major < other.Major {
		return false
	}
	
	if v.Minor > other.Minor {
		return true
	}
	if v.Minor < other.Minor {
		return false
	}
	
	if v.Patch > other.Patch {
		return true
	}
	if v.Patch < other.Patch {
		return false
	}
	
	// Compare build strings
	return v.Build > other.Build
}

func (v Version) IsOlder(other Version) bool {
	return other.IsNewer(v)
}

// Stop stops the auto-updater
func (au *AutoUpdater) Stop() {
	// Cleanup resources
	au.logger.Info("Stopping auto-updater")
}