# ADR-003: Zero runtime dependencies beyond stdlib + x/crypto + yaml

**Status:** Accepted
**Date:** 2026-04-15

## Context

In 2026, the typical Go project has 30-100 transitive dependencies.
Each is a potential supply-chain attack vector.

Recent high-impact incidents:

- **March 2025, tj-actions/changed-files**: Malicious commit to a
  widely-used GitHub Action leaked secrets from thousands of CI
  pipelines.
- **October 2024, XZ-utils backdoor**: A multi-year social engineering
  campaign inserted a backdoor into a core Unix library. Nearly
  affected every Linux distribution.
- **Ongoing, event-stream / ua-parser-js / coa / rc**: npm ecosystem
  compromises through maintainer handoffs.

Otedama touches user Bitcoin wallets. A single compromised dependency
could exfiltrate seeds or redirect earnings. The cost of dependency
compromise is catastrophic and irreversible.

## Decision

**Otedama ships with exactly three external runtime dependencies:**

1. `golang.org/x/crypto` — for ChaCha20-Poly1305, scrypt, and ECDH.
   These primitives are not in stdlib. Maintained by the Go team.
2. `gopkg.in/yaml.v3` — for config parsing. Maintained by go-yaml
   project, stable since 2020.
3. *(implicit)* The Go standard library.

**Amendment (ADR-011, 2026-06-02):** a fourth runtime dependency,
`github.com/decred/dcrd/dcrec/secp256k1/v4`, is permitted, scoped to the
Stratum V2 Noise handshake. The Stratum V2 spec mandates secp256k1 +
ElligatorSwift, which is absent from stdlib and `x/crypto`. Implementing
this curve ourselves would be the most security-sensitive code in the
project and would *raise* the supply-chain/compromise risk that this ADR
exists to minimise — so adopting the canonical, pure-Go, ISC-licensed
implementation is consistent with this ADR's intent (it "removes ongoing
maintenance burden" of exactly the kind we should not carry). See ADR-011
for the full rationale, options considered, and supply-chain mitigations.

No HTTP client framework. No CLI framework (no cobra/urfave/kingpin).
No logging framework (slog is stdlib). No test framework (stdlib
testing is sufficient). No ORM (we don't have a database). No Prometheus
client library (we emit the exposition format directly).

This constraint applies to **runtime** dependencies. Build-time and
test-time tools (goreleaser, staticcheck, golangci-lint, govulncheck,
gosec) are permitted because they do not ship in the binary.

## Consequences

### Positive

- **Attack surface is minimised.** Compromising Otedama's supply chain
  requires compromising either Go itself or one of three audited
  dependencies.
- **Binary size stays small.** The current release binary is ~15MB,
  most of which is Go's own runtime. A dependency-heavy equivalent
  would easily exceed 40MB.
- **Build time stays fast.** Cold `go build` completes in <15s.
- **Upgrade burden stays low.** `go mod tidy` has little to do.
- **No vendor surprises.** We never wake up to "our vendor changed
  their API" or "our vendor went paid."

### Negative

- **Some features take longer to implement.** We wrote our own
  Prometheus exposition code, TUI rendering, CLI flag parsing,
  and HTTP health endpoints. Each is 100-500 lines; each would
  have been "free" with a dependency.
- **Code ownership is higher.** We own every line we ship. Bugs in
  our Prometheus serializer are ours to fix; we cannot file issues
  upstream.

### Neutral

- **Community PRs that introduce dependencies face scrutiny.**
  `CLAUDE.md` documents this rule. Contributors sometimes propose
  replacing our custom code with a library; we decline unless the
  dependency removes ongoing maintenance burden (which is rare).

## Alternatives Considered

### Use `prometheus/client_golang`

*Rejected.* Adds ~15 transitive dependencies and ~8MB to the binary
for metric types we do not use (summaries, exemplars). Our custom
~300-line implementation handles counters and gauges, which is all
we export.

### Use `cobra` for CLI

*Rejected.* stdlib `flag` is sufficient. The subcommand dispatch in
`cmd/otedama/main.go` is 30 lines of switch/case. Cobra would add
5 MB and make the help text less terse.

### Use `zerolog` or `zap` for logging

*Rejected.* `log/slog` (added in Go 1.21) covers our needs: JSON
output, level filtering, structured attributes. No external dep.

### Allow "small, obvious" dependencies per-case

*Rejected.* Every dependency eventually becomes unmaintained,
malicious, or larger. A strict rule is simpler than case-by-case
judgement.

## Erratum (added session 251, does not alter the accepted decision)

Per `docs/adr/README.md`'s immutability rule, the text above stands, but
one fact in the dependency rationale (list item 2: "`gopkg.in/yaml.v3` —
Maintained by go-yaml project, stable since 2020") is now out of date and
needs a correction pointer rather than a silent edit.

The `go-yaml/yaml` source repository was **archived by its author on
2025-04-01** and is now unmaintained. The YAML organization took over as
the successor at import path **`go.yaml.in/yaml`**, where **v1/v2/v3 are
frozen to security-fixes-only** and active development is in **v4**
(`go.yaml.in/yaml/v4`). Sources: github.com/go-yaml/yaml,
github.com/yaml/go-yaml, pkg.go.dev/go.yaml.in/yaml/v4.

Consequence for policy: this dependency now **fails CLAUDE.md's own
§外部依存 criterion 3** ("meaningful maintenance activity within the last
year"). No CVE against `v3.0.1` was found — the concern is maintenance
status, not an active vulnerability. **Recommended action (deferred to a
change that can fetch modules):** migrate to the near-drop-in,
YAML-org-maintained `go.yaml.in/yaml/v3` and record the selection
rationale in `go.mod`. Migration was scoped but not performed in session
251 because this environment's module proxy denies the checksum-database
lookup (`sum.golang.org` returns Forbidden), so `go get` cannot verify the
new module here; tracked in RESEARCH_IMPROVEMENTS session-251 item 1.

## Related

- ADR-001 — Non-custodial wallet model
- CLAUDE.md § "Permitted dependencies"
- `go.mod` — enforces this decision mechanically
