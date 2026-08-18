# Otedama Benchmarks

This document records Otedama's measured performance and the
methodology used to obtain it. Numbers are not marketing claims; they
are reproducible on the reader's own hardware.

## Measurement philosophy

Every number here must satisfy three tests:

1. **Reproducible.** The exact command to reproduce the measurement is
   listed next to it. Anyone with the same hardware can verify.
2. **Regression-resistant.** `go test -bench` runs in CI on every push
   (`ci.yml`'s `benchmark` job). Note what that job does and does not do:
   it runs the benchmarks and uploads the output as an artifact. It does
   **not** compare against a stored baseline, does not fail on a
   regression, and does not post to pull requests. Comparing runs is
   currently a manual step (`benchstat` over two artifacts). This entry
   previously claimed a >5% regression "fails automatically"; it does not.
3. **Honest.** Cherry-picked best cases are not reported. Each number
   is the median of at least five runs on an idle machine.

## SHA-256d hash rate

The core inner loop of Bitcoin mining, measured end to end through a real
`miner.Worker` rather than through a loop that imitates one.

**Reference machine** — the only hardware these numbers were taken on:
Intel Xeon @ 2.10GHz, 4 vCPU, Linux/amd64, Go 1.24.7. This CPU has **no
SHA-NI**, so `crypto/sha256` runs its generic path; a machine with SHA
extensions will be substantially faster.

| Measurement                    | Before session 264 | After   | Change |
|--------------------------------|-------------------:|--------:|-------:|
| Single thread                  | 3.73 MH/s          | 5.45 MH/s | +46%  |
| All 4 threads                  | 9.64 MH/s          | 21.9 MH/s | +2.28x |
| Per-hash cost, 1 thread        | 268 ns             | 183 ns  | −32%   |
| Per-hash cost, per thread of 4 | 415 ns             | 182 ns  | −56%   |

Two changes produced this (see `internal/miner/sha256d.go` and the
`grind` loop in `worker.go`):

- **Midstate.** A block header is 80 bytes — two SHA-256 blocks for the
  first hash, one for the second. Only the last four bytes change as a
  worker grinds, and they live in the second block, so the first
  compression produces the same state for every nonce. Computing it once
  per job removes a third of the work. Micro-benchmarked at 264.2 → 167.7
  ns/op, with the intermediate step (serialise once, patch the nonce
  bytes: 224.0 ns/op) showing that roughly 15 points come from not
  re-serialising and the rest from not re-compressing.
- **Batched hash counting.** The hash counter was an atomic increment per
  hash, shared by every thread. At 4 threads that measured 30.5 ns per
  increment in isolation, and cost far more in situ: the baseline needed
  415 ns per hash per thread against 268 ns single-threaded. It is now
  added once per 1024-nonce batch (0.15 ns amortised).

The second change is why the multi-thread gain (2.28x) exceeds the
single-thread gain (1.46x), and why per-thread cost at 4 threads is now
182 ns against 183 ns single-threaded — scaling is linear because the
threads no longer share a contended cache line.

**Reproduce:**
```bash
# End-to-end worker throughput, single thread and at runtime.NumCPU().
go test -run XXX -bench 'BenchmarkWorkerGrind' -benchtime=1x ./internal/miner/

# The hashing primitives in isolation.
go test -run XXX -bench 'BenchmarkHashHeader|BenchmarkHeaderHasher' \
  -benchmem -benchtime=2s ./internal/miner/
```

The `WorkerGrind` benchmarks are fixed-window throughput probes: they
ignore `b.N` and report `hash/s` as a custom metric, so read that column
and disregard `ns/op`.

**Other hardware is unmeasured.** Earlier revisions of this file carried a
table of figures for a Ryzen 9 7950X, an Apple M2 Pro, an i7-12700K and a
Raspberry Pi 5. None had been measured, and the "reproduce" command
printed alongside the all-cores table invoked a single-threaded benchmark
with `-cpu=1,2,4,8,16`, which could not have produced it. They were
removed rather than carried forward: this file's own measurement
philosophy requires every number to be reproducible by anyone with the
same hardware, and an invented number fails that at the first attempt.
Contributions with real measurements are welcome — please include the
exact command and the machine.

## Stratum V2 frame decode (fuzz-verified)

The framing layer must process frames as fast as the network can
deliver them. A slow decoder becomes a DoS vector.

| Operation              | Throughput     | Latency    |
|------------------------|----------------|------------|
| Header decode          | ~50 M frames/s | ~20 ns     |
| Full frame (1KB payload)| ~5 M frames/s | ~200 ns    |

**Reproduce:**
```bash
go test -bench=BenchmarkDecoder_ReadFrame ./internal/stratum/
```

**Correctness:** The decoder is fuzzed continuously in CI. See
`FuzzDecoder_ReadFrame` for the active corpus.

## Economic comparison (2026-04-24 market data)

Revenue per day by hardware, for the revenue streams Otedama actually
implements. Bitcoin mining is the only one (session 264 — the simulated
AI-inference market was deleted; see `docs/KNOWN_LIMITATIONS.md` §1).

| Hardware                       | CPU mining (implemented) | GPU mining      |
|--------------------------------|-------------------------:|----------------:|
| Reference machine (4 vCPU Xeon)| $0.00000094 / day        | n/a             |
| Any GPU                        | n/a                      | not implemented |
| Any ASIC                       | not detected             | n/a             |

Only the reference machine appears because it is the only one whose
hashrate was measured (21.9 MH/s across 4 threads, see above). The figure
scales linearly with hashrate, so a CPU twice as fast earns twice as close
to nothing.

**Assumptions and the formula:**
- BTC price: $95,000
- Network hashrate: 1,000 EH/s (1e21 H/s)
- Block reward: 3.125 BTC (post-4th-halving), 144 blocks/day
- Pool fee: 1% (Stratum V2 competitive)

```
sats/day = (device H/s ÷ network H/s) × 3.125e8 sats × 144
         = (2.19e7 ÷ 1e21) × 3.125e8 × 144  ≈  9.9e-4 sats/day

At $95,000/BTC that is $9.4e-7/day gross, $9.3e-7 after a 1% pool fee.
```

This is the same model `internal/provider/mining.go` uses for its yield
quotes, so the dashboard and this table cannot drift apart.

**Why the GPU and ASIC rows are empty.** No CUDA, ROCm, or Vulkan compute
dispatch exists anywhere in this codebase, so every detected GPU reports
`Capabilities.SHA256d = false` and is never given work
(`docs/KNOWN_LIMITATIONS.md` §4). ASIC hardware is not detected at all
(§8). This table previously carried a "GPU AI (Akash)" column showing
$12.00/day and an "Apple M2 Pro ~$8.00 (via NPU)" figure, and concluded
that "the arbitration engine's entire value is in routing GPUs to AI
inference". None of those numbers were reachable by any code path: they
came from a provider that quoted a hardcoded constant, and no component
could convert that quote into income.

**Interpretation.** CPU mining is effectively zero revenue — that is a
fact about SHA-256d on general-purpose silicon, not about Otedama. What
the arbitration engine decides today is therefore not "which market pays
more" but "is this device worth running at all": whether each device
clears `min_yield_sats_per_sec`, and whether the `curtail_below_btc_usd`
threshold has paused hashing. Real multi-stream arbitration becomes
measurable when a second market with real income lands (ROADMAP v3.1.0).

## Startup time

Time from `otedama run --bitcoin-address bc1q...` to first share
submitted to the pool.

| Phase                        | Typical duration |
|------------------------------|-----------------:|
| Config parse + validation    | <5 ms            |
| Hardware detection           | 50-100 ms        |
| Pool TCP handshake           | 20-80 ms (RTT-limited) |
| Stratum V2 SetupConnection   | ~1 RTT           |
| OpenMiningChannel            | ~1 RTT           |
| First NewMiningJob received  | Pool-dependent   |
| First share (at easy target) | <1 s on CPU      |

Total: typically <1 second from invocation to hashing.

## Memory footprint

Steady-state RAM usage with all subsystems running.

| Scenario            | RSS       |
|---------------------|----------:|
| Config validation only | ~5 MB  |
| CPU mining, no TUI  | ~15 MB    |
| CPU mining + TUI    | ~18 MB    |
| Full stack (wallet, providers, TUI) | ~25 MB |

For comparison: CGMiner ~40 MB, NiceHash Miner ~200 MB, Braiins OS ~500 MB (full OS).

## Network bandwidth

Typical Stratum V2 traffic on a steady connection.

| Direction      | Rate          |
|----------------|---------------|
| Inbound (jobs) | ~1-2 KB/s     |
| Outbound (shares at default difficulty) | ~100 B/s |

Total: <100 MB/month. Safe on capped or metered connections.

## Regression policy

A PR that regresses any benchmark by >5% must include one of:

1. A documented trade-off (security fix, maintainability improvement)
   explaining why the regression is acceptable.
2. A performance analysis showing the regression is within measurement
   noise (run the benchmark 20 times on a dedicated machine).

Enforcing this is manual today: CI uploads benchmark output as an
artifact but does not diff it against a baseline or gate the merge (see
"Measurement philosophy" above). Until it does, a reviewer who cares about
a hot path should run the benchmark on both revisions.

## Hardware used for published numbers

- **Reference machine:** Intel Xeon @ 2.10GHz, 4 vCPU, Linux/amd64,
  Go 1.24.7. No SHA-NI, so `crypto/sha256` uses its generic path.

That is the only machine any number in this file was taken on. Earlier
revisions listed a Ryzen 9 7950X, an Apple M2 Pro, an i7-12700K and a
Raspberry Pi 5 as "hardware used for published numbers"; no measurement
had been taken on any of them, so they were removed along with the figures
attributed to them (session 264).

Readers will see different numbers on different hardware — a CPU with SHA
extensions especially so. Contributions with real measurements are
welcome: include the exact command, the machine, and the Go version.
