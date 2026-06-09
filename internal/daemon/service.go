// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package daemon provides cross-platform service installation for Otedama.
//
// Running Otedama as a background service is what makes the product
// promise "your computer earns while you sleep" actually true. A process
// that requires a terminal to stay open does not run while the user sleeps.
//
// This package supports:
//
//	Linux:   systemd user service (no root required)
//	macOS:   launchd LaunchAgent (no root required)
//	Windows: Windows Service via sc.exe (requires admin)
//
// # Why no root on Linux/macOS?
//
// User services (systemd --user, LaunchAgent) start when the user logs
// in and stop when they log out. This is the correct model for a home
// mining tool: it runs when the user's session is active, not as a
// privileged system daemon. Requiring root would be a security
// over-reach for software that touches the user's Bitcoin wallet.
package daemon

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// ServiceStatus describes the current state of the Otedama service.
type ServiceStatus struct {
	Installed bool
	Running   bool
	PID       int
	Details   string
}

// ServiceFlags holds optional run-time flags to embed in the installed service
// definition. Flags left empty are omitted from the service command line;
// those settings fall back to the config file or built-in defaults at
// service startup (the same precedence as a direct `otedama run` invocation).
//
// At minimum, set BitcoinAddress when no config file is specified — without
// at least one payout address the service will fail to start (exit 78).
type ServiceFlags struct {
	BitcoinAddress string // --bitcoin-address
	LogLevel       string // --log-level  (debug|info|warn|error)
	LogFormat      string // --log-format (text|json)
	Language       string // --language   (en, ja, …)
}

// Manager installs, uninstalls, starts, stops, and queries the Otedama
// background service for the current platform.
type Manager struct {
	binaryPath   string // absolute path to the otedama executable
	configPath   string // path to config.yaml to pass to the service
	dataDir      string // data directory for the service instance
	serviceFlags ServiceFlags
}

// NewManager creates a Manager using the current executable as the
// service binary. It returns an error if the current executable path
// cannot be determined.
func NewManager(configPath, dataDir string, flags ServiceFlags) (*Manager, error) {
	binary, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("daemon: cannot determine executable path: %w", err)
	}
	// Resolve symlinks so the service always points to the real binary.
	binary, err = filepath.EvalSymlinks(binary)
	if err != nil {
		return nil, fmt.Errorf("daemon: resolve symlink: %w", err)
	}
	return &Manager{
		binaryPath:   binary,
		configPath:   configPath,
		dataDir:      dataDir,
		serviceFlags: flags,
	}, nil
}

// Install writes the service definition and enables auto-start.
func (m *Manager) Install() error {
	switch runtime.GOOS {
	case "linux":
		return m.installSystemd()
	case "darwin":
		return m.installLaunchd()
	case "windows":
		return m.installWindowsService()
	default:
		return fmt.Errorf("daemon: unsupported platform %q", runtime.GOOS)
	}
}

// Uninstall removes the service definition and disables auto-start.
func (m *Manager) Uninstall() error {
	switch runtime.GOOS {
	case "linux":
		return m.uninstallSystemd()
	case "darwin":
		return m.uninstallLaunchd()
	case "windows":
		return m.uninstallWindowsService()
	default:
		return fmt.Errorf("daemon: unsupported platform %q", runtime.GOOS)
	}
}

// Status returns the current service state.
func (m *Manager) Status() (ServiceStatus, error) {
	switch runtime.GOOS {
	case "linux":
		return m.statusSystemd()
	case "darwin":
		return m.statusLaunchd()
	default:
		return ServiceStatus{}, fmt.Errorf("daemon: unsupported platform %q", runtime.GOOS)
	}
}

// ----- Linux / systemd -----

// systemdUnitName is the name of the systemd user unit file.
const systemdUnitName = "otedama.service"

func (m *Manager) systemdUnitPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".config", "systemd", "user")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	return filepath.Join(dir, systemdUnitName), nil
}

func (m *Manager) installSystemd() error {
	path, err := m.systemdUnitPath()
	if err != nil {
		return fmt.Errorf("daemon: systemd unit dir: %w", err)
	}

	unit := m.systemdUnit()
	if err := os.WriteFile(path, []byte(unit), 0644); err != nil {
		return fmt.Errorf("daemon: write systemd unit: %w", err)
	}
	// Reload daemon and enable the unit.
	if err := runCmd("systemctl", "--user", "daemon-reload"); err != nil {
		return fmt.Errorf("daemon: systemctl daemon-reload: %w", err)
	}
	if err := runCmd("systemctl", "--user", "enable", "--now", systemdUnitName); err != nil {
		return fmt.Errorf("daemon: systemctl enable: %w", err)
	}
	return nil
}

func (m *Manager) uninstallSystemd() error {
	_ = runCmd("systemctl", "--user", "disable", "--now", systemdUnitName)
	path, err := m.systemdUnitPath()
	if err != nil {
		return err
	}
	return os.Remove(path)
}

func (m *Manager) statusSystemd() (ServiceStatus, error) {
	path, _ := m.systemdUnitPath()
	_, statErr := os.Stat(path)
	installed := statErr == nil

	out, err := exec.Command("systemctl", "--user", "is-active", systemdUnitName).Output()
	running := err == nil && strings.TrimSpace(string(out)) == "active"

	return ServiceStatus{
		Installed: installed,
		Running:   running,
		Details:   string(out),
	}, nil
}

func (m *Manager) systemdUnit() string {
	args := m.serviceArgs()
	return fmt.Sprintf(`[Unit]
Description=Otedama — non-custodial compute arbitration
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%s %s
Restart=on-failure
RestartSec=10s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=otedama

# Security hardening
NoNewPrivileges=true
ProtectHome=read-only
PrivateTmp=true

[Install]
WantedBy=default.target
`, m.binaryPath, args)
}

// ----- macOS / launchd -----

const launchdLabel = "com.otedama.daemon"

func (m *Manager) launchdPlistPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, "Library", "LaunchAgents")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	return filepath.Join(dir, launchdLabel+".plist"), nil
}

func (m *Manager) installLaunchd() error {
	path, err := m.launchdPlistPath()
	if err != nil {
		return err
	}
	plist := m.launchdPlist()
	if err := os.WriteFile(path, []byte(plist), 0644); err != nil {
		return fmt.Errorf("daemon: write plist: %w", err)
	}
	return runCmd("launchctl", "load", "-w", path)
}

func (m *Manager) uninstallLaunchd() error {
	path, err := m.launchdPlistPath()
	if err != nil {
		return err
	}
	_ = runCmd("launchctl", "unload", "-w", path)
	return os.Remove(path)
}

func (m *Manager) statusLaunchd() (ServiceStatus, error) {
	path, _ := m.launchdPlistPath()
	_, statErr := os.Stat(path)
	installed := statErr == nil

	out, err := exec.Command("launchctl", "list", launchdLabel).Output()
	running := err == nil && !strings.Contains(string(out), "Could not find")

	return ServiceStatus{
		Installed: installed,
		Running:   running,
		Details:   string(out),
	}, nil
}

func (m *Manager) launchdPlist() string {
	// Build the ProgramArguments array from the canonical argv slice so a
	// path or value containing spaces is emitted as a single <string>
	// rather than split across entries. Each value is XML-escaped because
	// it may contain characters that are significant in XML (e.g. '&').
	argv := append([]string{m.binaryPath}, m.serviceArgv()...)
	var argEntries strings.Builder
	for _, a := range argv {
		if a == "" {
			continue
		}
		fmt.Fprintf(&argEntries, "\t\t<string>%s</string>\n", xmlEscape(a))
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
    "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>%s</string>
    <key>ProgramArguments</key>
    <array>
%s    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/otedama.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/otedama.err</string>
</dict>
</plist>
`, launchdLabel, argEntries.String())
}

// ----- Windows service -----

func (m *Manager) installWindowsService() error {
	args := fmt.Sprintf(`"%s" %s`, m.binaryPath, m.serviceArgs())
	return runCmd("sc.exe", "create", "Otedama",
		"binPath=", args,
		"start=", "auto",
		"DisplayName=", "Otedama Mining Service")
}

func (m *Manager) uninstallWindowsService() error {
	_ = runCmd("sc.exe", "stop", "Otedama")
	return runCmd("sc.exe", "delete", "Otedama")
}

// ----- Helpers -----

// serviceArgv returns the service command-line arguments as a slice, with
// no shell quoting. This is the canonical form: serviceArgs joins it into a
// single string for systemd ExecStart= and Windows sc.exe binPath= (both of
// which parse their own quoting), and launchdPlist consumes the slice
// directly — emitting each element as its own <string> — so a path or value
// containing spaces (e.g. "/Users/John Doe/config.yaml") survives intact
// instead of being split into separate arguments.
func (m *Manager) serviceArgv() []string {
	argv := []string{"run"}
	if m.configPath != "" {
		argv = append(argv, "--config", m.configPath)
	}
	if m.dataDir != "" {
		argv = append(argv, "--data-dir", m.dataDir)
	}
	if m.serviceFlags.BitcoinAddress != "" {
		argv = append(argv, "--bitcoin-address", m.serviceFlags.BitcoinAddress)
	}
	if m.serviceFlags.LogLevel != "" {
		argv = append(argv, "--log-level", m.serviceFlags.LogLevel)
	}
	if m.serviceFlags.LogFormat != "" {
		argv = append(argv, "--log-format", m.serviceFlags.LogFormat)
	}
	if m.serviceFlags.Language != "" {
		argv = append(argv, "--language", m.serviceFlags.Language)
	}
	return argv
}

// serviceArgs joins serviceArgv into a single command-line string, quoting
// only the elements that need it. Used by systemd (ExecStart=) and Windows
// (sc.exe binPath=), which parse their own quoting; launchd uses serviceArgv
// directly.
func (m *Manager) serviceArgs() string {
	argv := m.serviceArgv()
	var b strings.Builder
	for i, a := range argv {
		if i > 0 {
			b.WriteByte(' ')
		}
		if i > 0 && strings.ContainsAny(a, " \t\"") {
			fmt.Fprintf(&b, "%q", a)
		} else {
			b.WriteString(a)
		}
	}
	return b.String()
}

// xmlEscape escapes the five XML special characters so an argument value
// (e.g. a filesystem path) is safe to embed inside a plist <string> element.
func xmlEscape(s string) string {
	return strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&apos;",
	).Replace(s)
}

func runCmd(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%s %v: %w: %s", name, args, err, out)
	}
	return nil
}
