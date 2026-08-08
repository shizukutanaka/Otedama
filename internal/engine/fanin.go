// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package engine — fanin.go
//
// Generic fan-in plumbing: merge N producer channels into one consumer
// channel with context-aware shutdown. Used for both provider quotes
// and miner shares.

package engine

import (
	"context"
	"sync"

	"github.com/shizukutanaka/Otedama/internal/miner"
	"github.com/shizukutanaka/Otedama/internal/provider"
)

// fanIn merges N input channels into a single output channel.
// It closes the output when all inputs are drained or ctx is done.
// Buffer size is bufFactor * len(channels), capped at 64 for small N.
func fanIn[T any](ctx context.Context, channels []<-chan T, bufFactor int) <-chan T {
	bufSize := bufFactor * len(channels)
	if bufSize > 64 {
		bufSize = 64
	}
	if bufSize < 1 {
		bufSize = 1
	}
	out := make(chan T, bufSize)
	var wg sync.WaitGroup
	for _, ch := range channels {
		wg.Add(1)
		go func(c <-chan T) {
			defer wg.Done()
			for {
				// The receive must also observe ctx: a stuck input (never
				// written, never closed) would otherwise pin this goroutine
				// open after cancellation and keep out from ever closing.
				select {
				case v, ok := <-c:
					if !ok {
						return // input closed
					}
					select {
					case out <- v:
					case <-ctx.Done():
						return
					}
				case <-ctx.Done():
					return
				}
			}
		}(ch)
	}
	go func() { wg.Wait(); close(out) }()
	return out
}

// mergeQuotes is a typed convenience wrapper for fanIn.
func mergeQuotes(ctx context.Context, channels ...<-chan provider.Quote) <-chan provider.Quote {
	return fanIn(ctx, channels, 64)
}

// mergeShares is a typed convenience wrapper for fanIn.
func mergeShares(ctx context.Context, channels []<-chan miner.Share) <-chan miner.Share {
	return fanIn(ctx, channels, 4)
}
