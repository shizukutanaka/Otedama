package api

import (
    "context"
    "net"
    "sync"
    "time"

    "golang.org/x/time/rate"
)

// RateLimiter provides simple IP-based token-bucket rate limiting.
// It is intentionally lightweight – no external storage or goroutines –
// and is suitable for API front-ends and websocket upgrades.
// Adapted from examples by Rob Pike, emphasising clarity over premature optimisation.
//
// r = allowed events per interval, b = burst size.
// A map keyed by stringified remote IP stores independent buckets.
// Entries expire after idleTTL to keep memory usage bounded.

type IPRateLimiter struct {
    mu      sync.Mutex
    visitors map[string]*visitor

    // configuration
    r       rate.Limit     // tokens per second
    b       int            // burst size
    idleTTL time.Duration  // purge visitors idle longer than this
}

type visitor struct {
    limiter  *rate.Limiter
    lastSeen time.Time
}

// NewIPRateLimiter returns an IP-based limiter that allows `requests` per `per` duration with specified burst.
func NewIPRateLimiter(requests int, per time.Duration, burst int) *IPRateLimiter {
    rl := &IPRateLimiter{
        visitors: make(map[string]*visitor),
        r:       rate.Limit(float64(requests) / per.Seconds()),
        b:       burst,
        idleTTL: 10 * time.Minute,
    }
    return rl
}

// Allow reports whether a request from the given remoteAddr should be allowed.
// remoteAddr is expected to be the raw `r.RemoteAddr` value (host:port).
func (rl *IPRateLimiter) Allow(remoteAddr string) bool {
    ip, _, err := net.SplitHostPort(remoteAddr)
    if err != nil {
        // If parsing fails, fall back to whole addr.
        ip = remoteAddr
    }

    rl.mu.Lock()
    defer rl.mu.Unlock()

    v, ok := rl.visitors[ip]
    if !ok {
        v = &visitor{
            limiter: rate.NewLimiter(rl.r, rl.b),
        }
        rl.visitors[ip] = v
    }
    v.lastSeen = time.Now()

    // purge idle visitors occasionally (low-impact O(N))
    if len(rl.visitors) > 1000 {
        rl.purge()
    }

    return v.limiter.Allow()
}

// AllowN reports whether n events are allowed for the given remoteAddr at once.
// This aligns with internal/common.RateLimiter.
func (rl *IPRateLimiter) AllowN(remoteAddr string, n int) bool {
    ip, _, err := net.SplitHostPort(remoteAddr)
    if err != nil {
        ip = remoteAddr
    }

    rl.mu.Lock()
    v, ok := rl.visitors[ip]
    if !ok {
        v = &visitor{
            limiter: rate.NewLimiter(rl.r, rl.b),
        }
        rl.visitors[ip] = v
    }
    v.lastSeen = time.Now()

    // snapshot limiter, then release lock before calling into rate.Limiter
    lim := v.limiter

    // purge idle visitors occasionally
    if len(rl.visitors) > 1000 {
        rl.purge()
    }
    rl.mu.Unlock()

    return lim.AllowN(time.Now(), n)
}

// Wait blocks until a single event is available for the given remoteAddr or the context is done.
// This aligns with internal/common.RateLimiter.
func (rl *IPRateLimiter) Wait(ctx context.Context, remoteAddr string) error {
    ip, _, err := net.SplitHostPort(remoteAddr)
    if err != nil {
        ip = remoteAddr
    }

    rl.mu.Lock()
    v, ok := rl.visitors[ip]
    if !ok {
        v = &visitor{
            limiter: rate.NewLimiter(rl.r, rl.b),
        }
        rl.visitors[ip] = v
    }
    v.lastSeen = time.Now()
    lim := v.limiter
    rl.mu.Unlock()

    return lim.WaitN(ctx, 1)
}

func (rl *IPRateLimiter) purge() {
    cutoff := time.Now().Add(-rl.idleTTL)
    for k, v := range rl.visitors {
        if v.lastSeen.Before(cutoff) {
            delete(rl.visitors, k)
        }
    }
}

