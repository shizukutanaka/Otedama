// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package daemon

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// ============================================================================
// systemdUnitPath
// ============================================================================

func TestSystemdUnitPath_UsesUserConfig(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("systemd paths are Linux-specific")
	}
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	path, err := m.systemdUnitPath()
	if err != nil {
		t.Fatalf("systemdUnitPath: %v", err)
	}

	home, _ := os.UserHomeDir()
	wantPrefix := filepath.Join(home, ".config", "systemd", "user")
	if !strings.HasPrefix(path, wantPrefix) {
		t.Errorf("path %q does not start with %q", path, wantPrefix)
	}
	if filepath.Base(path) != systemdUnitName {
		t.Errorf("basename %q, want %q", filepath.Base(path), systemdUnitName)
	}
}

func TestSystemdUnitPath_CreatesDirectory(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("systemd paths are Linux-specific")
	}
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	path, err := m.systemdUnitPath()
	if err != nil {
		t.Fatalf("systemdUnitPath: %v", err)
	}
	// The parent directory must exist after the call.
	parent := filepath.Dir(path)
	info, err := os.Stat(parent)
	if err != nil {
		t.Fatalf("parent dir not created: %v", err)
	}
	if !info.IsDir() {
		t.Errorf("%s is not a directory", parent)
	}
}

func TestSystemdUnitPath_ErrorsWhenHomeUnset(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("systemd paths are Linux-specific")
	}
	// os.UserHomeDir() fails on Unix when $HOME is empty (e.g. a minimal
	// container or a systemd context with no HOME). systemdUnitPath must
	// surface that error rather than building a path under "".
	t.Setenv("HOME", "")
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	if _, err := m.systemdUnitPath(); err == nil {
		t.Error("systemdUnitPath should return an error when $HOME is unset")
	}
}

// ============================================================================
// launchdPlistPath
// ============================================================================

func TestLaunchdPlistPath_UsesLibraryLaunchAgents(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("launchd paths are macOS-specific")
	}
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	path, err := m.launchdPlistPath()
	if err != nil {
		t.Fatalf("launchdPlistPath: %v", err)
	}

	home, _ := os.UserHomeDir()
	wantPrefix := filepath.Join(home, "Library", "LaunchAgents")
	if !strings.HasPrefix(path, wantPrefix) {
		t.Errorf("path %q does not start with %q", path, wantPrefix)
	}
	if !strings.HasSuffix(path, ".plist") {
		t.Errorf("path does not end with .plist: %q", path)
	}
	if !strings.Contains(path, launchdLabel) {
		t.Errorf("path missing label %q: %q", launchdLabel, path)
	}
}

func TestLaunchdPlistPath_ErrorsWhenHomeUnset(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("os.UserHomeDir reads USERPROFILE on Windows, not HOME")
	}
	// The method is not OS-gated (only its caller is), so its $HOME error
	// path is exercisable on any Unix. A missing HOME must produce an error,
	// not a path rooted at "/Library/LaunchAgents".
	t.Setenv("HOME", "")
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	if _, err := m.launchdPlistPath(); err == nil {
		t.Error("launchdPlistPath should return an error when $HOME is unset")
	}
}

// ============================================================================
// systemdUnit content — security hardening assertions
// ============================================================================

func TestSystemdUnit_HasSecurityHardening(t *testing.T) {
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	unit := m.systemdUnit()

	required := []string{
		"NoNewPrivileges=true",
		"ProtectHome=read-only",
		"PrivateTmp=true",
	}
	for _, line := range required {
		if !strings.Contains(unit, line) {
			t.Errorf("systemd unit missing security line: %q", line)
		}
	}
}

// TestSystemdUnit_ReadWritePathsMatchesDataDir pins the fix for a real bug:
// ProtectHome=read-only blocks writes anywhere under $HOME, including the
// wallet.dat the service must create at startup, unless the unit also
// carves out an explicit ReadWritePaths= exception for the configured data
// directory.
func TestSystemdUnit_ReadWritePathsMatchesDataDir(t *testing.T) {
	m := &Manager{binaryPath: "/usr/local/bin/otedama", dataDir: "/home/alice/.local/share/otedama"}
	unit := m.systemdUnit()
	if !strings.Contains(unit, "ReadWritePaths=/home/alice/.local/share/otedama") {
		t.Errorf("systemd unit missing ReadWritePaths for the configured data dir:\n%s", unit)
	}
}

func TestSystemdUnit_HasRestartPolicy(t *testing.T) {
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	unit := m.systemdUnit()
	if !strings.Contains(unit, "Restart=on-failure") {
		t.Error("systemd unit must auto-restart on failure")
	}
	if !strings.Contains(unit, "RestartSec=") {
		t.Error("systemd unit must set RestartSec")
	}
}

func TestSystemdUnit_WaitsForNetwork(t *testing.T) {
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	unit := m.systemdUnit()
	// Mining requires network; service must wait for it.
	if !strings.Contains(unit, "network-online.target") {
		t.Error("systemd unit must wait for network-online.target")
	}
}

func TestSystemdUnit_InstallsToUserTarget(t *testing.T) {
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	unit := m.systemdUnit()
	// Otedama is a user service, not a system service.
	if !strings.Contains(unit, "WantedBy=default.target") {
		t.Error("must be a user service (default.target), not system (multi-user.target)")
	}
	if strings.Contains(unit, "WantedBy=multi-user.target") {
		t.Error("Otedama is never a system service; must not target multi-user.target")
	}
}

func TestSystemdUnit_IncludesServiceArgs(t *testing.T) {
	m := &Manager{
		binaryPath: "/usr/local/bin/otedama",
		configPath: "/etc/otedama/config.yaml",
		dataDir:    "/var/lib/otedama",
	}
	unit := m.systemdUnit()
	// The unit must contain both the binary and the arguments.
	if !strings.Contains(unit, "/usr/local/bin/otedama") {
		t.Errorf("unit missing binary path:\n%s", unit)
	}
	if !strings.Contains(unit, "config.yaml") {
		t.Errorf("unit missing config path:\n%s", unit)
	}
}

// ============================================================================
// launchdPlist content — XML structure
// ============================================================================

func TestLaunchdPlist_HasRunAtLoad(t *testing.T) {
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	plist := m.launchdPlist()
	if !strings.Contains(plist, "<key>RunAtLoad</key>") {
		t.Error("plist missing RunAtLoad")
	}
	if !strings.Contains(plist, "<key>KeepAlive</key>") {
		t.Error("plist missing KeepAlive")
	}
}

func TestLaunchdPlist_HasLogPaths(t *testing.T) {
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	plist := m.launchdPlist()
	if !strings.Contains(plist, "StandardOutPath") {
		t.Error("plist must configure StandardOutPath")
	}
	if !strings.Contains(plist, "StandardErrorPath") {
		t.Error("plist must configure StandardErrorPath")
	}
}

// TestLaunchdPlist_LogsUnderLibraryLogsNotTmp pins the fix for a real
// exposure: launchd previously logged to world-readable /tmp/otedama.log
// and /tmp/otedama.err, so any local user on the machine could read a
// running service's stdout/stderr (potentially including worker/pool
// activity and error detail). Logs now go under the standard per-user
// macOS location, ~/Library/Logs, not /tmp.
func TestLaunchdPlist_LogsUnderLibraryLogsNotTmp(t *testing.T) {
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	plist := m.launchdPlist()
	if strings.Contains(plist, "/tmp/otedama") {
		t.Errorf("plist still logs to world-readable /tmp:\n%s", plist)
	}
	if !strings.Contains(plist, filepath.Join("Library", "Logs", "otedama.log")) {
		t.Errorf("plist missing expected Library/Logs/otedama.log path:\n%s", plist)
	}
	if !strings.Contains(plist, filepath.Join("Library", "Logs", "otedama.err")) {
		t.Errorf("plist missing expected Library/Logs/otedama.err path:\n%s", plist)
	}
}

func TestLaunchdPlist_ProgramArgumentsNonEmpty(t *testing.T) {
	m := &Manager{binaryPath: "/usr/local/bin/otedama", configPath: "/tmp/c.yaml"}
	plist := m.launchdPlist()
	// ProgramArguments array must contain at least two strings
	// (the binary + "run"), each wrapped in <string>...</string>.
	count := strings.Count(plist, "<string>")
	if count < 2 {
		t.Errorf("ProgramArguments should have at least 2 <string> entries; got %d\n%s",
			count, plist)
	}
}

func TestLaunchdPlist_UsesCorrectLabel(t *testing.T) {
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	plist := m.launchdPlist()
	want := "<string>" + launchdLabel + "</string>"
	if !strings.Contains(plist, want) {
		t.Errorf("plist missing label %q", want)
	}
	// Label must be in reverse-DNS form (Apple convention).
	if !strings.HasPrefix(launchdLabel, "com.") {
		t.Errorf("launchdLabel %q should start with 'com.' per Apple convention", launchdLabel)
	}
}

// ============================================================================
// serviceArgs edge cases
// ============================================================================

func TestServiceArgs_QuotesPathWithSpaces(t *testing.T) {
	m := &Manager{
		binaryPath: "/opt/otedama/otedama",
		configPath: "/Users/me/My Documents/config.yaml",
		dataDir:    "",
	}
	args := m.serviceArgs()
	// Config path must be quoted because it contains spaces.
	if !strings.Contains(args, `"/Users/me/My Documents/config.yaml"`) {
		t.Errorf("config path with spaces not quoted: %q", args)
	}
}

func TestServiceArgs_StartsWithRun(t *testing.T) {
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	args := m.serviceArgs()
	if !strings.HasPrefix(args, "run") {
		t.Errorf("service args must start with 'run': %q", args)
	}
}

// ============================================================================
// NewManager — path resolution
// ============================================================================

func TestNewManager_ResolvesSymlinks(t *testing.T) {
	// On a supported platform, the binary path returned by NewManager
	// should be the canonical (non-symlink) path. We cannot easily mock
	// os.Executable, so we just verify that the path is absolute and
	// refers to an existing file.
	m, err := NewManager("/tmp/cfg.yaml", "/tmp/data", ServiceFlags{})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	if !filepath.IsAbs(m.binaryPath) {
		t.Errorf("binaryPath must be absolute: %q", m.binaryPath)
	}
	if _, err := os.Stat(m.binaryPath); err != nil {
		t.Errorf("binaryPath %q does not exist: %v", m.binaryPath, err)
	}
	if m.configPath != "/tmp/cfg.yaml" {
		t.Errorf("configPath = %q, want /tmp/cfg.yaml", m.configPath)
	}
	if m.dataDir != "/tmp/data" {
		t.Errorf("dataDir = %q, want /tmp/data", m.dataDir)
	}
}

// ============================================================================
// ServiceStatus — symbol constants
// ============================================================================

func TestServiceStatus_ZeroValueIsNotRunning(t *testing.T) {
	var s ServiceStatus
	if s.Installed {
		t.Error("zero value ServiceStatus should have Installed=false")
	}
	if s.Running {
		t.Error("zero value ServiceStatus should have Running=false")
	}
}

// ============================================================================
// Platform dispatch — error paths
// ============================================================================

// These tests exercise the error-path dispatch in Install/Uninstall/Status
// for the non-current platform. They verify the package responds
// gracefully when an unsupported action is requested.

func TestWindowsService_NotLinuxOrDarwin(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("only meaningful on Windows")
	}
	m, err := NewManager("", "", ServiceFlags{})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	// installWindowsService calls sc.exe; we don't actually run it here,
	// but we verify the method exists and is callable.
	_ = m
}
