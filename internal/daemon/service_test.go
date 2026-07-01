// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package daemon

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// realRunCmd captures the original runCmd before any test replaces it.
var realRunCmd = runCmd

// realGoos captures the real GOOS before any test overrides it.
var realGoos = goos

// mockRunCmd installs a stub and restores the original on test cleanup.
func mockRunCmd(t *testing.T, fn func(name string, args ...string) error) {
	t.Helper()
	orig := runCmd
	t.Cleanup(func() { runCmd = orig })
	runCmd = fn
}

// setGoos overrides goos for the duration of the test.
func setGoos(t *testing.T, os string) {
	t.Helper()
	t.Cleanup(func() { goos = realGoos })
	goos = os
}

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

func TestSystemdUnit_QuotesBinaryPathWithSpaces(t *testing.T) {
	// A binary installed under a path containing a space (e.g. a home dir like
	// "/home/John Doe/bin/otedama") must be quoted in ExecStart, or systemd
	// parses the executable as the substring before the first space and the
	// service silently fails to start.
	m := &Manager{
		binaryPath: "/home/John Doe/bin/otedama",
		configPath: "/home/John Doe/config.yaml",
	}
	unit := m.systemdUnit()
	if !strings.Contains(unit, `ExecStart="/home/John Doe/bin/otedama"`) {
		t.Errorf("systemd ExecStart did not quote a binary path with spaces; got:\n%s", unit)
	}
	// The config path (an arg) must likewise be quoted.
	if !strings.Contains(unit, `"/home/John Doe/config.yaml"`) {
		t.Errorf("systemd ExecStart did not quote a config path with spaces; got:\n%s", unit)
	}
}

func TestSystemdUnit_DoesNotQuoteSimpleBinaryPath(t *testing.T) {
	// A normal path with no spaces must remain unquoted (clean output, and
	// the previous behaviour for the common case is preserved).
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	unit := m.systemdUnit()
	if !strings.Contains(unit, "ExecStart=/usr/local/bin/otedama run") {
		t.Errorf("systemd ExecStart should leave a space-free path unquoted; got:\n%s", unit)
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

// ----- runCmd real implementation -----

func TestRunCmd_SucceedsOnZeroExit(t *testing.T) {
	mockRunCmd(t, realRunCmd)
	if err := runCmd("true"); err != nil {
		t.Errorf("runCmd true: %v", err)
	}
}

func TestRunCmd_FailsOnNonZeroExit(t *testing.T) {
	mockRunCmd(t, realRunCmd)
	if err := runCmd("false"); err == nil {
		t.Error("runCmd false: expected non-nil error")
	}
}

// ----- systemdUnitPath -----

func TestSystemdUnitPath_ReturnsNonEmptyPath(t *testing.T) {
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	path, err := m.systemdUnitPath()
	if err != nil {
		t.Fatalf("systemdUnitPath: %v", err)
	}
	if path == "" {
		t.Error("systemdUnitPath returned empty string")
	}
	if !strings.HasSuffix(path, systemdUnitName) {
		t.Errorf("systemdUnitPath = %q, want suffix %q", path, systemdUnitName)
	}
}

// ----- installSystemd -----

func TestInstallSystemd_CallsSystemctlTwice(t *testing.T) {
	var calls []string
	mockRunCmd(t, func(name string, args ...string) error {
		calls = append(calls, strings.Join(append([]string{name}, args...), " "))
		return nil
	})

	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	path, err := m.systemdUnitPath()
	if err != nil {
		t.Fatalf("systemdUnitPath: %v", err)
	}
	t.Cleanup(func() { os.Remove(path) })

	if err := m.installSystemd(); err != nil {
		t.Fatalf("installSystemd: %v", err)
	}
	if len(calls) != 2 {
		t.Errorf("expected 2 runCmd calls, got %d: %v", len(calls), calls)
	}
}

func TestInstallSystemd_DaemonReloadError(t *testing.T) {
	callCount := 0
	mockRunCmd(t, func(name string, args ...string) error {
		callCount++
		if callCount == 1 {
			return errors.New("systemctl: not found")
		}
		return nil
	})

	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	path, err := m.systemdUnitPath()
	if err != nil {
		t.Fatalf("systemdUnitPath: %v", err)
	}
	t.Cleanup(func() { os.Remove(path) })

	if err := m.installSystemd(); err == nil {
		t.Error("expected error when daemon-reload fails")
	}
}

func TestInstallSystemd_EnableError(t *testing.T) {
	callCount := 0
	mockRunCmd(t, func(name string, args ...string) error {
		callCount++
		if callCount == 2 {
			return errors.New("systemctl enable: failed")
		}
		return nil
	})

	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	path, err := m.systemdUnitPath()
	if err != nil {
		t.Fatalf("systemdUnitPath: %v", err)
	}
	t.Cleanup(func() { os.Remove(path) })

	if err := m.installSystemd(); err == nil {
		t.Error("expected error when systemctl enable fails")
	}
}

// ----- uninstallSystemd -----

func TestUninstallSystemd_Success(t *testing.T) {
	mockRunCmd(t, func(name string, args ...string) error { return nil })

	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	path, err := m.systemdUnitPath()
	if err != nil {
		t.Fatalf("systemdUnitPath: %v", err)
	}
	if err := os.WriteFile(path, []byte("[Unit]\n"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	if err := m.uninstallSystemd(); err != nil {
		t.Fatalf("uninstallSystemd: %v", err)
	}
}

func TestUninstallSystemd_FileNotFound(t *testing.T) {
	mockRunCmd(t, func(name string, args ...string) error { return nil })

	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	path, err := m.systemdUnitPath()
	if err != nil {
		t.Fatalf("systemdUnitPath: %v", err)
	}
	os.Remove(path) // ensure absent

	if err := m.uninstallSystemd(); err == nil {
		t.Error("expected error when unit file is absent")
	}
}

// ----- statusSystemd -----

func TestStatusSystemd_ReturnsWithoutPanic(t *testing.T) {
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	st, err := m.statusSystemd()
	if err != nil {
		t.Fatalf("statusSystemd: %v", err)
	}
	// Running==false is expected in CI where systemd user session is absent.
	_ = st.Installed
	_ = st.Running
}

// ----- launchdPlistPath -----

func TestLaunchdPlistPath_ReturnsNonEmptyPath(t *testing.T) {
	m := &Manager{}
	path, err := m.launchdPlistPath()
	if err != nil {
		t.Fatalf("launchdPlistPath: %v", err)
	}
	if path == "" {
		t.Error("launchdPlistPath returned empty string")
	}
	if !strings.HasSuffix(path, launchdLabel+".plist") {
		t.Errorf("launchdPlistPath = %q, want suffix %q", path, launchdLabel+".plist")
	}
}

// ----- installLaunchd -----

func TestInstallLaunchd_CallsLaunchctl(t *testing.T) {
	var called string
	mockRunCmd(t, func(name string, args ...string) error {
		called = name
		return nil
	})

	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	path, err := m.launchdPlistPath()
	if err != nil {
		t.Fatalf("launchdPlistPath: %v", err)
	}
	t.Cleanup(func() { os.Remove(path) })

	if err := m.installLaunchd(); err != nil {
		t.Fatalf("installLaunchd: %v", err)
	}
	if called != "launchctl" {
		t.Errorf("expected launchctl, got %q", called)
	}
}

func TestInstallLaunchd_RunCmdError(t *testing.T) {
	mockRunCmd(t, func(name string, args ...string) error {
		return errors.New("launchctl: not found")
	})

	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	path, err := m.launchdPlistPath()
	if err != nil {
		t.Fatalf("launchdPlistPath: %v", err)
	}
	t.Cleanup(func() { os.Remove(path) })

	if err := m.installLaunchd(); err == nil {
		t.Error("expected error when launchctl fails")
	}
}

// ----- uninstallLaunchd -----

func TestUninstallLaunchd_Success(t *testing.T) {
	mockRunCmd(t, func(name string, args ...string) error { return nil })

	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	path, err := m.launchdPlistPath()
	if err != nil {
		t.Fatalf("launchdPlistPath: %v", err)
	}
	if err := os.WriteFile(path, []byte("<plist/>"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	if err := m.uninstallLaunchd(); err != nil {
		t.Fatalf("uninstallLaunchd: %v", err)
	}
}

// ----- statusLaunchd -----

func TestStatusLaunchd_ReturnsWithoutPanic(t *testing.T) {
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	st, err := m.statusLaunchd()
	if err != nil {
		t.Fatalf("statusLaunchd: %v", err)
	}
	_ = st.Installed
	_ = st.Running
}

// ----- installWindowsService -----

func TestInstallWindowsService_CallsScExe(t *testing.T) {
	var called string
	mockRunCmd(t, func(name string, args ...string) error {
		called = name
		return nil
	})

	m := &Manager{binaryPath: `C:\otedama.exe`}
	if err := m.installWindowsService(); err != nil {
		t.Fatalf("installWindowsService: %v", err)
	}
	if called != "sc.exe" {
		t.Errorf("expected sc.exe, got %q", called)
	}
}

func TestInstallWindowsService_Error(t *testing.T) {
	mockRunCmd(t, func(name string, args ...string) error {
		return errors.New("sc.exe: access denied")
	})

	m := &Manager{binaryPath: `C:\otedama.exe`}
	if err := m.installWindowsService(); err == nil {
		t.Error("expected error when sc.exe fails")
	}
}

// ----- uninstallWindowsService -----

func TestUninstallWindowsService_StopErrorIsIgnored(t *testing.T) {
	callCount := 0
	mockRunCmd(t, func(name string, args ...string) error {
		callCount++
		if callCount == 1 {
			return errors.New("sc stop: service not running")
		}
		return nil
	})

	m := &Manager{binaryPath: `C:\otedama.exe`}
	if err := m.uninstallWindowsService(); err != nil {
		t.Fatalf("uninstallWindowsService: %v", err)
	}
	if callCount != 2 {
		t.Errorf("expected 2 calls (stop+delete), got %d", callCount)
	}
}

func TestUninstallWindowsService_DeleteError(t *testing.T) {
	callCount := 0
	mockRunCmd(t, func(name string, args ...string) error {
		callCount++
		if callCount == 2 {
			return errors.New("sc delete: failed")
		}
		return nil
	})

	m := &Manager{binaryPath: `C:\otedama.exe`}
	if err := m.uninstallWindowsService(); err == nil {
		t.Error("expected error when sc delete fails")
	}
}

// ----- statusWindowsService -----
//
// Install/Uninstall have always dispatched "windows" through
// installWindowsService/uninstallWindowsService; Status had no matching
// case at all and fell straight to "unsupported platform" regardless of
// GOOS. These tests, plus TestStatus_WindowsDispatch below, pin the fix.
// statusWindowsService shells out to sc.exe directly (not through the
// mockable runCmd, since it needs stdout — same as statusSystemd/
// statusLaunchd use exec.Command directly rather than runCmd), so on a
// non-Windows test runner sc.exe is simply not found and the not-installed
// branch is exercised — exactly like statusLaunchd's launchctl-not-found
// case degrades on Linux CI.

func TestStatusWindowsService_ReturnsWithoutPanic(t *testing.T) {
	m := &Manager{binaryPath: `C:\otedama.exe`}
	st, err := m.statusWindowsService()
	if err != nil {
		t.Fatalf("statusWindowsService: %v", err)
	}
	_ = st.Installed
	_ = st.Running
}

func TestStatusWindowsService_ScExeNotFound_ReportsNotInstalledNotError(t *testing.T) {
	// On any non-Windows test runner (and in CI), sc.exe does not exist, so
	// exec.Command's Output() returns an error. That must be reported as
	// "not installed" (zero-value ServiceStatus, nil error), not surfaced as
	// a Status() failure — the same treatment statusLaunchd gives a failed
	// launchctl invocation.
	m := &Manager{binaryPath: `C:\otedama.exe`}
	st, err := m.statusWindowsService()
	if runtime.GOOS == "windows" {
		t.Skip("this assertion only holds where sc.exe is genuinely absent")
	}
	if err != nil {
		t.Fatalf("statusWindowsService: got error %v, want nil (missing sc.exe means not-installed)", err)
	}
	if st.Installed {
		t.Error("Installed = true with no sc.exe on PATH; want false")
	}
	if st.Running {
		t.Error("Running = true with no sc.exe on PATH; want false")
	}
}

// ----- Install / Uninstall / Status top-level dispatch (Linux) -----

func TestInstall_Linux(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux-only")
	}
	mockRunCmd(t, func(name string, args ...string) error { return nil })

	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	path, err := m.systemdUnitPath()
	if err != nil {
		t.Fatalf("systemdUnitPath: %v", err)
	}
	t.Cleanup(func() { os.Remove(path) })

	if err := m.Install(); err != nil {
		t.Fatalf("Install: %v", err)
	}
}

func TestUninstall_Linux(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux-only")
	}
	mockRunCmd(t, func(name string, args ...string) error { return nil })

	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	path, err := m.systemdUnitPath()
	if err != nil {
		t.Fatalf("systemdUnitPath: %v", err)
	}
	if err := os.WriteFile(path, []byte("[Unit]\n"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	if err := m.Uninstall(); err != nil {
		t.Fatalf("Uninstall: %v", err)
	}
}

func TestStatus_Linux(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux-only")
	}
	m := makeTestManager(t)
	if _, err := m.Status(); err != nil {
		t.Fatalf("Status: %v", err)
	}
}

// ----- launchdPlist empty-arg skip branch -----

func TestLaunchdPlist_SkipsEmptyBinaryPath(t *testing.T) {
	m := &Manager{binaryPath: ""}
	plist := m.launchdPlist()
	// Empty binaryPath must not produce a bare <string></string> entry.
	if strings.Contains(plist, "<string></string>") {
		t.Error("plist contains empty <string> element; empty args should be skipped")
	}
}

// blockConfigDir creates a FILE at $HOME/.config to force os.MkdirAll to fail
// when systemdUnitPath tries to create $HOME/.config/systemd/user.
func blockConfigDir(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.WriteFile(filepath.Join(home, ".config"), []byte("block"), 0644); err != nil {
		t.Fatalf("blockConfigDir WriteFile: %v", err)
	}
}

// blockLibraryDir creates a FILE at $HOME/Library to force os.MkdirAll to fail
// when launchdPlistPath tries to create $HOME/Library/LaunchAgents.
func blockLibraryDir(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.WriteFile(filepath.Join(home, "Library"), []byte("block"), 0644); err != nil {
		t.Fatalf("blockLibraryDir WriteFile: %v", err)
	}
}

// ----- systemdUnitPath error branches -----

func TestSystemdUnitPath_MkdirAllError(t *testing.T) {
	blockConfigDir(t)
	m := &Manager{}
	if _, err := m.systemdUnitPath(); err == nil {
		t.Error("expected error when MkdirAll fails (file blocks directory creation)")
	}
}

// ----- installSystemd unit-path error branch -----

func TestInstallSystemd_UnitPathError(t *testing.T) {
	blockConfigDir(t)
	mockRunCmd(t, func(name string, args ...string) error { return nil })
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	if err := m.installSystemd(); err == nil {
		t.Error("expected error when systemd unit path cannot be created")
	}
}

// ----- uninstallSystemd unit-path error branch -----

func TestUninstallSystemd_UnitPathError(t *testing.T) {
	blockConfigDir(t)
	mockRunCmd(t, func(name string, args ...string) error { return nil })
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	if err := m.uninstallSystemd(); err == nil {
		t.Error("expected error when systemd unit path cannot be determined")
	}
}

// ----- launchdPlistPath error branch -----

func TestLaunchdPlistPath_MkdirAllError(t *testing.T) {
	blockLibraryDir(t)
	m := &Manager{}
	if _, err := m.launchdPlistPath(); err == nil {
		t.Error("expected error when MkdirAll fails (file blocks directory creation)")
	}
}

// ----- installLaunchd plist-path error branch -----

func TestInstallLaunchd_PlistPathError(t *testing.T) {
	blockLibraryDir(t)
	mockRunCmd(t, func(name string, args ...string) error { return nil })
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	if err := m.installLaunchd(); err == nil {
		t.Error("expected error when launchd plist path cannot be created")
	}
}

// ----- uninstallLaunchd plist-path error branch -----

func TestUninstallLaunchd_PlistPathError(t *testing.T) {
	blockLibraryDir(t)
	mockRunCmd(t, func(name string, args ...string) error { return nil })
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	if err := m.uninstallLaunchd(); err == nil {
		t.Error("expected error when launchd plist path cannot be determined")
	}
}

// ----- installSystemd WriteFile error branch -----

func TestInstallSystemd_WriteFileError(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	// Create a DIRECTORY where the unit FILE must go — os.WriteFile returns
	// "is a directory" even as root, which covers the error branch.
	unitPath := filepath.Join(home, ".config", "systemd", "user", systemdUnitName)
	if err := os.MkdirAll(unitPath, 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	mockRunCmd(t, func(name string, args ...string) error { return nil })
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	if err := m.installSystemd(); err == nil {
		t.Error("expected error when WriteFile fails (path is a directory)")
	}
}

// ----- installLaunchd WriteFile error branch -----

func TestInstallLaunchd_WriteFileError(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	// Create a DIRECTORY at the plist path to force WriteFile to fail.
	plistPath := filepath.Join(home, "Library", "LaunchAgents", launchdLabel+".plist")
	if err := os.MkdirAll(plistPath, 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	mockRunCmd(t, func(name string, args ...string) error { return nil })
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	if err := m.installLaunchd(); err == nil {
		t.Error("expected error when WriteFile fails (path is a directory)")
	}
}

// ----- platform dispatch via injectable goos var -----

func TestInstall_DarwinDispatch(t *testing.T) {
	setGoos(t, "darwin")
	mockRunCmd(t, func(name string, args ...string) error { return nil })
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	path, err := m.launchdPlistPath()
	if err != nil {
		t.Fatalf("launchdPlistPath: %v", err)
	}
	t.Cleanup(func() { os.Remove(path) })
	if err := m.Install(); err != nil {
		t.Fatalf("Install (darwin): %v", err)
	}
}

func TestInstall_WindowsDispatch(t *testing.T) {
	setGoos(t, "windows")
	mockRunCmd(t, func(name string, args ...string) error { return nil })
	m := &Manager{binaryPath: `C:\otedama.exe`}
	if err := m.Install(); err != nil {
		t.Fatalf("Install (windows): %v", err)
	}
}

func TestInstall_UnsupportedPlatform(t *testing.T) {
	setGoos(t, "plan9")
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	if err := m.Install(); err == nil {
		t.Error("Install on unsupported platform should return error")
	}
}

func TestUninstall_DarwinDispatch(t *testing.T) {
	setGoos(t, "darwin")
	mockRunCmd(t, func(name string, args ...string) error { return nil })
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	path, err := m.launchdPlistPath()
	if err != nil {
		t.Fatalf("launchdPlistPath: %v", err)
	}
	if err := os.WriteFile(path, []byte("<plist/>"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := m.Uninstall(); err != nil {
		t.Fatalf("Uninstall (darwin): %v", err)
	}
}

func TestUninstall_WindowsDispatch(t *testing.T) {
	setGoos(t, "windows")
	mockRunCmd(t, func(name string, args ...string) error { return nil })
	m := &Manager{binaryPath: `C:\otedama.exe`}
	if err := m.Uninstall(); err != nil {
		t.Fatalf("Uninstall (windows): %v", err)
	}
}

func TestUninstall_UnsupportedPlatform(t *testing.T) {
	setGoos(t, "plan9")
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	if err := m.Uninstall(); err == nil {
		t.Error("Uninstall on unsupported platform should return error")
	}
}

func TestStatus_DarwinDispatch(t *testing.T) {
	setGoos(t, "darwin")
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	if _, err := m.Status(); err != nil {
		t.Fatalf("Status (darwin): %v", err)
	}
}

func TestStatus_WindowsDispatch(t *testing.T) {
	// Before this fix, Status() had no "windows" case at all and returned
	// "unsupported platform" unconditionally on Windows, even though
	// Install/Uninstall both support it — this pins that Status now
	// dispatches windows to statusWindowsService rather than falling to
	// the default/error branch.
	setGoos(t, "windows")
	m := &Manager{binaryPath: `C:\otedama.exe`}
	if _, err := m.Status(); err != nil {
		t.Fatalf("Status (windows): %v", err)
	}
}

func TestStatus_UnsupportedPlatform(t *testing.T) {
	setGoos(t, "plan9")
	m := &Manager{binaryPath: "/usr/local/bin/otedama"}
	if _, err := m.Status(); err == nil {
		t.Error("Status on unsupported platform should return error")
	}
}
