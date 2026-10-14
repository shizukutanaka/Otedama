package engine

import "testing"

// yieldDegraded gates the low-acceptance session exit: it must stay quiet
// until enough shares are judged, and must not trigger at the floor.
func TestYieldDegraded(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name               string
		accepted, rejected uint64
		want               bool
	}{
		{"no shares judged yet", 0, 0, false},
		{"below min judged", 31, 0, false},
		{"below min judged with rejects", 28, 3, false},
		{"min judged, all accepted", 32, 0, false},
		{"min judged, degraded", 28, 4, true},                // 87.5%
		{"above floor is not degraded", 29, 3, false},        // 90.6%
		{"degraded below floor", 29, 4, true},                // 87.9%
		{"exactly at floor is not degraded", 288, 32, false}, // 90.0% — boundary
		{"just below floor", 287, 33, true},                  // 89.7%
		{"healthy long session", 3200, 0, false},
		{"all rejected once judged", 0, 32, true},
		{"all rejected below min judged", 0, 31, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := yieldDegraded(tt.accepted, tt.rejected); got != tt.want {
				t.Errorf("yieldDegraded(%d, %d) = %v, want %v",
					tt.accepted, tt.rejected, got, tt.want)
			}
		})
	}
}

// A degraded session must exit non-fatally so runReconnectLoop fails over
// instead of giving up on the whole engine.
func TestErrYieldDegradedIsNotFatal(t *testing.T) {
	t.Parallel()
	if isFatal(errYieldDegraded) {
		t.Error("errYieldDegraded must not be fatal — it routes to pool failover")
	}
}
