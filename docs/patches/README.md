# Pending maintainer patches

This directory holds ready-to-apply fixes for files that the automation
working on this repository cannot push — `.github/workflows/*` is
outside the GitHub App's `workflow` scope, so CI fixes must be applied by
a maintainer with push access.

## ci-go-1.24-bump.patch

Fixes the CI Go-version mismatch documented in
`docs/KNOWN_LIMITATIONS.md` §13: every workflow pins Go ≤1.23 with
`GOTOOLCHAIN=local`, but `go.mod`'s `godebug tlsmlkem=1` (a Go 1.24 knob)
makes the module unparseable below Go 1.24, so every Go job fails at
`go mod download` before a single test runs.

The patch:

- Pins `GO_VERSION` / matrix / `setup-go` entries to `1.24.x` in
  `ci.yml`, `test.yml`, `release.yml`, `security.yml`, `ci-cd.yml`
  (matching `go.mod`'s `toolchain go1.24.0`).
- Bumps golangci-lint `v1.55.2` → `v1.64.8` in `ci.yml` (v1.55 cannot
  analyse Go 1.24 source).
- Bumps `golangci/golangci-lint-action` `v3` → `v8` and pins
  `version: v1.64.8` in `test.yml` and `ci-cd.yml` — `version: latest`
  resolves to golangci-lint v2.x, which rejects this repo's v1-format
  `.golangci.yml`.

Apply from the repo root:

```bash
git apply docs/patches/ci-go-1.24-bump.patch
git add .github/workflows && git commit -m "ci: pin Go 1.24.x and golangci-lint v1.64.8"
```

**Not in scope** (deliberate maintainer decisions, see §13): deleting or
rewriting `deploy.yml` (npm/k8s jobs on a Go repo with no `kubernetes/`),
`ci-cd.yml` (duplicate of `ci.yml`), `code-review.yml` (Node toolchain,
never reviews Go), the `security.yml` `tests/` legs (directory does not
exist), `ci.yml`'s `docker-verify*` jobs (nonexistent `scripts/`, wrong
`/health` path), `release.yml`'s `build-packages` job (nonexistent
`scripts/` + root `config.yaml`), and adding a fuzz job for
`internal/stratum`'s real fuzz targets.
