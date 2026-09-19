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

**Relationship to `fix/ci-go124`:** that branch already bumps
`ci.yml`/`test.yml`/`release.yml` to 1.24.x (closes #8). This patch is
written against `master` and is a superset — it additionally covers what
that branch misses:

- `security.yml` and `ci-cd.yml` still pin Go 1.21/1.20 — untouched by
  `fix/ci-go124`, so those jobs stay red.
- `ci.yml`'s `build` matrix keeps a `1.22.x` leg on `fix/ci-go124`, but
  Go 1.22 cannot parse `godebug tlsmlkem=1` either — this patch drops it.
- `ci.yml` installs golangci-lint **v1.55.2**, which cannot analyse Go
  1.24 output (verified: `export data version 4 is greater than maximum
  supported version 2`). Bumped to **v1.64.8**, the last 1.x release and
  the newest that still accepts this repo's v1-format `.golangci.yml`.
- `test.yml`/`ci-cd.yml` pin `golangci/golangci-lint-action@v3` with
  `version: latest`; "latest" now resolves to golangci-lint v2.x, which
  rejects the v1 config. Bumped to `@v8` + `version: v1.64.8`.

Apply from the repo root:

```bash
git apply docs/patches/ci-go-1.24-bump.patch        # onto master, OR
git apply --3way docs/patches/ci-go-1.24-bump.patch # after fix/ci-go124 merges
```

**Expected follow-on:** once the lint job actually runs, it reports
~300 pre-existing findings on master (gocritic style/opinionated,
misspell UK/US leftovers, gosec G115, gocyclo, gofumpt). That debt is
already being handled on `fix/lint-error-severity`,
`fix/lint-mechanical`, and `fix/lint-config-master`; it predates this
patch and is not caused by it.

**Not in scope** (deliberate maintainer decisions, see §13): deleting or
rewriting `deploy.yml` (npm/k8s jobs on a Go repo with no `kubernetes/`),
`ci-cd.yml` (duplicate of `ci.yml`), `code-review.yml` (Node toolchain,
never reviews Go), the `security.yml` `tests/` legs (directory does not
exist), `ci.yml`'s `docker-verify*` jobs (nonexistent `scripts/`, wrong
`/health` path), `release.yml`'s `build-packages` job (nonexistent
`scripts/` + root `config.yaml`), and adding a fuzz job for
`internal/stratum`'s real fuzz targets.
