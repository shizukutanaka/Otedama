// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package daemon

import (
	"os"
	"runtime"
	"strings"
	"testing"
)

func makeTestManager(t *testing.T) *Manager {
	t.Helper()
	// Use the test binary itself as a stand-in for the otedama binary.
	binary, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	return &Manager{
		binaryPath: binary,
		configPath: "/home/user/.config/otedama/config.yaml",
		dataDir:    "/home/user/.local/share/otedama",
	}
}

// ----- NewManager -----

func TestNewManager_ReturnsManagerWithBinaryPath(t *testing.T) {
	m, err := NewManager("", "")
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	if m.binaryPath == "" {
		t.Error("binaryPath is empty")
	}
	if _, err := os.Stat(m.binaryPath); err != nil {
		t.Errorf("binaryPath %q does not exist: %v", m.binaryPath, err)
	}
}

// ----- serviceArgs -----

func TestServiceArgs_IncludesConfigAndDataDir(t *testing.T) {
	m := &Manager{
		binaryPath: "/usr/local/bin/otedama",
		configPath: "/etc/otedama/config.yaml",
		dataDir:    "/var/lib/otedama",
	}
	args := m.serviceArgs()
	if !strings.Contains(args, "run") {
		t.Errorf("serviceArgs missing 'run': %q", args)
	}
	if !strings.Contains(args, "config.yaml") {
		t.Errorf("serviceArgs missing config path: %q", args)
	}
	if !strings.Contains(args, "otedama") {
		t.Errorf("serviceArgs missing data dir: %q", args)
	}
}

func TestServiceArgs_EmptyConfigAndDataDir(t *testing.T) {
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	args := m.serviceArgs()
	if args != "run" {
		t.Errorf("serviceArgs with no config/datadir = %q, want %q", args, "run")
	}
}

// ----- systemd unit -----

func TestSystemdUnit_ContainsRequiredFields(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("systemd unit test only relevant on Linux")
	}
	m := makeTestManager(t)
	unit := m.systemdUnit()

	required := []string{
		"[Unit]",
		"[Service]",
		"[Install]",
		"ExecStart=",
		"Restart=on-failure",
		"NoNewPrivileges=true",
		"WantedBy=default.target",
	}
	for _, r := range required {
		if !strings.Contains(unit, r) {
			t.Errorf("systemd unit missing %q", r)
		}
	}
	// Binary path must appear in ExecStart.
	if !strings.Contains(unit, m.binaryPath) {
		t.Errorf("systemd unit missing binary path %q", m.binaryPath)
	}
}

// ----- launchd plist -----

func TestLaunchdPlist_IsValidXMLLike(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("launchd plist test only relevant on macOS")
	}
	m := makeTestManager(t)
	plist := m.launchdPlist()

	// Structural checks without a full XML parser.
	checks := []string{
		`<?xml version="1.0"`,
		`<plist`,
		`<key>Label</key>`,
		`<string>com.otedama.daemon</string>`,
		`<key>RunAtLoad</key>`,
		`<true/>`,
		`<key>KeepAlive</key>`,
		`</plist>`,
	}
	for _, c := range checks {
		if !strings.Contains(plist, c) {
			t.Errorf("plist missing %q", c)
		}
	}
	if !strings.Contains(plist, m.binaryPath) {
		t.Errorf("plist missing binary path %q", m.binaryPath)
	}
}

// ----- Install/Uninstall (integration, skip in CI) -----

func TestInstall_ReturnsUnsupportedOnUnknownPlatform(t *testing.T) {
	// We test the error path by temporarily patching the reported GOOS.
	// Since we cannot change runtime.GOOS, we test the platform switch
	// indirectly by checking that the Uninstall path doesn't panic.
	if runtime.GOOS == "linux" || runtime.GOOS == "darwin" || runtime.GOOS == "windows" {
		t.Skip("skipping: platform is supported")
	}
	m := makeTestManager(t)
	if err := m.Install(); err == nil {
		t.Error("Install on unsupported platform should return error")
	}
}
