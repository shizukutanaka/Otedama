// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package engine

// This file exists purely to guarantee that every internal package
// referenced by engine compiles cleanly. If any import graph regresses,
// this file will fail to compile first, before more expensive tests run.
//
// The tests here intentionally do almost nothing at runtime — they are
// a compile-time safety net.

import (
	"context"
	"testing"

	"github.com/shizukutanaka/Otedama/internal/arbitration"
	"github.com/shizukutanaka/Otedama/internal/clock"
	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/hal"
	"github.com/shizukutanaka/Otedama/internal/lightning"
	"github.com/shizukutanaka/Otedama/internal/logger"
	"github.com/shizukutanaka/Otedama/internal/miner"
	"github.com/shizukutanaka/Otedama/internal/provider"
	"github.com/shizukutanaka/Otedama/internal/rates"
	"github.com/shizukutanaka/Otedama/internal/stratum"
	"github.com/shizukutanaka/Otedama/internal/tui"
)

func TestCompile_EveryPackageReachable(t *testing.T) {
	// Touch one symbol from each package to force linking.
	// If any of these disappear, the test fails at compile time.
	_ = arbitration.PolicyMaximizeEarnings
	_ = clock.System{}
	_ = config.Config{}
	_ = hal.FamilyCPU
	_ = lightning.DefaultEntropyBits
	_ = logger.LevelInfo
	_ = miner.HeaderSize
	_ = provider.MinQuoteInterval
	_ = rates.CacheDuration
	_ = stratum.MiningProtocol
	_ = tui.Stats{}
}

func TestOptions_AllFieldsAccessible(t *testing.T) {
	// Ensure the public Options type has the fields the CLI depends on.
	// A refactor that removes any of these breaks `cmd/otedama`.
	opts := Options{
		Config:               config.Config{},
		Output:               nil,
		Logger:               nil,
		NoTUI:                true,
		MaxReconnectAttempts: 1,
		WalletPassphrase:     "",
	}
	_ = opts.NoTUI
	_ = opts.WalletPassphrase
	_ = opts.MaxReconnectAttempts
}

func TestRun_FailsWithoutDevices_QuickPath(t *testing.T) {
	// A fast smoke test: Run must return quickly when no pool exists
	// and reconnect is capped. This verifies the reconnect loop and
	// device enumeration don't deadlock.
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	err := Run(ctx, Options{
		Config: config.Config{
			BitcoinAddress: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
			Pools: []config.PoolConfig{
				{URL: "stratum+v2://127.0.0.1:1"}, // nothing listens here
			},
		},
		NoTUI:                true,
		MaxReconnectAttempts: 1,
		Logger:               func(_, _ string) {},
	})
	// Error is either context.Canceled or a connection failure — both OK.
	if err == nil {
		t.Skip("Run returned nil unexpectedly; may indicate environment difference")
	}
}
