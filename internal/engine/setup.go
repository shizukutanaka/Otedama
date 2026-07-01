// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package engine — setup.go
//
// Startup wiring: hardware detection, miner-worker spawning, provider
// construction, optional wallet initialisation, and the config-derived
// helpers (pool URLs, payout addresses, session user identity). Also
// hosts the built-in CPU driver, which is always present regardless of
// platform-specific HAL drivers.

package engine

import (
	"context"
	"fmt"
	"runtime"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/hal"
	"github.com/shizukutanaka/Otedama/internal/lightning"
	"github.com/shizukutanaka/Otedama/internal/miner"
	"github.com/shizukutanaka/Otedama/internal/provider"
)

// detectDevices initialises the HAL registry, registers CPU and GPU
// drivers, and runs detection. Returns the list of detected devices,
// or an error if registration fails or no devices are found.
func detectDevices(ctx context.Context, log func(level, msg string)) ([]hal.Device, error) {
	reg := hal.NewRegistry()
	if err := reg.Register(&cpuDriver{}); err != nil {
		return nil, fmt.Errorf("engine: register cpu driver: %w", err)
	}
	if err := hal.RegisterGPULinux(reg); err != nil {
		log("warn", fmt.Sprintf("engine: register gpu driver: %v", err))
	}
	detector := hal.NewDetector(reg, func(driver, msg string, err error) {
		log("warn", fmt.Sprintf("hal: %s: %s: %v", driver, msg, err))
	})
	devices, err := detector.Detect(ctx)
	if len(devices) == 0 {
		// Detect only returns an error when the context was cancelled or
		// timed out (per-driver enumeration failures are logged via the
		// callback above). The built-in CPU driver always enumerates a
		// device, so an empty result effectively means detection was
		// interrupted — surface that real cause instead of the misleading
		// "no devices detected".
		if err != nil {
			return nil, fmt.Errorf("engine: device detection interrupted: %w", err)
		}
		return nil, fmt.Errorf("engine: no devices detected")
	}
	return devices, nil
}

// startMinerWorkers spawns one miner worker per SHA256d-capable device,
// returns the workers and a merged share channel. Returns an error if
// no SHA256d-capable device is present. The caller owns worker shutdown.
func startMinerWorkers(ctx context.Context, devices []hal.Device, log func(level, msg string)) ([]*miner.Worker, <-chan miner.Share, error) {
	var workers []*miner.Worker
	var shareChans []<-chan miner.Share
	for _, dev := range devices {
		if !dev.Capabilities().SHA256d {
			continue
		}
		cfg := miner.DefaultWorkerConfig()
		cfg.DeviceID = dev.Identity().ID
		w := miner.NewWorker(cfg)
		workers = append(workers, w)
		shareChans = append(shareChans, w.Start(ctx))
		log("info", fmt.Sprintf("engine: worker for %s", dev.Identity()))
	}
	if len(workers) == 0 {
		return nil, nil, fmt.Errorf("engine: no SHA256d-capable devices found")
	}
	return workers, mergeShares(ctx, shareChans), nil
}

// startProviders constructs and starts the mining and Akash providers.
// Start errors are logged (not fatal): the engine can run with a degraded
// provider set. The caller owns provider shutdown.
//
// workers is the set of miner workers already started by startMinerWorkers.
// When non-empty, a closure over workers is set on the MiningProvider's
// HashrateFunc so each publish() call samples the live worker.Stats().HashRate
// rather than using the static per-family constant (KNOWN_LIMITATIONS §7).
func startProviders(ctx context.Context, cfg config.Config, rateFetcher provider.RateSource, devices []hal.Device, workers []*miner.Worker, log func(level, msg string)) (*provider.MiningProvider, *provider.AkashProvider) {
	miningProvider := provider.NewMiningProvider(defaultPoolURL(cfg), rateFetcher)
	if len(workers) > 0 {
		// Capture workers by value so the closure stays valid after this
		// function returns. Each call samples the current hashrate; no
		// locking is needed because Worker.Stats() is itself concurrency-safe.
		ws := workers
		miningProvider.HashrateFunc = func(deviceID string) float64 {
			for _, w := range ws {
				if w.DeviceID() == deviceID {
					return w.Stats().HashRate
				}
			}
			return 0
		}
	}
	akashProvider := provider.NewAkashProvider(rateFetcher)
	if err := miningProvider.Start(ctx, devices); err != nil {
		log("warn", fmt.Sprintf("provider: mining: %v", err))
	}
	if err := akashProvider.Start(ctx, devices); err != nil {
		log("warn", fmt.Sprintf("provider: akash: %v", err))
	}
	return miningProvider, akashProvider
}

// setupWallet initialises the optional Lightning wallet. Returns the
// wallet fingerprint, or an empty string if no wallet was configured
// or initialisation failed (errors are logged, not propagated, so the
// engine can run mining without a wallet).
func setupWallet(opts Options, log func(level, msg string)) string {
	if opts.WalletPassphrase == "" || opts.Config.DataDir == "" {
		return ""
	}
	wl, err := lightning.NewEnglishWordList()
	if err != nil {
		log("warn", fmt.Sprintf("wallet: wordlist: %v", err))
		return ""
	}
	wm, err := lightning.NewWalletManager(
		opts.Config.DataDir, opts.WalletPassphrase, nil, wl,
		lightning.WithMnemonicPassphrase(opts.WalletMnemonicPassphrase))
	if err != nil {
		log("warn", fmt.Sprintf("wallet: %v", err))
		return ""
	}
	fingerprint := wm.Fingerprint()
	if wm.IsNew() {
		log("info", "wallet: new wallet created — back up your recovery phrase")
	}
	log("info", fmt.Sprintf("wallet: fingerprint %s", fingerprint))
	return fingerprint
}

// defaultPoolURL returns the first configured pool URL, or the built-in
// default when none is configured.
func defaultPoolURL(cfg config.Config) string {
	if len(cfg.Pools) > 0 {
		return cfg.Pools[0].URL
	}
	return config.DefaultPoolURL
}

// poolURLs returns the ordered list of pool URLs to try, for failover.
// The order is the user's configured priority; the engine rotates to
// the next pool when the current one fails (matching the multi-pool
// failover behaviour of cgminer/bfgminer/Braiins). Falls back to the
// built-in default when no pools are configured.
func poolURLs(cfg config.Config) []string {
	if len(cfg.Pools) == 0 {
		return []string{config.DefaultPoolURL}
	}
	urls := make([]string, 0, len(cfg.Pools))
	for _, p := range cfg.Pools {
		urls = append(urls, p.URL)
	}
	return urls
}

// payoutAddresses returns the ordered, de-duplicated list of payout
// addresses to try, for failover: BitcoinAddress first (the primary),
// then BitcoinAddresses in order. Empty entries are skipped. The engine
// rotates to the next address only when the current one has never
// established a session (see runReconnectLoop), so a working payout
// address is never abandoned due to a transient pool or network failure.
func payoutAddresses(cfg config.Config) []string {
	seen := make(map[string]bool)
	var addrs []string
	add := func(a string) {
		if a == "" || seen[a] {
			return
		}
		seen[a] = true
		addrs = append(addrs, a)
	}
	add(cfg.BitcoinAddress)
	for _, a := range cfg.BitcoinAddresses {
		add(a)
	}
	return addrs
}

// sessionUser builds the Stratum user_identity sent in OpenMiningChannel,
// honouring the documented config precedence:
//   - an explicit per-pool User overrides everything (operator's choice);
//   - otherwise the active payout address is used, suffixed with the
//     configured worker name as "address.worker" — the standard Stratum
//     convention for per-rig stats at the pool — when a name is set.
func sessionUser(poolUser, addr, worker string) string {
	if poolUser != "" {
		return poolUser
	}
	if worker != "" {
		return addr + "." + worker
	}
	return addr
}

// maskAddr renders a payout address for logs without printing it in full,
// so operator logs do not needlessly expose the complete address.
func maskAddr(a string) string {
	if len(a) <= 12 {
		return a
	}
	return a[:6] + "…" + a[len(a)-4:]
}

// ----- Built-in CPU driver -----

type cpuDriver struct{}

func (d *cpuDriver) Name() string { return "cpu" }

func (d *cpuDriver) Enumerate(_ context.Context) ([]hal.Device, error) {
	return []hal.Device{&cpuDevice{
		id: hal.Identity{
			ID:     "cpu-0",
			Family: hal.FamilyCPU,
			Vendor: "generic",
			Model:  fmt.Sprintf("%d-core CPU", runtime.NumCPU()),
		},
		caps: hal.Capabilities{SHA256d: true, GeneralCompute: true},
	}}, nil
}

type cpuDevice struct {
	id   hal.Identity
	caps hal.Capabilities
}

func (d *cpuDevice) Identity() hal.Identity           { return d.id }
func (d *cpuDevice) Capabilities() hal.Capabilities   { return d.caps }
func (d *cpuDevice) Shutdown(_ context.Context) error { return nil }
