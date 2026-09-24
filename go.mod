module github.com/shizukutanaka/Otedama

go 1.25.0

toolchain go1.25.7

// godebug pins behavior across Go upgrades. See GODEBUG_NOTES.md.
//   tlsmlkem=1   — enable hybrid PQ key exchange (X25519MLKEM768) in TLS
//                  handshakes (default-on Go 1.24+). Renamed from the Go 1.23
//                  draft knob tlskyber when X25519Kyber768 was standardized.
//   panicnil=0   — keep Go 1.21+ behavior of panicking on nil panic value.
//   randautoseed=1 — math/rand v1 auto-seed (Go 1.20+ default).
godebug (
	panicnil=0
	randautoseed=1
	tlsmlkem=1
)

require (
	// Successor of the archived gopkg.in/yaml.v3: the go-yaml source
	// repo was archived 2025-04-01; the YAML org continues maintenance
	// under go.yaml.in/yaml (v3 API-frozen, drop-in compatible). Chosen
	// over yaml.v4 to stay API-identical with our existing call sites.
	go.yaml.in/yaml/v3 v3.0.5
	// chacha20poly1305 + scrypt + pbkdf2 for the Noise transport and
	// wallet encryption — not all of these exist in stdlib (scrypt and
	// chacha20poly1305 remain x/crypto-only through Go 1.26). Bumped to
	// v0.54.0 for routine hygiene; its go directive (1.25) is what
	// prompted the toolchain line bump.
	golang.org/x/crypto v0.54.0
)

// golang.org/x/sys — direct since the wallet subcommands' termios
// handling and the TUI's TIOCGWINSZ/console-size detection
// (cmd/otedama/termecho_*.go, internal/tui/winsize*.go) use it; it was
// previously reachable only as an indirect dep of x/crypto.
require golang.org/x/sys v0.47.0
