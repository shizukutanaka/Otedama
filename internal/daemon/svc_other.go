// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//go:build !windows

package daemon

// IsWindowsService always reports false off Windows: the Windows Service
// Control Manager only exists there, so every other platform's daemon path
// (systemd/launchd) reaches the process via ordinary signal handling.
func IsWindowsService() bool { return false }
