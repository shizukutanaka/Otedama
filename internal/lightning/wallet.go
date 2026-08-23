// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package lightning — wallet.go
//
// This file manages the Lightning wallet lifecycle: creation on first
// run, secure storage, and loading on subsequent runs.
//
// # Non-Custodial Architecture
//
// The wallet's root seed lives only on the user's device, encrypted
// with a passphrase. Otedama's servers (none currently; Cloudflare
// Workers are stateless) never receive the seed, a derived key, or the
// mnemonic. This is the structural guarantee that prevents NiceHash-
// style ($62M, 2017) theft at the platform level.
//
// # File Layout
//
// DataDir/
//
//	wallet.dat        — AES-256-GCM encrypted seed (EncryptedSeed binary)
//	wallet.fingerprint — 4-byte public fingerprint for UI confirmation
//
// # Usage
//
//	wl, err := NewEnglishWordList()
//	if err != nil { ... }
//	wm, err := NewWalletManager(dataDir, passphrase, nil, wl)
//	if err != nil { ... }
//	seed := wm.Seed() // Seed() returns a single value, not (seed, err)
//
// (The third argument is the entropy reader; nil selects crypto/rand.
// The fourth is the BIP-39 word list — required, not optional.)
//
// If wallet.dat does not exist, NewWalletManager generates a new seed,
// saves it, and returns the Mnemonic for the user to back up. On
// subsequent runs, it decrypts and returns the existing seed.
package lightning

import (
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// WalletManager handles the secure creation and retrieval of the
// root BIP-39 seed used by the Lightning wallet.
type WalletManager struct {
	dataDir  string
	seed     Seed
	mnemonic Mnemonic // non-nil only on first-run creation
	wordList *WordList
}

// walletFile is the name of the encrypted seed file on disk.
const walletFile = "wallet.dat"

// fingerprintFile stores the public fingerprint for UI use.
const fingerprintFile = "wallet.fingerprint"

// WalletOption configures optional NewWalletManager creation behavior.
// The zero value of every option's effect is the pre-existing behavior,
// so adding a new WalletOption never requires touching an existing call.
type WalletOption func(*walletOptions)

type walletOptions struct {
	mnemonicPassphrase string
}

// WithMnemonicPassphrase sets the optional BIP-39 "25th word" passphrase
// used when CREATING a new wallet (first run only; it has no effect when
// loading an existing wallet.dat).
//
// This is a distinct secret from NewWalletManager's passphrase argument,
// which encrypts the seed at rest. WithMnemonicPassphrase instead changes
// which seed the mnemonic derives to in the first place (MnemonicToSeed):
// entering the wrong mnemonic passphrase during recovery silently produces
// a different, valid-looking seed rather than an error — the BIP-39 "decoy
// wallet" property. Because that derivation happens once at creation and
// only the resulting Seed (never the mnemonic) is written to wallet.dat,
// this option does not need to be supplied again on subsequent runs: the
// passphrase is already folded into the encrypted seed on disk.
//
// The empty string (the default when this option is not passed) reproduces
// the original derivation with no additional passphrase, so every existing
// caller is unaffected.
func WithMnemonicPassphrase(p string) WalletOption {
	return func(o *walletOptions) { o.mnemonicPassphrase = p }
}

// NewWalletManager initializes the wallet subsystem.
//
// If wallet.dat exists in dataDir, it is decrypted using passphrase
// and the existing seed is returned. If it does not exist, a new
// 256-bit BIP-39 seed is generated, encrypted, and saved; the mnemonic
// is stored in the returned WalletManager and accessible via Mnemonic().
//
// reader provides entropy for key generation and encryption. Pass nil
// to use crypto/rand.Reader (recommended for production).
//
// wordList must be a valid 2048-word BIP-39 list. For the English list,
// call NewEnglishWordList() from this package. Passing nil returns an
// error.
//
// opts configures optional creation behavior; see WithMnemonicPassphrase.
func NewWalletManager(dataDir, passphrase string, reader io.Reader, wordList *WordList, opts ...WalletOption) (*WalletManager, error) {
	if dataDir == "" {
		return nil, errors.New("lightning: dataDir must not be empty")
	}
	if passphrase == "" {
		return nil, errors.New("lightning: passphrase must not be empty")
	}
	if wordList == nil {
		return nil, errors.New("lightning: wordList must not be nil")
	}
	if reader == nil {
		reader = rand.Reader
	}
	var wo walletOptions
	for _, opt := range opts {
		opt(&wo)
	}

	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("lightning: create data dir %q: %w", dataDir, err)
	}

	wm := &WalletManager{dataDir: dataDir, wordList: wordList}

	walletPath := filepath.Join(dataDir, walletFile)
	_, err := os.Stat(walletPath)
	if os.IsNotExist(err) {
		// First run: generate a new seed.
		if err := wm.createNew(passphrase, wo.mnemonicPassphrase, reader); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, fmt.Errorf("lightning: stat wallet file: %w", err)
	} else {
		// Existing wallet: decrypt and load.
		if err := wm.loadExisting(passphrase); err != nil {
			return nil, err
		}
	}

	return wm, nil
}

// Seed returns the decrypted root seed. The Seed is valid for the
// lifetime of the WalletManager.
func (wm *WalletManager) Seed() Seed { return wm.seed }

// Fingerprint returns the public 8-hex-character fingerprint of the
// seed, suitable for display in the UI to confirm wallet identity
// without revealing the seed.
func (wm *WalletManager) Fingerprint() string { return Fingerprint(wm.seed) }

// Mnemonic returns the BIP-39 mnemonic for the seed if this is a
// first-run wallet creation; otherwise it returns nil.
//
// The mnemonic is only returned once per WalletManager lifecycle and
// is not stored on disk. Callers must present it to the user immediately
// so they can write it down for backup.
func (wm *WalletManager) Mnemonic() Mnemonic { return wm.mnemonic }

// IsNew reports whether this WalletManager was created on this run
// (wallet.dat did not previously exist).
func (wm *WalletManager) IsNew() bool { return wm.mnemonic != nil }

// createNew generates a new seed, encrypts it, and saves it to disk.
// mnemonicPassphrase is the optional BIP-39 "25th word" (see
// WithMnemonicPassphrase); pass "" for the standard derivation.
func (wm *WalletManager) createNew(passphrase, mnemonicPassphrase string, reader io.Reader) error {
	entropy, err := GenerateEntropy(DefaultEntropyBits, reader)
	if err != nil {
		return fmt.Errorf("lightning: generate entropy: %w", err)
	}

	mnemonic, err := EntropyToMnemonic(entropy, wm.wordList)
	if err != nil {
		return fmt.Errorf("lightning: entropy to mnemonic: %w", err)
	}

	seed := MnemonicToSeed(mnemonic, mnemonicPassphrase)
	wm.seed = seed
	wm.mnemonic = mnemonic

	if err := wm.save(seed, passphrase, reader); err != nil {
		return err
	}

	// Write the public fingerprint file. This is best-effort: the
	// fingerprint is a UI convenience (lets the user confirm they typed
	// the right mnemonic) and is recoverable from the seed at any time,
	// so a write failure here must not fail wallet creation.
	fpPath := filepath.Join(wm.dataDir, fingerprintFile)
	if err := os.WriteFile(fpPath, []byte(Fingerprint(seed)), 0o600); err != nil {
		_ = err // intentionally ignored: non-fatal, see comment above
	}
	return nil
}

// loadExisting decrypts and loads an existing wallet.dat.
func (wm *WalletManager) loadExisting(passphrase string) error {
	raw, err := os.ReadFile(filepath.Join(wm.dataDir, walletFile))
	if err != nil {
		return fmt.Errorf("lightning: read wallet file: %w", err)
	}
	es, err := UnmarshalEncryptedSeed(raw)
	if err != nil {
		return fmt.Errorf("lightning: unmarshal wallet: %w", err)
	}
	seed, err := DecryptSeed(es, passphrase)
	if err != nil {
		// DecryptSeed returns a deliberately opaque error on wrong passphrase
		// to prevent oracle attacks. Surface it directly.
		return fmt.Errorf("lightning: wallet unlock failed — check your passphrase")
	}
	wm.seed = seed
	return nil
}

// save encrypts seed and atomically writes it to wallet.dat.
// An atomic write (write temp, rename) prevents a half-written file
// from corrupting the wallet if the process is killed mid-write.
func (wm *WalletManager) save(seed Seed, passphrase string, reader io.Reader) error {
	es, err := EncryptSeed(seed, passphrase, reader)
	if err != nil {
		return fmt.Errorf("lightning: encrypt seed: %w", err)
	}
	raw, err := es.Marshal()
	if err != nil {
		return fmt.Errorf("lightning: marshal encrypted seed: %w", err)
	}

	// Write to a temp file in the same directory (ensures same filesystem
	// for the atomic rename).
	tmp, err := os.CreateTemp(wm.dataDir, ".wallet-*.tmp")
	if err != nil {
		return fmt.Errorf("lightning: create temp wallet file: %w", err)
	}
	tmpPath := tmp.Name()

	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("lightning: write temp wallet file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("lightning: sync temp wallet file: %w", err)
	}
	// A Close error after a successful Sync is rare but must not be
	// ignored: on some filesystems the final flush happens at Close,
	// so a Close error can mean the data did not reach disk.
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("lightning: close temp wallet file: %w", err)
	}

	// Set restrictive permissions before the rename so the final file
	// is never readable by other users, even momentarily.
	if err := os.Chmod(tmpPath, 0o600); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("lightning: chmod temp wallet file: %w", err)
	}

	finalPath := filepath.Join(wm.dataDir, walletFile)
	if err := os.Rename(tmpPath, finalPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("lightning: rename wallet file: %w", err)
	}
	return nil
}

// ChangePassphrase re-encrypts the wallet with a new passphrase.
// The old passphrase must be correct; the new passphrase must not be
// empty. On success, wallet.dat is overwritten atomically.
func (wm *WalletManager) ChangePassphrase(oldPassphrase, newPassphrase string, reader io.Reader) error {
	if newPassphrase == "" {
		return errors.New("lightning: new passphrase must not be empty")
	}
	// Verify old passphrase by attempting a round-trip decrypt.
	raw, err := os.ReadFile(filepath.Join(wm.dataDir, walletFile))
	if err != nil {
		return fmt.Errorf("lightning: read wallet file: %w", err)
	}
	es, err := UnmarshalEncryptedSeed(raw)
	if err != nil {
		return fmt.Errorf("lightning: unmarshal wallet: %w", err)
	}
	seed, err := DecryptSeed(es, oldPassphrase)
	if err != nil {
		return fmt.Errorf("lightning: incorrect old passphrase")
	}
	if reader == nil {
		reader = rand.Reader
	}
	return wm.save(seed, newPassphrase, reader)
}
