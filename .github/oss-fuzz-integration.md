# OSS-Fuzz Integration

OSS-Fuzz is Google's free continuous fuzzing service for legitimate
open-source projects. Integration runs Otedama's `Fuzz*` test functions
on Google's infrastructure 24/7, automatically files private security
issues for crashes, and provides coverage reports.

This directory contains the artifacts needed to submit Otedama for
OSS-Fuzz inclusion. The actual integration requires a PR to
`github.com/google/oss-fuzz`, not to this repository.

## Status

**Not yet submitted.** This integration is ready when:

1. Otedama has a public release tag (v3.0.0 or later non-alpha).
2. The maintainer has 30 minutes to file the upstream PR.
3. At least three `Fuzz*` functions exist in the codebase (we have
   `FuzzDecodeHeader` and `FuzzDecoder_ReadFrame`; one more is needed
   — candidates: `FuzzBech32Decode`, `FuzzMnemonicParse`).

## Files prepared

When ready to submit, these files belong in `oss-fuzz/projects/otedama/`
in the OSS-Fuzz repository (not in Otedama's own repo):

### `project.yaml`

```yaml
homepage: "https://github.com/shizukutanaka/Otedama"
language: go
primary_contact: "monu@example.com"
auto_ccs:
  - "monu@example.com"
sanitizers:
  - address
fuzzing_engines:
  - libfuzzer
main_repo: "https://github.com/shizukutanaka/Otedama"
file_github_issue: true
```

### `Dockerfile`

```dockerfile
FROM gcr.io/oss-fuzz-base/base-builder-go

RUN git clone --depth 1 https://github.com/shizukutanaka/Otedama otedama
WORKDIR otedama
COPY build.sh $SRC/
```

### `build.sh`

```bash
#!/bin/bash -eu

# OSS-Fuzz expects fuzz binaries written to $OUT.
# We discover all FuzzXxx tests under internal/ and compile each.

cd $SRC/otedama

# go-fuzz-build is provided by the base-builder-go image.
compile_native_go_fuzzer() {
  local pkg=$1
  local fn=$2
  local out=$3

  go-118-fuzz-build -o "${out}.a" -func "${fn}" "${pkg}"
  $CXX $CXXFLAGS $LIB_FUZZING_ENGINE "${out}.a" -o "${OUT}/${out}"
}

compile_native_go_fuzzer ./internal/stratum FuzzDecodeHeader fuzz_decode_header
compile_native_go_fuzzer ./internal/stratum FuzzDecoder_ReadFrame fuzz_decoder_read_frame
# Add more as fuzz tests are written.
```

## What OSS-Fuzz provides

- **24/7 fuzzing** on Google's compute (free).
- **Coverage reports** at https://oss-fuzz-coverage.storage.googleapis.com/
- **Issue filing** with private 90-day disclosure window.
- **Reproducer binaries** for every crash.
- **Bug bounties** (~$500–$5000 per accepted vulnerability via the
  Open Source Security Foundation rewards program, when applicable).

## Maintainer commitment

Once accepted, OSS-Fuzz expects:

- Bug fixes within 90 days of report (otherwise the report becomes
  public).
- Build script kept working (broken builds are auto-disabled after
  ~30 days).
- ~1 hour/month of triage on average.

This is consistent with Otedama's 10-hour/week sustainability cap.

## Submission procedure

When ready:

1. Fork `github.com/google/oss-fuzz`.
2. Create `projects/otedama/` with the three files above.
3. Verify locally:
   ```bash
   python infra/helper.py build_image otedama
   python infra/helper.py build_fuzzers otedama
   python infra/helper.py run_fuzzer otedama fuzz_decode_header
   ```
4. Open a PR to upstream OSS-Fuzz titled "Add Otedama".
5. Address review feedback (typically 1-2 round-trips).
6. Once merged, OSS-Fuzz starts running within 24 hours.

## References

- https://google.github.io/oss-fuzz/
- https://google.github.io/oss-fuzz/getting-started/new-project-guide/go-lang/
- Existing Go projects on OSS-Fuzz: protobuf-go, gnark-crypto, etcd
