// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package provider

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// pollingProvider is the shared lifecycle machinery for providers that
// publish yield quotes on a buffered channel at a fixed interval. Concrete
// providers (MiningProvider, AkashProvider) embed it and supply their own
// publish function; the start/stop/loop/send plumbing lives here so it is
// written and tested once rather than duplicated per market.
//
// The embedded fields are promoted to the concrete provider, so existing
// references like p.quoteCh continue to work unchanged.
type pollingProvider struct {
	quoteCh  chan Quote
	interval time.Duration // time between quotes; small values speed up tests
	mu       sync.Mutex
	cancel   context.CancelFunc
	wg       sync.WaitGroup
}

// Quotes returns the channel on which yield updates are published. The
// channel is closed when the provider stops.
func (p *pollingProvider) Quotes() <-chan Quote { return p.quoteCh }

// launch starts the polling goroutine. It returns an error labeled with
// the given provider name if Start was already called. prepare runs under
// the provider lock after the already-started check, so a concrete provider
// can record its device set only when the start actually succeeds (a
// rejected double-start must not mutate state the running loop reads).
func (p *pollingProvider) launch(ctx context.Context, label string, prepare func(), publish func(context.Context)) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cancel != nil {
		return fmt.Errorf("provider: %s already started", label)
	}
	if prepare != nil {
		prepare()
	}
	inner, cancel := context.WithCancel(ctx)
	p.cancel = cancel

	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		defer close(p.quoteCh)
		p.loop(inner, publish)
	}()
	return nil
}

// loop publishes an initial quote immediately, then republishes every
// interval until the context is canceled.
func (p *pollingProvider) loop(ctx context.Context, publish func(context.Context)) {
	ticker := time.NewTicker(p.interval)
	defer ticker.Stop()

	publish(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			publish(ctx)
		}
	}
}

// Stop signals the provider to shut down and waits for the loop goroutine
// to exit. It is safe to call even if Start was never called, and it
// resets state so the provider can be started again. The quote channel is
// recreated only after wg.Wait() guarantees the loop goroutine (the sole
// writer) has exited, so there is no concurrent access to quoteCh.
func (p *pollingProvider) Stop() {
	p.mu.Lock()
	cancel := p.cancel
	p.mu.Unlock()
	if cancel != nil {
		cancel()
		p.wg.Wait()
		p.mu.Lock()
		p.cancel = nil
		p.quoteCh = make(chan Quote, cap(p.quoteCh))
		p.mu.Unlock()
	}
}

// sendQuote publishes q, dropping the oldest buffered quote if the channel
// is full so the freshest estimate always wins rather than blocking the
// loop. It returns false if ctx was canceled before the quote could be
// sent.
func (p *pollingProvider) sendQuote(ctx context.Context, q Quote) bool {
	select {
	case p.quoteCh <- q:
		return true
	case <-ctx.Done():
		return false
	default:
		// Channel full — drop oldest, then send newest.
		select {
		case <-p.quoteCh:
		default:
		}
		select {
		case p.quoteCh <- q:
			return true
		case <-ctx.Done():
			return false
		}
	}
}
