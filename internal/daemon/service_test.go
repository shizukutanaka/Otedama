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
	m, err := NewManager("", "", ServiceFlags{})
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

func TestServiceArgs_IncludesBitcoinAddress(t *testing.T) {
	m := &Manager{
		binaryPath: "/usr/local/bin/otedama",
		serviceFlags: ServiceFlags{
			BitcoinAddress: "bc1qjaet6jgpk08la46jelmlpgsz84luc4lc0tnwr5",
		},
	}
	args := m.serviceArgs()
	if !strings.Contains(args, "--bitcoin-address") {
		t.Errorf("serviceArgs missing --bitcoin-address: %q", args)
	}
	if !strings.Contains(args, "bc1qjaet6jgpk08la46jelmlpgsz84luc4lc0tnwr5") {
		t.Errorf("serviceArgs missing address value: %q", args)
	}
}

func TestServiceArgs_IncludesAllFlags(t *testing.T) {
	m := &Manager{
		binaryPath: "/usr/local/bin/otedama",
		configPath: "/etc/otedama/config.yaml",
		dataDir:    "/var/lib/otedama",
		serviceFlags: ServiceFlags{
			BitcoinAddress: "bc1qtest",
			LogLevel:       "debug",
			LogFormat:      "json",
			Language:       "ja",
		},
	}
	args := m.serviceArgs()
	for _, want := range []string{
		"--config", "--data-dir",
		"--bitcoin-address", "bc1qtest",
		"--log-level", "debug",
		"--log-format", "json",
		"--language", "ja",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("serviceArgs missing %q: %q", want, args)
		}
	}
}

func TestServiceArgv_PreservesValuesWithSpaces(t *testing.T) {
	m := &Manager{
		binaryPath: "/opt/otedama",
		configPath: "/Users/John Doe/config.yaml",
		dataDir:    "/var/lib/otedama",
	}
	argv := m.serviceArgv()
	// The config path with a space must be a single element, not split.
	found := false
	for _, a := range argv {
		if a == "/Users/John Doe/config.yaml" {
			found = true
		}
	}
	if !found {
		t.Errorf("serviceArgv split a path with spaces: %#v", argv)
	}
}

func TestLaunchdPlist_PathWithSpacesIsSingleString(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("launchd plist test only relevant on macOS")
	}
	m := &Manager{
		binaryPath: "/opt/otedama",
		configPath: "/Users/John Doe/config.yaml",
	}
	plist := m.launchdPlist()
	if !strings.Contains(plist, "<string>/Users/John Doe/config.yaml</string>") {
		t.Errorf("plist split a path with spaces; got:\n%s", plist)
	}
}

func TestXMLEscape(t *testing.T) {
	got := xmlEscape(`a&b<c>d"e'f`)
	want := "a&amp;b&lt;c&gt;d&quot;e&apos;f"
	if got != want {
		t.Errorf("xmlEscape = %q, want %q", got, want)
	}
}

func TestServiceArgs_EmptyFlagsOmitted(t *testing.T) {
	m := &Manager{
		binaryPath:   "/usr/local/bin/otedama",
		serviceFlags: ServiceFlags{},
	}
	args := m.serviceArgs()
	for _, unwanted := range []string{"--bitcoin-address", "--log-level", "--log-format", "--language"} {
		if strings.Contains(args, unwanted) {
			t.Errorf("serviceArgs should not contain %q when flag is empty: %q", unwanted, args)
		}
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
