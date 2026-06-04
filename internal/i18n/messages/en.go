// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package messages provides built-in message catalogs for Otedama.
//
// Each language has its own file: en.go for English (the fallback),
// ja.go for Japanese, zh.go for Chinese, and so on. The English catalog
// is the source of truth; all other catalogs are translations of it.
//
// To add a new message:
//  1. Define the ID constant in ids.go (this file).
//  2. Add the English rendering to the map in en.go.
//  3. Add translations to ja.go, zh.go, etc.
//  4. The CI translation-completeness check will fail if any priority
//     language is missing a translation for the new ID.
//
// This workflow prevents English-only messages from sneaking into the
// codebase, which is the primary failure mode of international
// localization projects.
package messages

import (
	"github.com/shizukutanaka/Otedama/internal/i18n"
)

// Message IDs, grouped by area.
//
// Every user-facing string in Otedama must be referenced through one of
// these constants. Code that formats user-facing strings inline (without
// going through i18n.Bundle) will fail review.
const (
	// Startup messages are shown during Otedama launch.
	StartupReady          i18n.ID = "startup.ready"
	StartupWalletCreated  i18n.ID = "startup.wallet_created"
	StartupHardwareFound  i18n.ID = "startup.hardware_found"
	StartupHardwareNone   i18n.ID = "startup.hardware_none"
	StartupPoolConnecting i18n.ID = "startup.pool_connecting"
	StartupPoolConnected  i18n.ID = "startup.pool_connected"

	// Error messages describe failure conditions.
	ErrorPoolUnreachable i18n.ID = "error.pool_unreachable"
	ErrorInvalidAddress  i18n.ID = "error.invalid_address"
	ErrorConfigMissing   i18n.ID = "error.config_missing"
	ErrorWalletLocked    i18n.ID = "error.wallet_locked"
	ErrorHardwareFailure i18n.ID = "error.hardware_failure"

	// Status messages describe ongoing operation.
	StatusMining          i18n.ID = "status.mining"
	StatusIdle            i18n.ID = "status.idle"
	StatusPaymentReceived i18n.ID = "status.payment_received"
	StatusShuttingDown    i18n.ID = "status.shutting_down"
)

// English returns the English message catalog.
//
// English is the fallback language: any message missing in another
// catalog falls through to the entry here. For this reason, English
// must always be complete. The CI completeness check compares every
// other language against this catalog.
func English() (*i18n.Catalog, error) {
	return i18n.NewCatalog(i18n.LangEnglish, map[i18n.ID]string{
		StartupReady:          "Otedama is ready. Mining will begin shortly.",
		StartupWalletCreated:  "A new Lightning wallet has been created. Your recovery seed is stored securely on this device.",
		StartupHardwareFound:  "Found {{.count}} mining device(s): {{.summary}}",
		StartupHardwareNone:   "No mining devices detected. Otedama requires an ASIC, GPU, or supported CPU.",
		StartupPoolConnecting: "Connecting to pool {{.url}}...",
		StartupPoolConnected:  "Connected to pool {{.url}}.",

		ErrorPoolUnreachable: "The pool at {{.url}} is unreachable. Check your internet connection or try a different pool.",
		ErrorInvalidAddress:  "The Bitcoin address {{.address}} is not valid. Please check for typos.",
		ErrorConfigMissing:   "Otedama needs a Bitcoin address before mining can begin. Pass --bitcoin-address or set OTEDAMA_BITCOIN_ADDRESS.",
		ErrorWalletLocked:    "The Lightning wallet is locked. Unlock it with your passphrase to continue.",
		ErrorHardwareFailure: "Device {{.id}} reported a hardware failure and has been disabled.",

		StatusMining:          "Mining on {{.devices}} device(s). Current hashrate: {{.hashrate}}.",
		StatusIdle:            "Idle. No work available from the pool right now.",
		StatusPaymentReceived: "Received {{.amount}} from pool {{.pool}}.",
		StatusShuttingDown:    "Shutting down gracefully. Your wallet remains safe on this device.",
	})
}

// AllIDs returns every message ID known to Otedama, sorted.
//
// The CI completeness check iterates over AllIDs and verifies that every
// priority language has a translation for each. This function is the
// single source of truth for "what messages exist in Otedama."
func AllIDs() []i18n.ID {
	return []i18n.ID{
		ErrorConfigMissing,
		ErrorHardwareFailure,
		ErrorInvalidAddress,
		ErrorPoolUnreachable,
		ErrorWalletLocked,
		StartupHardwareFound,
		StartupHardwareNone,
		StartupPoolConnected,
		StartupPoolConnecting,
		StartupReady,
		StartupWalletCreated,
		StatusIdle,
		StatusMining,
		StatusPaymentReceived,
		StatusShuttingDown,
	}
}
