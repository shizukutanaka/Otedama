module github.com/shizukutanaka/Otedama

go 1.24

toolchain go1.24.0

// No godebug pins, deliberately. See GODEBUG_NOTES.md for the measurements.
//
// This module declared `go 1.22` and pinned three settings until session 266.
// One of them, tlsmlkem=1, was load-bearing: with a go 1.22 line, deleting
// that single row silently disabled hybrid post-quantum TLS. Declaring
// `go 1.24` — the version the toolchain line above already required — makes
// all three the toolchain defaults, so the pins are redundant and the trap is
// gone. Measured: `go 1.24` with no godebug block produces a binary whose
// DefaultGODEBUG is empty (every setting at the current default, PQ TLS on),
// where `go 1.22` baked in 15 stale ones — asynctimerchan=1, multipathtcp=0,
// gotypesalias=0, httpservecontentkeepheaders=1 and the older crypto/x509
// leniencies among them.

require (
	golang.org/x/crypto v0.23.0
	gopkg.in/yaml.v3 v3.0.1
)

require golang.org/x/sys v0.20.0 // indirect
