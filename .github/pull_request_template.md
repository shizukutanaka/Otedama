<!--
  Thank you for contributing to Otedama!

  Please fill out the sections below so reviewers can understand your change
  and verify it without excessive back-and-forth.
-->

## What does this PR do?

<!-- One or two sentences describing the change. Link to the issue it closes. -->

Closes #

## Why is this change needed?

<!-- The user-facing problem or internal motivation for this change. -->

## How was it tested?

<!-- List the tests you ran, or describe manual verification. -->

- [ ] `go test -race ./...`
- [ ] `go vet ./...`
- [ ] `golangci-lint run`
- [ ] `otedama doctor` on my development machine

## Checklist

- [ ] I read `CONTRIBUTING.md` and `CLAUDE.md`.
- [ ] Tests exist for any new code paths (TDD preferred; see `skills/tdd.md`).
- [ ] I updated `CHANGELOG.md` under the `[Unreleased]` section.
- [ ] I updated user-facing documentation (`README.md`, `docs/`) if needed.
- [ ] I did not introduce new external dependencies without discussion.
- [ ] I did not commit secrets, wallet files, or personally identifying data.
- [ ] My commits follow the Conventional Commits format (`feat:`, `fix:`, `refactor:`, ...).

## Legal compliance

- [ ] **SPDX header:** all newly-created `.go` files begin with the two-line
      `// SPDX-License-Identifier: Apache-2.0` header (see CONTRIBUTING.md).
- [ ] **DCO sign-off:** all commits include `Signed-off-by:` (use `git commit -s`).
- [ ] **AI-assisted code:** if AI tools (Copilot, Claude, etc.) helped write
      this code, I have reviewed and modified the output meaningfully and
      accept authorship responsibility per `CONTRIBUTING.md`.
- [ ] **Third-party code:** if any code is derived from external sources,
      its origin and original license are documented inline and (if
      required) in `NOTICE`.

## Screenshots / output (optional)

<!-- For UI or CLI changes, paste output or terminal recordings. -->

## Breaking changes

<!-- If this PR changes public API or CLI behavior, describe migration. -->

- [ ] None
- [ ] CLI flag added/removed/renamed: ...
- [ ] Configuration field added/removed/renamed: ...
- [ ] Exported Go API changed: ...
