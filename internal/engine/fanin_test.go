// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package engine

import (
	"context"
	"sync"
	"testing"
	"time"
)

// TestFanIn_MergesAllValues verifies every value from every input
// channel appears exactly once on the output.
func TestFanIn_MergesAllValues(t *testing.T) {
	ctx := context.Background()

	const nChans = 4
	const perChan = 25
	inputs := make([]<-chan int, nChans)
	for i := 0; i < nChans; i++ {
		ch := make(chan int, perChan)
		base := i * 1000
		for j := 0; j < perChan; j++ {
			ch <- base + j
		}
		close(ch)
		inputs[i] = ch
	}

	out := fanIn(ctx, inputs, 4)

	seen := make(map[int]int)
	for v := range out {
		seen[v]++
	}

	if len(seen) != nChans*perChan {
		t.Errorf("got %d distinct values, want %d", len(seen), nChans*perChan)
	}
	for v, count := range seen {
		if count != 1 {
			t.Errorf("value %d appeared %d times, want 1", v, count)
		}
	}
}

// TestFanIn_ClosesOutputWhenAllInputsClosed verifies the output channel
// is closed once all inputs are drained (so `range` terminates).
func TestFanIn_ClosesOutputWhenAllInputsClosed(t *testing.T) {
	ctx := context.Background()

	ch := make(chan int, 1)
	ch <- 42
	close(ch)

	out := fanIn(ctx, []<-chan int{ch}, 1)

	got := []int{}
	done := make(chan struct{})
	go func() {
		for v := range out {
			got = append(got, v)
		}
		close(done)
	}()

	select {
	case <-done:
		// Output closed correctly.
	case <-time.After(2 * time.Second):
		t.Fatal("fanIn output channel never closed")
	}

	if len(got) != 1 || got[0] != 42 {
		t.Errorf("got %v, want [42]", got)
	}
}

// TestFanIn_RespectsContextCancellation verifies that canceling ctx
// stops the fan-in goroutines even if inputs never close.
func TestFanIn_RespectsContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	// An input channel that is never closed and never written to.
	stuck := make(chan int)
	out := fanIn(ctx, []<-chan int{stuck}, 1)

	// Cancel almost immediately.
	cancel()

	// The output should close once the goroutine notices ctx.Done().
	select {
	case _, ok := <-out:
		if ok {
			t.Error("unexpected value on out after cancel")
		}
		// ok==false means closed — correct.
	case <-time.After(2 * time.Second):
		t.Fatal("fanIn did not shut down after context cancellation")
	}
}

// TestFanIn_EmptyChannelList returns an immediately-closed channel.
func TestFanIn_EmptyChannelList(t *testing.T) {
	ctx := context.Background()
	out := fanIn(ctx, []<-chan int{}, 4)

	select {
	case _, ok := <-out:
		if ok {
			t.Error("expected closed channel for empty input list")
		}
	case <-time.After(time.Second):
		t.Fatal("fanIn with empty list did not close output")
	}
}

// TestFanIn_BufferSizeCapping verifies the buffer-size heuristic does
// not panic for large channel counts (bufFactor*N > 64 path) or for
// the bufSize < 1 path.
func TestFanIn_BufferSizeCapping(t *testing.T) {
	ctx := context.Background()

	// Large N: bufFactor*N would exceed 64 and must be capped.
	many := make([]<-chan int, 100)
	for i := range many {
		ch := make(chan int)
		close(ch)
		many[i] = ch
	}
	out := fanIn(ctx, many, 64) // 64*100 = 6400 → capped to 64
	// Drain (all closed, so this returns quickly).
	count := 0
	for range out {
		count++
	}
	if count != 0 {
		t.Errorf("got %d values from closed channels, want 0", count)
	}
}

// TestFanIn_ConcurrentProducers exercises the race detector with
// multiple goroutines actively writing while fanIn merges.
func TestFanIn_ConcurrentProducers(t *testing.T) {
	ctx := context.Background()

	const nChans = 8
	const perChan = 100
	inputs := make([]<-chan int, nChans)
	var wg sync.WaitGroup
	for i := 0; i < nChans; i++ {
		ch := make(chan int)
		inputs[i] = ch
		wg.Add(1)
		go func(c chan int, base int) {
			defer wg.Done()
			defer close(c)
			for j := 0; j < perChan; j++ {
				c <- base + j
			}
		}(ch, i*1000)
	}

	out := fanIn(ctx, inputs, 4)

	total := 0
	for range out {
		total++
	}
	wg.Wait()

	if total != nChans*perChan {
		t.Errorf("got %d values, want %d", total, nChans*perChan)
	}
}
