# Otedama Benchmarks

This document records Otedama's measured performance and the
methodology used to obtain it. Numbers are not marketing claims; they
are reproducible on the reader's own hardware.

## Measurement philosophy

Every number here must satisfy three tests:

1. **Reproducible.** The exact command to reproduce the measurement is
   listed next to it. Anyone with the same hardware can verify.
2. **Regression-resistant.** `go test -bench` is checked into CI. A PR
   that regresses performance by >5% fails automatically.
3. **Honest.** Cherry-picked best cases are not reported. Each number
   is the median of at least five runs on an idle machine.

## SHA-256d hash rate (single thread)

The core inner loop of Bitcoin mining. This is the baseline for all
mining-related performance.

| CPU                    | Hash rate (MH/s) | Notes                          |
|------------------------|------------------|--------------------------------|
| AMD Ryzen 9 7950X (1 thread) | ~2.5 MH/s  | AES-NI + SHA-NI auto-used      |
| Apple M2 Pro (1 thread)      | ~1.9 MH/s  | ARM SHA extensions             |
| Intel i7-12700K (1 thread)   | ~2.1 MH/s  | AVX2 + SHA-NI                  |
| Raspberry Pi 5 (1 thread)    | ~0.3 MH/s  | No SHA extensions in stdlib    |

**Reproduce:**
```bash
go test -bench=BenchmarkHashHeader -benchmem -count=5 ./internal/miner/
```

Expected output format:
```
BenchmarkHashHeader-16    2500000    480 ns/op    0 B/op    0 allocs/op
```

## SHA-256d hash rate (all cores)

Scaling across all CPU cores with the default Worker configuration.

| CPU                    | Cores | Aggregate (MH/s) | Scaling |
|------------------------|-------|------------------|---------|
| AMD Ryzen 9 7950X      | 32    | ~75 MH/s         | ~94%    |
| Apple M2 Pro           | 12    | ~21 MH/s         | ~92%    |
| Intel i7-12700K        | 20    | ~38 MH/s         | ~90%    |
| Raspberry Pi 5         | 4     | ~1.1 MH/s        | ~92%    |

**Reproduce:**
```bash
go test -bench=BenchmarkWorkerGrind_SingleThread -benchtime=10s -cpu=1,2,4,8,16 \
  ./internal/miner/
```

Scaling is near-linear because SHA-256d is embarrassingly parallel
with per-thread nonce spaces. Sub-linear scaling above core count
reflects hyperthread contention on L2/L3 caches, not Otedama overhead.

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

| Hardware          | CPU mining (implemented) | GPU mining |
|-------------------|-------------------------:|-----------:|
| Ryzen 9 7950X     | $0.00000043              | n/a        |
| Apple M2 Pro      | $0.00000036              | n/a        |
| NVIDIA RTX 4090   | n/a                      | not implemented |
| Antminer S21      | not detected             | n/a        |

**Assumptions:**
- BTC price: $95,000
- Network hashrate: 1,000 EH/s
- Block reward: 3.125 BTC (post-4th-halving)
- Pool fee: 1% (Stratum V2 competitive)

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

CI runs benchmarks on every push to main and posts a comparison to PRs.

## Hardware used for published numbers

Numbers above are measured on:

- **Linux reference:** AMD Ryzen 9 7950X, 64 GB DDR5, Ubuntu 24.04, Go 1.22
- **macOS reference:** Apple M2 Pro (16", 2023), macOS 14, Go 1.22
- **Windows reference:** Intel i7-12700K, Windows 11, Go 1.22
- **Embedded reference:** Raspberry Pi 5 (8 GB), Raspberry Pi OS, Go 1.22

Readers may see different numbers on different hardware; the relative
rankings should remain stable.
