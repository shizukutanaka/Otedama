package mobile

import (
    "testing"
    "time"
)

func TestMobileRateLimiterAllow(t *testing.T) {
    rl := &MobileRateLimiter{
        requests: make(map[string]*UserRateLimit),
        rpm:      5,
        burst:    2,
    }

    user := "user-test"

    // First window: allow 7 requests (5 rpm + 2 burst)
    for i := 0; i < 7; i++ {
        if !rl.Allow(user) {
            t.Fatalf("expected allow at i=%d", i)
        }
    }
    if rl.Allow(user) {
        t.Fatalf("expected final request to be blocked (exceeded rpm+burst)")
    }

    // Force reset to next minute
    if entry, ok := rl.requests[user]; ok {
        entry.LastReset = time.Now().Add(-time.Minute - time.Second)
    } else {
        t.Fatalf("expected user entry to exist")
    }

    // After reset, should allow again up to 7 requests
    for i := 0; i < 7; i++ {
        if !rl.Allow(user) {
            t.Fatalf("expected allow after reset at i=%d", i)
        }
    }
}
